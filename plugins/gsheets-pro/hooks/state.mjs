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

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));

/** The plugin's own root, derived from this file rather than from an env var. */
export const PLUGIN_ROOT = join(HOOK_DIR, "..");

export const CARD_PATH = join(PLUGIN_ROOT, "skills/gsheets-pro/CARD.md");

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
  try {
    return readFileSync(CARD_PATH, "utf8").replace(/^<!--[\s\S]*?-->\s*/, "").trim();
  } catch {
    return null;
  }
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

/** The registry entry for whichever spreadsheet a tool call names, if any. */
export function registryEntryFor(registry, toolInput) {
  const id = toolInput?.spreadsheet_id ?? toolInput?.spreadsheetId ?? toolInput?.id;
  if (!id) return null;
  const entry = registry[id];
  return entry ? { id, ...entry } : null;
}

/** Emit a hook result and exit cleanly. Silence is a valid result. */
export function emit(payload) {
  if (payload) process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}
