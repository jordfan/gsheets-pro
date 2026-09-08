#!/usr/bin/env node
// Copy the gsheets-pro guide, hooks, and presets into a repository's .claude
// directory, and register the hooks in its settings.json.
//
// Why this exists: a plugin declared in a repository's .claude/settings.json
// does not install in a scheduled cloud run. The marketplace is never cloned,
// the plugin list comes back empty, and the skill is unknown. Repository hooks
// and skills in .claude/ do load. So for a repository whose scheduled runs
// touch spreadsheets, vendoring is the way to get the rules there. See
// docs/cloud.md.
//
//   node scripts/vendor.mjs <repo-dir>
//   node scripts/vendor.mjs <repo-dir> --dry-run
//
// Idempotent. Re-running replaces what a previous run wrote and leaves
// everything else in the repository alone, including hooks somebody else
// added.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = join(ROOT, "plugins/gsheets-pro");

// Every hook command this script writes contains this path fragment. It is the
// marker that makes re-running idempotent: entries containing it are ours to
// replace, entries that do not are somebody else's to leave alone.
const MARKER = ".claude/hooks/gsheets-pro/";

const HOOK_EVENTS = {
  SessionStart: {
    matcher: "startup|resume|clear|compact",
    entries: [{ script: "session-start.mjs" }],
  },
  PreToolUse: {
    matcher: "mcp__.*__sheets_[a-z_]+$",
    entries: [
      { script: "first-call.mjs", statusMessage: "Loading the gsheets-pro house rules" },
      { script: "guard.mjs", statusMessage: "Checking the spreadsheet registry" },
    ],
  },
  PostToolUse: {
    matcher: "mcp__.*__sheets_[a-z_]+$",
    entries: [{ script: "after-write.mjs" }],
  },
};

const command = (script) => `node "$CLAUDE_PROJECT_DIR/${MARKER}${script}"`;

function fail(message) {
  process.stderr.write(`vendor.mjs: ${message}\n`);
  process.exit(1);
}

/**
 * Strip every hook entry this script previously wrote, then drop any matcher
 * group left with nothing in it. Groups holding a mix of ours and somebody
 * else's keep theirs.
 */
function stripOurs(hooks) {
  const out = {};
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    if (!Array.isArray(groups)) {
      out[event] = groups;
      continue;
    }
    const kept = groups
      .map((group) => ({
        ...group,
        hooks: (group.hooks ?? []).filter(
          (hook) => !(typeof hook?.command === "string" && hook.command.includes(MARKER)),
        ),
      }))
      .filter((group) => (group.hooks ?? []).length > 0);
    if (kept.length > 0) out[event] = kept;
  }
  return out;
}

function addOurs(hooks) {
  const out = { ...hooks };
  for (const [event, spec] of Object.entries(HOOK_EVENTS)) {
    const group = {
      matcher: spec.matcher,
      hooks: spec.entries.map((entry) => ({
        type: "command",
        command: command(entry.script),
        timeout: 10,
        ...(entry.statusMessage ? { statusMessage: entry.statusMessage } : {}),
      })),
    };
    out[event] = [...(out[event] ?? []), group];
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const target = args.find((arg) => !arg.startsWith("-"));

  if (!target) fail("usage: node scripts/vendor.mjs <repo-dir> [--dry-run]");

  const repo = resolve(target);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    fail(`${repo} is not a directory.`);
  }

  const cardPath = join(PLUGIN, "skills/gsheets-pro/CARD.md");
  if (!existsSync(cardPath)) {
    fail("CARD.md is missing. Run: node scripts/card.mjs");
  }

  const claude = join(repo, ".claude");
  const copies = [
    {
      what: "the guide, references, examples, and the card",
      from: join(PLUGIN, "skills/gsheets-pro"),
      to: join(claude, "skills/gsheets-pro"),
    },
    {
      what: "the four hooks and their shared helper",
      from: join(PLUGIN, "hooks"),
      to: join(claude, "hooks/gsheets-pro"),
      // hooks.json is the plugin's own registration. In a vendored layout the
      // entries live in the repository's settings.json instead, so copying it
      // would leave a file that looks authoritative and is not.
      skip: ["hooks.json"],
    },
    {
      what: "the style presets",
      from: join(PLUGIN, "presets"),
      to: join(claude, "gsheets-pro/presets"),
    },
  ];

  const settingsPath = join(claude, "settings.json");
  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch (error) {
      fail(`${settingsPath} is not valid JSON, so it will not be edited. ${error.message}`);
    }
  }
  const nextSettings = { ...settings, hooks: addOurs(stripOurs(settings.hooks)) };

  if (dryRun) {
    process.stdout.write("Would copy:\n");
    for (const copy of copies) {
      process.stdout.write(`  ${copy.to.replace(repo, ".")}   ${copy.what}\n`);
    }
    process.stdout.write(
      `\nWould write ${settingsPath.replace(repo, ".")} with these hooks:\n` +
        `${JSON.stringify(nextSettings.hooks, null, 2)}\n`,
    );
    return;
  }

  for (const copy of copies) {
    rmSync(copy.to, { recursive: true, force: true });
    mkdirSync(dirname(copy.to), { recursive: true });
    cpSync(copy.from, copy.to, {
      recursive: true,
      filter: (src) => !(copy.skip ?? []).some((name) => src.endsWith(`/${name}`)),
    });
    process.stdout.write(`copied  ${copy.to.replace(repo, ".")}\n`);
  }

  writeFileSync(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf8");
  process.stdout.write(`updated ${settingsPath.replace(repo, ".")}\n`);

  const registry = join(claude, "gsheets-pro.json");
  process.stdout.write(
    "\nDone. Two things worth doing next:\n" +
      (existsSync(registry)
        ? "  The registry at .claude/gsheets-pro.json is already here, so protected spreadsheets are known.\n"
        : "  Add .claude/gsheets-pro.json listing the spreadsheets other people own, so writes into their\n" +
          "  columns are refused, and mark any reference sheet read_only so nothing writes to it at all.\n" +
          "  references/existing-sheets.md has the shape.\n") +
      "  Commit .claude/. A scheduled run gets a fresh clone, so anything uncommitted is not there.\n" +
      "\nThe reviewer agent and the setup and review skills stay plugin-only. They are for\n" +
      "interactive work, and a scheduled run has no use for them.\n",
  );
}

main();
