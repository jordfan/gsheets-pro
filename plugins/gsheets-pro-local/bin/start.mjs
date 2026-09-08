#!/usr/bin/env node
/**
 * Bootstrap for gsheets-pro-local.
 *
 * `.mcp.json` used to point straight at `${CLAUDE_PLUGIN_ROOT}/../../dist/cli.js`,
 * on the theory that `${CLAUDE_PLUGIN_ROOT}` sits inside a full checkout of
 * this repository, two levels below its root, the way a local `--plugin-dir`
 * install does. A real `claude plugin marketplace add` install is not that.
 * Claude Code materializes only this plugin's own subtree, this directory and
 * its neighbors, into `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`.
 * There is no src/, no package.json, no repository root within reach by any
 * relative path from there: `${CLAUDE_PLUGIN_ROOT}/../..` lands two levels up
 * inside Claude Code's own cache directory, nowhere near this repository.
 * Confirmed with `claude mcp list` against a real install: it showed the
 * server command resolved to exactly that nonexistent path.
 *
 * So there is nothing to build in place. Instead this script has npm fetch
 * and build the server the same way any git dependency is fetched and built:
 * `npm install <git spec>` clones the repository, installs its
 * devDependencies, runs its "prepare" script (scripts/prepare.mjs, which runs
 * `npm run build`), and then packs only what package.json's "files" list
 * names (dist/, README, LICENSE, NOTICE) into the target directory — no
 * TypeScript toolchain left behind, no source tree, just a built package with
 * its runtime dependencies. The spec is pinned to this plugin's own version,
 * `#v<version>` from `.claude-plugin/plugin.json`, when that tag exists on
 * the repository (`tagExists`, one `git ls-remote`, not a clone), falling
 * back to the default branch, with a one-line note on stderr, when it does
 * not: this repository has not cut a release yet, so today every install
 * takes that fallback, and the pin starts doing something the day it does.
 *
 * The install goes into `${CLAUDE_PLUGIN_DATA}`, which Claude Code gives every
 * plugin a persistent, writable directory for, keyed by this plugin's own
 * version (from .claude-plugin/plugin.json). That keying is what makes a
 * repeat start free: as long as the version has not changed, the built server
 * from last time is still sitting there and this script execs it directly
 * with no network call and no npm at all. A version bump gets a fresh
 * directory and, implicitly, a fresh install, the same way Claude Code's own
 * plugin cache treats a version bump as a new place to materialize into.
 *
 * stdout is the MCP stdio channel the moment the real server starts, and
 * npm's own install/build chatter is not meant for it either, so every status
 * line here goes to stderr, and only when there is something to report: a
 * repeat start, the common case after the first one, prints nothing at all.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");
const REPO_URL = "https://github.com/jordfan/gsheets-pro.git";
const REPO_GIT_SPEC = `git+${REPO_URL}`;

function status(message) {
  process.stderr.write(`gsheets-pro-local: ${message}\n`);
}

function pluginVersion() {
  try {
    const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
    if (typeof manifest.version === "string" && manifest.version) return manifest.version;
  } catch {
    // Fall through to the default below. A missing or unreadable manifest
    // still gets a working install, just without version-keyed caching.
  }
  return "unknown";
}

// CLAUDE_PLUGIN_DATA is documented as a per-plugin, persistent, writable
// directory. Falling back to a directory next to this script keeps a manual
// (non-plugin) install working too, for local development of this repo.
const dataDir = process.env.CLAUDE_PLUGIN_DATA ?? join(PLUGIN_ROOT, ".gsheets-pro-data");
const installDir = join(dataDir, "server", pluginVersion());
const CLI = join(installDir, "node_modules", "gsheets-pro", "dist", "cli.js");

/**
 * Whether tag `v<version>` exists on the repository, checked with a plain
 * `git ls-remote`, one ref lookup, not a clone. This is what lets the install
 * below pin to the exact commit that shipped this copy of the plugin instead
 * of always tracking the default branch's moving HEAD: same version installed
 * twice gets the same code, and `npm`'s own git-dependency cache can serve a
 * pinned ref with no network call at all once it has seen it.
 */
function tagExists(version) {
  try {
    execFileSync("git", ["ls-remote", "--exit-code", "--tags", REPO_URL, `refs/tags/v${version}`], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The spec `npm install` gets. Pinned to this plugin's own version when that
 * tag exists; the default branch otherwise, since a version with no tag yet
 * (this repository has not cut its first release) has nothing to pin to. The
 * fallback prints one line so a version that SHOULD have a tag and does not
 * (a release that failed partway, a typo) is visible rather than silently
 * serving whatever the default branch happens to be.
 */
function resolveGitSpec() {
  const version = pluginVersion();
  if (version === "unknown") return REPO_GIT_SPEC;
  if (tagExists(version)) return `${REPO_GIT_SPEC}#v${version}`;
  status(
    `no v${version} tag found on the repository (or it could not be checked); installing from the default branch instead.`,
  );
  return REPO_GIT_SPEC;
}

function install() {
  const spec = resolveGitSpec();
  status("installing the server (first run after install or an upgrade; this can take a minute)...");
  mkdirSync(installDir, { recursive: true });
  try {
    execFileSync(
      "npm",
      ["install", "--no-audit", "--no-fund", "--prefix", installDir, spec],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    status(`install failed (${spec} into ${installDir}).`);
    if (error.stdout?.length) process.stderr.write(error.stdout);
    if (error.stderr?.length) process.stderr.write(error.stderr);
    process.exit(typeof error.status === "number" ? error.status : 1);
  }
}

if (!existsSync(CLI)) install();

if (!existsSync(CLI)) {
  status(`the install finished but ${CLI} still is not there. The package's own build is broken; run \`npm install\` by hand at ${installDir} to see why.`);
  process.exit(1);
}

const args = [CLI, ...process.argv.slice(2)];
const child = spawn(process.execPath, args, { stdio: "inherit" });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
child.on("error", (error) => {
  status(`could not start the server: ${error.message}`);
  process.exit(1);
});
