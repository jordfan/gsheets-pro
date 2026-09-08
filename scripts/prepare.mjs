#!/usr/bin/env node
// The "prepare" lifecycle script. npm runs this after `npm install`/`npm ci`
// in two cases that matter here: an ordinary local install inside a checkout
// of this repository, and installing this package FROM GIT (a git dependency,
// or `npx <git-spec>`) — for a git install, npm clones the repository, runs
// this, and only afterward packs whatever package.json's "files" list names
// (dist/, README, LICENSE, NOTICE) into what actually lands in the consumer's
// node_modules. That second case is why this exists: it is what lets
// plugins/gsheets-pro-local/bin/start.mjs run this server via `npx
// github:jordfan/gsheets-pro` without a separate build step of its own. See
// that file for why: the plugin cache Claude Code materializes from a
// marketplace install carries no src/ or package.json to build from at all,
// so building in place, where the plugin actually runs, is not an option.
//
// Skipped quietly, on purpose, when there is no src/ to build: the
// Dockerfile's build stage runs `npm ci` before src/ is copied in
// (deliberately, so the dependency-install layer caches independently of
// source changes), and a published npm tarball never carries src/ at all,
// having already been built at publish time. Both are `npm install` runs
// with nothing this script can build, and both should succeed, not fail.
//
// A real build failure is NOT swallowed: build() below does not catch, so a
// TypeScript error here fails `npm install`/`npm ci` the same way a broken
// `npm run build` would anywhere else, rather than silently leaving dist/
// missing for something downstream to fail on later with no explanation.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

if (existsSync(join(ROOT, "src"))) {
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
}
