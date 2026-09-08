#!/usr/bin/env node
// Cuts a release: bumps the version everywhere it has to agree, moves
// CHANGELOG's Unreleased section under the new version, builds, commits a
// snapshot with dist/ included so the tag is self-contained, and tags it.
//
//   node scripts/release.mjs patch|minor|major|<x.y.z> [--dry-run] [--no-trailer]
//
// What "together" means: package.json, both plugin manifests
// (plugins/gsheets-pro/.claude-plugin/plugin.json,
// plugins/gsheets-pro-local/.claude-plugin/plugin.json), and
// .claude-plugin/marketplace.json (its own top-level version, and the
// version on each of the two plugin entries it lists) all move to the same
// number in the same commit. A plugin marketplace and an npm package that
// disagree about which version they are is a worse bug than any of the
// individual files being wrong.
//
// --- The dist/ trade-off ---
//
// dist/ is gitignored for ordinary development: it is build output, `npm run
// build` regenerates it from src/ every time, and committing it on every
// commit would make every diff twice as long for no reason. But a git tag is
// supposed to be a complete, reproducible snapshot, and the MCP registry
// entry and a `git checkout <tag>` both want dist/ to just be there rather
// than requiring a build step first. Those two goals do not fit in one
// commit policy, so this script uses three commits per release instead of
// one:
//
//   1. "release: vX.Y.Z"                    version bump + CHANGELOG, no dist/
//   2. "release: vX.Y.Z build output"        dist/ force-added, THIS is what
//                                             gets tagged
//   3. "release: untrack dist/ after vX.Y.Z" dist/ removed from the index
//                                             again (files stay on disk),
//                                             restoring the normal gitignored
//                                             state for every commit after
//
// The trade-off: three commits and a slightly unusual "add dist/, then
// remove it" pair in the history for every release, and the dist/ blobs
// from commit 2 live in the repository's object database forever even
// though no branch tip tracks them after commit 3. That is the price of
// keeping ordinary development diffs clean while still giving the tag a
// self-contained tree. If that trade turns out to be wrong, the fix is to
// stop untracking (drop commit 3) and accept dist/ as a permanently tracked
// path, or to stop committing it at all and point the registry at a built
// npm tarball instead.
//
// Every gate below (clean tree, typecheck, tests, build) runs before any
// file is touched, dry-run or not, so a release that would fail its own
// checks fails loudly before it writes anything.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const PACKAGE_JSON = join(ROOT, "package.json");
const CHANGELOG = join(ROOT, "CHANGELOG.md");
const MARKETPLACE_JSON = join(ROOT, ".claude-plugin/marketplace.json");
const PLUGIN_MANIFESTS = [
  join(ROOT, "plugins/gsheets-pro/.claude-plugin/plugin.json"),
  join(ROOT, "plugins/gsheets-pro-local/.claude-plugin/plugin.json"),
];

const REPO_URL = "https://github.com/jordfan/gsheets-pro";
const TRAILER = "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>";

function fail(message) {
  process.stderr.write(`release.mjs: ${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: ROOT, encoding: "utf8", ...options });
}

function runLive(command, args) {
  execFileSync(command, args, { cwd: ROOT, stdio: "inherit" });
}

// --- semver, just enough of it ---

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function parseSemver(version) {
  const match = SEMVER.exec(version);
  if (!match) fail(`"${version}" is not a plain x.y.z version.`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function bump(current, spec) {
  if (spec === "patch" || spec === "minor" || spec === "major") {
    const { major, minor, patch } = parseSemver(current);
    if (spec === "patch") return `${major}.${minor}.${patch + 1}`;
    if (spec === "minor") return `${major}.${minor + 1}.0`;
    return `${major + 1}.0.0`;
  }
  const explicit = spec.replace(/^v/, "");
  const next = parseSemver(explicit);
  const now = parseSemver(current);
  const nextTuple = [next.major, next.minor, next.patch];
  const nowTuple = [now.major, now.minor, now.patch];
  const isGreater =
    nextTuple[0] > nowTuple[0] ||
    (nextTuple[0] === nowTuple[0] && nextTuple[1] > nowTuple[1]) ||
    (nextTuple[0] === nowTuple[0] && nextTuple[1] === nowTuple[1] && nextTuple[2] > nowTuple[2]);
  if (!isGreater) fail(`${explicit} is not greater than the current version ${current}.`);
  return explicit;
}

// --- JSON files, edited in place, same 2-space formatting they already have ---

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function planJsonBumps(nextVersion) {
  const writes = [];

  const pkg = readJson(PACKAGE_JSON);
  writes.push({ path: PACKAGE_JSON, apply: () => writeJson(PACKAGE_JSON, { ...pkg, version: nextVersion }) });

  for (const manifestPath of PLUGIN_MANIFESTS) {
    const manifest = readJson(manifestPath);
    writes.push({
      path: manifestPath,
      apply: () => writeJson(manifestPath, { ...manifest, version: nextVersion }),
    });
  }

  const marketplace = readJson(MARKETPLACE_JSON);
  writes.push({
    path: MARKETPLACE_JSON,
    apply: () =>
      writeJson(MARKETPLACE_JSON, {
        ...marketplace,
        version: nextVersion,
        plugins: marketplace.plugins.map((plugin) => ({ ...plugin, version: nextVersion })),
      }),
  });

  return writes;
}

// --- CHANGELOG.md: move Unreleased's body under a new dated heading ---

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function planChangelog(nextVersion) {
  const source = readFileSync(CHANGELOG, "utf8");
  const unreleasedHeading = "## [Unreleased]";
  const start = source.indexOf(unreleasedHeading);
  if (start === -1) fail(`${CHANGELOG} has no "${unreleasedHeading}" heading.`);

  // The link-reference footer, if one exists yet, marks the end of the body
  // no matter what: it is never part of a release's notes. Absent that, the
  // body runs to the next "## [" heading, or to the end of the file if this
  // is the first release.
  const footerStart = source.search(/\n\[Unreleased\]:/);
  const afterHeading = start + unreleasedHeading.length;
  const searchRegion = footerStart === -1 ? source.slice(afterHeading) : source.slice(afterHeading, footerStart);
  const nextHeadingMatch = /\n## \[/.exec(searchRegion);
  const bodyEnd = nextHeadingMatch
    ? afterHeading + nextHeadingMatch.index + 1
    : footerStart === -1
      ? source.length
      : footerStart;

  const body = source.slice(afterHeading, bodyEnd).replace(/\s+$/, "");
  if (!body.trim()) {
    fail("CHANGELOG's Unreleased section is already empty. Add notes before releasing.");
  }

  const date = today();
  const newSection = `${unreleasedHeading}\n\nNothing yet.\n\n## [${nextVersion}] - ${date}${body}\n`;

  // The link reference footer: keep whatever is not one of the two lines this
  // script owns, then write both fresh. [Unreleased] always points at main;
  // the new version points at its own tag.
  const existingFooter = footerStart === -1 ? "" : source.slice(footerStart).trim();
  const keptFooterLines = existingFooter
    .split("\n")
    .filter((line) => line && !line.startsWith("[Unreleased]:") && !line.startsWith(`[${nextVersion}]:`));
  const footer = [
    `[Unreleased]: ${REPO_URL}/commits/main`,
    `[${nextVersion}]: ${REPO_URL}/releases/tag/v${nextVersion}`,
    ...keptFooterLines,
  ].join("\n");

  const head = source.slice(0, start).replace(/\s+$/, "");
  const next = `${head}\n\n${newSection}\n${footer}\n`;

  return { path: CHANGELOG, next, preview: newSection.trim() };
}

// --- git ---

function gitStatusPorcelain() {
  return run("git", ["status", "--porcelain"]).trim();
}

function gitCommit(message, { trailer }) {
  const body = trailer ? `${message}\n\n${TRAILER}` : message;
  run("git", ["commit", "-m", body]);
}

// --- main ---

function usage() {
  return "usage: node scripts/release.mjs patch|minor|major|<x.y.z> [--dry-run] [--no-trailer]";
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const noTrailer = args.includes("--no-trailer");
  const spec = args.find((arg) => !arg.startsWith("-"));

  if (!spec) fail(usage());
  if (!existsSync(PACKAGE_JSON)) fail("run this from the repository root.");

  const currentVersion = readJson(PACKAGE_JSON).version;
  const nextVersion = bump(currentVersion, spec);

  const dirty = gitStatusPorcelain();
  if (dirty) {
    fail(
      `working tree is not clean, refusing to release from a dirty checkout:\n${dirty}\n` +
        "Commit or stash first, even for --dry-run, so the plan reflects what would really happen.",
    );
  }

  process.stdout.write(`release.mjs: ${currentVersion} -> ${nextVersion}\n\n`);

  process.stdout.write("running the same gates CI runs, before touching anything...\n");
  runLive("npm", ["run", "typecheck"]);
  runLive("npm", ["test"]);
  process.stdout.write("gates passed.\n\n");

  const jsonWrites = planJsonBumps(nextVersion);
  const changelog = planChangelog(nextVersion);

  if (dryRun) {
    process.stdout.write("--dry-run, nothing below is written:\n\n");
    process.stdout.write("would bump version in:\n");
    for (const write of jsonWrites) process.stdout.write(`  ${write.path.replace(`${ROOT}/`, "")}\n`);
    process.stdout.write(`\nwould write to CHANGELOG.md:\n\n${changelog.preview}\n\n`);
    process.stdout.write(
      `would run: npm run build\n` +
        `would create commit 1/3: "release: v${nextVersion}" (version bump + CHANGELOG)\n` +
        `would run: git add -f dist\n` +
        `would create commit 2/3: "release: v${nextVersion} build output" (this is what gets tagged)\n` +
        `would create tag: v${nextVersion}\n` +
        `would run: git rm -r --cached dist\n` +
        `would create commit 3/3: "release: untrack dist/ after v${nextVersion}"\n\n` +
        "nothing pushed. this script never pushes.\n",
    );
    return;
  }

  for (const write of jsonWrites) write.apply();
  writeFileSync(changelog.path, changelog.next, "utf8");

  run("git", ["add", ...jsonWrites.map((w) => w.path), CHANGELOG]);
  gitCommit(`release: v${nextVersion}`, { trailer: !noTrailer });
  process.stdout.write(`committed: release: v${nextVersion}\n`);

  process.stdout.write("building...\n");
  runLive("npm", ["run", "build"]);

  run("git", ["add", "-f", "dist"]);
  const distStatus = run("git", ["status", "--porcelain"]);
  if (!distStatus.trim()) {
    fail("npm run build produced no dist/ output to commit. Check the build.");
  }
  gitCommit(
    `release: v${nextVersion} build output\n\n` +
      "dist/ is gitignored for ordinary development. This commit force-adds it " +
      "so the tag below is a self-contained snapshot; see scripts/release.mjs " +
      "for the trade-off. The next commit untracks it again.",
    { trailer: !noTrailer },
  );
  process.stdout.write(`committed: release: v${nextVersion} build output\n`);

  run("git", ["tag", "-a", `v${nextVersion}`, "-m", `v${nextVersion}`]);
  process.stdout.write(`tagged: v${nextVersion}\n`);

  run("git", ["rm", "-r", "--cached", "dist"]);
  gitCommit(`release: untrack dist/ after v${nextVersion}`, { trailer: !noTrailer });
  process.stdout.write(`committed: release: untrack dist/ after v${nextVersion}\n`);

  process.stdout.write(
    `\nDone. v${nextVersion} is tagged locally and nothing was pushed.\n` +
      `Review with: git log --stat -3\n` +
      `Push with:   git push origin main v${nextVersion}\n`,
  );
}

main();
