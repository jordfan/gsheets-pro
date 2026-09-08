// Shared helpers for the four gsheets-pro hooks. Dependency free, Node ESM.
//
// Two jobs: keep a small per-session state file so the card is injected once
// rather than on every call, and read the repository registry so a hook can
// name the spreadsheet it is protecting.
//
// Every function here fails soft. A hook that throws would surface as a hook
// error on an ordinary spreadsheet call, which is worse than the hook simply
// not doing its job. Where a failure forces a choice, these helpers choose the
// safe side: an unreadable state file means "the card has not been injected",
// so it gets injected again, which costs tokens but never leaves the model
// working without the rules.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));

// These hooks run from two different layouts, so nothing here reads
// ${CLAUDE_PLUGIN_ROOT}. Everything resolves relative to this file.
//
//   installed as a plugin   <plugin>/hooks/            card at ../skills/gsheets-pro/CARD.md
//   vendored into a repo    <repo>/.claude/hooks/gsheets-pro/   card at ../../skills/gsheets-pro/CARD.md
//
// Vendoring exists because a plugin declared in a repository's
// .claude/settings.json does not install in a scheduled cloud run, while
// repository hooks and skills load normally. scripts/vendor.mjs writes the
// second layout. See docs/cloud.md.
const firstExisting = (candidates) => candidates.find((path) => existsSync(path)) ?? null;

export const CARD_PATH = firstExisting([
  join(HOOK_DIR, "..", "skills", "gsheets-pro", "CARD.md"),
  join(HOOK_DIR, "..", "..", "skills", "gsheets-pro", "CARD.md"),
]);

export const PRESETS_DIR = firstExisting([
  join(HOOK_DIR, "..", "presets"),
  join(HOOK_DIR, "..", "..", "gsheets-pro", "presets"),
]);

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Where session state lives, in the order the plan specifies:
 * the directory Claude Code hands the plugin, then the documented default for
 * that directory, then the system temp directory. Returns null if none of them
 * can be created, and callers treat that as "no state".
 */
export function stateDir() {
  const candidates = [
    process.env.CLAUDE_PLUGIN_DATA,
    join(homedir(), ".claude", "plugins", "data", "gsheets-pro"),
    join(tmpdir(), "gsheets-pro"),
  ].filter(Boolean);

  for (const base of candidates) {
    try {
      const dir = join(base, "sessions");
      mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

// Session ids come from the harness, but they end up in a file path, so they
// are constrained here rather than trusted.
const safeId = (id) => String(id ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128);

function sessionPath(sessionId) {
  const dir = stateDir();
  const id = safeId(sessionId);
  if (!dir || !id) return null;
  return join(dir, `${id}.json`);
}

export function readState(sessionId) {
  const path = sessionPath(sessionId);
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Merge `patch` into the session state.
 * Returns true when the state was persisted, false when it was not. A false
 * return is what tells a caller it cannot rely on "already done" bookkeeping.
 */
export function writeState(sessionId, patch) {
  const path = sessionPath(sessionId);
  if (!path) return false;
  try {
    const next = { ...readState(sessionId), ...patch, updated_at: Date.now() };
    writeFileSync(path, JSON.stringify(next), "utf8");
    pruneOldSessions(dirname(path));
    return true;
  } catch {
    return false;
  }
}

function pruneOldSessions(dir) {
  try {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      try {
        if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
      } catch {
        // A file that vanished under us needs no cleanup.
      }
    }
  } catch {
    // Pruning is housekeeping. Never let it fail a hook.
  }
}

/** Read the hook's stdin payload. Returns {} on anything unparseable. */
export async function readInput() {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function readCard() {
  if (!CARD_PATH) return null;
  try {
    return readFileSync(CARD_PATH, "utf8").replace(/^<!--[\s\S]*?-->\s*/, "").trim();
  } catch {
    return null;
  }
}

/**
 * Whether this run has nobody at the keyboard.
 *
 * Verified in the cloud smoke test: `permission_mode` cannot answer this. A
 * scheduled routine reported `permission_mode: "default"`, so a PreToolUse
 * `ask` produced a permission prompt with nobody to answer it and the run
 * stalled until it timed out. The environment does answer it.
 *
 * Three signals, any one of which is enough:
 *
 *   permission_mode          bypassPermissions or dontAsk. Prompts are
 *                            suppressed or auto-answered, so an ask is either
 *                            ignored or waved through.
 *   CLAUDE_CODE_ENTRYPOINT   "remote_trigger" is a routine firing on a
 *                            schedule. A human-started cloud session has a
 *                            different entrypoint, and still gets `ask`,
 *                            because somebody is watching it.
 *   CLAUDE_CODE_HOLD_UNANSWERED_PARKED_PERMISSION
 *                            set by the harness in exactly the runs where an
 *                            unanswered prompt parks rather than resolving.
 *
 * CLAUDE_CODE_REMOTE is deliberately not a signal. It is true for interactive
 * cloud sessions too, and denying those would block a person who is right
 * there and able to decide.
 */
export function isUnattended(input) {
  if (["bypassPermissions", "dontAsk"].includes(input?.permission_mode)) return true;
  if (process.env.CLAUDE_CODE_ENTRYPOINT === "remote_trigger") return true;
  if (process.env.CLAUDE_CODE_HOLD_UNANSWERED_PARKED_PERMISSION) return true;
  return false;
}

/**
 * The tool suffix, with whichever `mcp__...__` prefix this session's transport
 * produced stripped off. Returns null for a tool that is not one of ours.
 */
export function sheetsTool(toolName) {
  const match = /(?:^|__)(sheets_[a-z_]+)$/.exec(String(toolName ?? ""));
  return match ? match[1] : null;
}

/**
 * The repository registry, which marks known spreadsheets as human owned,
 * shared, or agent owned. Accepts either an object keyed by spreadsheet id or
 * an array of entries carrying an `id`.
 */
export function readRegistry(cwd) {
  if (!cwd) return {};
  try {
    const raw = JSON.parse(readFileSync(join(cwd, ".claude", "gsheets-pro.json"), "utf8"));
    const source = raw?.spreadsheets ?? raw;
    if (Array.isArray(source)) {
      return Object.fromEntries(source.filter((e) => e?.id).map((e) => [e.id, e]));
    }
    if (source && typeof source === "object") return source;
    return {};
  } catch {
    return {};
  }
}

/**
 * The registry entry for whichever spreadsheet a tool call names, if any.
 *
 * A per-tab entry under `sheets` is merged over the spreadsheet's own, most
 * specific wins, the same order the server resolves. That matters for
 * `read_only`: a workbook is often perfectly writable except for one finished
 * historical tab, and the hook has to see that tab's rule rather than the
 * workbook's silence.
 */
export function registryEntryFor(registry, toolInput) {
  const id = toolInput?.spreadsheet_id ?? toolInput?.spreadsheetId ?? toolInput?.id;
  if (!id) return null;
  const entry = registry[id];
  if (!entry) return null;

  const wanted = String(toolInput?.sheet ?? "").trim().toLowerCase();
  let perSheet = null;
  if (wanted && entry.sheets && typeof entry.sheets === "object") {
    for (const [name, policy] of Object.entries(entry.sheets)) {
      if (String(name).trim().toLowerCase() === wanted) {
        perSheet = policy;
        break;
      }
    }
  }
  return { id, ...entry, ...(perSheet ?? {}) };
}

/** Emit a hook result and exit cleanly. Silence is a valid result. */
export function emit(payload) {
  if (payload) process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}
