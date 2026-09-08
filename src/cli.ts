#!/usr/bin/env node
/**
 * The command line.
 *
 *   gsheets-pro stdio          speak MCP over stdin and stdout
 *   gsheets-pro serve --http   the stateless HTTP server, for cloud and hosting
 *   gsheets-pro auth           sign in and write a token
 *   gsheets-pro doctor         say what is wrong, in the order it will bite
 *   gsheets-pro card           regenerate the skill card
 *   gsheets-pro vendor         copy the guide into a repository's .claude/
 *
 * `doctor` is line one of the README because Path A setup is the top support
 * cost of any Google plugin, and because the seven day Testing expiry produces
 * a 401 a week after everything worked, which is not a failure anyone diagnoses
 * on their own.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  clientSecretPath,
  dataDir,
  DEFAULT_SCOPES,
  expectedBearer,
  resolveAuth,
  runAuthFlow,
  SCOPE_DRIVE_READONLY,
  SCOPE_SPREADSHEETS,
  TESTING_TOKEN_LIFETIME_MS,
  tokenPath,
} from "./lib/auth.js";
import { findRegistryPath, loadRegistry } from "./lib/registry.js";
import { SERVER_NAME, SERVER_VERSION, toolNames } from "./server.js";
import { serveHttp } from "./transport/http.js";
import { serveStdio } from "./transport/stdio.js";

const USAGE = `${SERVER_NAME} ${SERVER_VERSION}

  gsheets-pro stdio                 Speak MCP over stdin and stdout.
  gsheets-pro serve --http          Stateless HTTP server for cloud sessions and hosting.
      --port <n>                    Port. Default $PORT, else 8080.
      --host <addr>                 Bind address. Default 0.0.0.0.
  gsheets-pro auth                  Sign in with a Desktop OAuth client and save a token.
      --drive-readonly              Also ask for Drive read access, needed to search by title.
      --client <file>               OAuth client JSON. Default ${clientSecretPath()}.
  gsheets-pro doctor                Check credentials, scopes, token age, and poppler.
  gsheets-pro card                  Regenerate the skill card from SKILL.md.
  gsheets-pro vendor <repo-dir>     Copy the guide, hooks, and presets into a repository's
                                     .claude/ directory, for scheduled runs (docs/cloud.md).
      --dry-run                     Print what would be copied and written without doing it.

Environment
  GSHEETS_PRO_TOKEN          Bearer the HTTP transport requires on every request.
  GSHEETS_PRO_TOKEN_FILE     Token location. Default ${tokenPath()}.
  GSHEETS_PRO_OAUTH_CLIENT   OAuth client JSON location.
  GSHEETS_PRO_CLIENT_ID      OAuth client id, in place of a JSON file.
  GSHEETS_PRO_CLIENT_SECRET  OAuth client secret, paired with the id above.
  GSHEETS_PRO_DATA_DIR       Where tokens and caches live. Default ${dataDir()}.
  GSHEETS_PRO_DATA           Alias of GSHEETS_PRO_DATA_DIR.
  GSHEETS_PRO_DEFAULT_PRESET Preset a call gets when it names none and nothing else says otherwise.
  GSHEETS_PRO_REGISTRY       Registry file. Default the repo's .claude/gsheets-pro.json.
`;

interface Flags {
  [key: string]: string | boolean;
}

function parseFlags(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split("=", 2);
    if (inline !== undefined) {
      flags[name] = inline;
    } else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
      flags[name] = argv[i + 1];
      i += 1;
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { positional, flags } = parseFlags(argv);
  const command = positional[0] ?? (flags["help"] || flags["h"] ? "help" : "help");

  switch (command) {
    case "stdio":
      await serveStdio();
      return 0;

    case "serve": {
      if (!flags["http"] && positional[1] !== "http") {
        process.stderr.write("serve needs --http. Stdio mode is `gsheets-pro stdio`.\n");
        return 2;
      }
      const port = flags["port"] ? Number(flags["port"]) : undefined;
      const host = typeof flags["host"] === "string" ? flags["host"] : undefined;
      const { port: bound, host: boundHost } = await serveHttp({
        ...(port !== undefined ? { port } : {}),
        ...(host !== undefined ? { host } : {}),
      });
      process.stderr.write(
        `${SERVER_NAME} ${SERVER_VERSION} listening on http://${boundHost}:${bound} (POST /mcp, GET /health)` +
          `${expectedBearer() ? " with a bearer required" : ""}\n`,
      );
      await new Promise<void>(() => {});
      return 0;
    }

    case "auth": {
      const scopes = [...DEFAULT_SCOPES];
      if (flags["drive-readonly"]) scopes.push(SCOPE_DRIVE_READONLY);
      const clientFile = typeof flags["client"] === "string" ? flags["client"] : undefined;
      const result = await runAuthFlow({
        scopes,
        ...(clientFile !== undefined ? { clientFile } : {}),
      });
      process.stdout.write(`Signed in. Token written to ${result.tokenFile}\n`);
      process.stdout.write(`Scopes: ${result.scopes.join(", ")}\n`);
      return 0;
    }

    case "doctor":
      return runDoctor();

    case "card":
      return runCard(argv.slice(1));

    case "vendor":
      return runVendor(argv.slice(1));

    case "help":
    default:
      process.stdout.write(USAGE);
      return positional.length === 0 || command === "help" ? 0 : 2;
  }
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix?: string;
}

export async function collectChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  const tokenFile = tokenPath();
  const clientFile = clientSecretPath();

  checks.push({
    name: "node",
    status: Number(process.versions.node.split(".")[0]) >= 22 ? "ok" : "fail",
    detail: `Node ${process.versions.node}`,
    ...(Number(process.versions.node.split(".")[0]) >= 22
      ? {}
      : { fix: "This server needs Node 22 or newer." }),
  });

  checks.push({
    name: "data directory",
    status: "ok",
    detail: dataDir(),
  });

  const hasClientFile = fs.existsSync(clientFile);
  const hasClientEnv = Boolean(process.env.GSHEETS_PRO_CLIENT_ID && process.env.GSHEETS_PRO_CLIENT_SECRET);
  const hasClient = hasClientFile || hasClientEnv;
  checks.push({
    name: "OAuth client",
    status: hasClient ? "ok" : "warn",
    detail: hasClientFile
      ? clientFile
      : hasClientEnv
        ? "GSHEETS_PRO_CLIENT_ID / GSHEETS_PRO_CLIENT_SECRET (no file needed; this is how the gsheets-pro-local plugin supplies one)"
        : `No file at ${clientFile}, and GSHEETS_PRO_CLIENT_ID / GSHEETS_PRO_CLIENT_SECRET are not both set`,
    ...(hasClient
      ? {}
      : {
          fix: "Only needed for Path A. In Google Cloud Console enable the Google Sheets API, create an OAuth client of type Desktop app, then either download the JSON and save it at that path, or set GSHEETS_PRO_CLIENT_ID and GSHEETS_PRO_CLIENT_SECRET directly. Or skip it entirely and use gcloud: `gcloud auth application-default login --scopes=" +
            DEFAULT_SCOPES.join(",") +
            "`.",
        }),
  });

  let auth: Awaited<ReturnType<typeof resolveAuth>> | undefined;
  try {
    auth = await resolveAuth();
    checks.push({
      name: "credentials",
      status: "ok",
      detail: `${auth.source} at ${auth.location}`,
    });
  } catch (error) {
    checks.push({
      name: "credentials",
      status: "fail",
      detail: (error as Error).message,
      fix: (error as { hint?: string }).hint ?? "Run `gsheets-pro auth`.",
    });
  }

  if (auth) {
    const scopes = auth.scopes;
    const hasSheets = scopes.some((s) => s === SCOPE_SPREADSHEETS);
    checks.push({
      name: "scopes",
      status: hasSheets ? "ok" : "fail",
      detail: scopes.join(", ") || "(none recorded)",
      ...(hasSheets
        ? {}
        : {
            fix: `The token is missing ${SCOPE_SPREADSHEETS}, so every call will fail. Run \`gsheets-pro auth\` again.`,
          }),
    });
    if (!scopes.includes(SCOPE_DRIVE_READONLY)) {
      checks.push({
        name: "drive search",
        status: "warn",
        detail: "No drive.readonly scope.",
        fix: "Searching Drive for a spreadsheet by title needs it. Everything else works without it, and it is a Restricted scope, so ask for it only if you want that search: `gsheets-pro auth --drive-readonly`.",
      });
    }

    if (auth.tokenWrittenAt && auth.source === "oauth_token_file") {
      const ageMs = Date.now() - auth.tokenWrittenAt.getTime();
      const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      const expired = ageMs > TESTING_TOKEN_LIFETIME_MS;
      checks.push({
        name: "token age",
        status: expired ? "warn" : "ok",
        detail: `Written ${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`}.`,
        ...(expired
          ? {
              fix: "While the OAuth consent screen is in Testing, Google expires the refresh token after seven days. If calls start failing with 401, either publish the app in Google Cloud Console under Audience, or run `gsheets-pro auth` again.",
            }
          : {}),
      });
    }
  }

  const bearer = expectedBearer();
  checks.push({
    name: "http bearer",
    status: "ok",
    detail: bearer
      ? "GSHEETS_PRO_TOKEN is set, so the HTTP transport requires it."
      : "Not set. The HTTP transport accepts unauthenticated requests.",
    ...(bearer
      ? {}
      : {
          fix: "Fine on a laptop. If you expose `serve --http` beyond localhost, set GSHEETS_PRO_TOKEN and send it as a bearer.",
        }),
  });

  const registryPath = process.env.GSHEETS_PRO_REGISTRY ?? findRegistryPath();
  if (registryPath) {
    try {
      const registry = loadRegistry();
      checks.push({
        name: "registry",
        status: "ok",
        detail: `${registryPath}, ${registry?.ids.length ?? 0} spreadsheet(s) protected.`,
      });
    } catch (error) {
      checks.push({
        name: "registry",
        status: "fail",
        detail: (error as Error).message,
        fix: (error as { hint?: string }).hint ?? "Fix or remove the file.",
      });
    }
  } else {
    checks.push({
      name: "registry",
      status: "ok",
      detail: "No .claude/gsheets-pro.json in this directory tree.",
      fix: "Optional. Add one to protect shared spreadsheets by id, naming the columns agents may write.",
    });
  }

  const poppler = await which("pdftoppm");
  checks.push({
    name: "poppler",
    status: poppler ? "ok" : "warn",
    detail: poppler ?? "pdftoppm not on PATH",
    ...(poppler
      ? {}
      : {
          fix: "Only needed for rendering a sheet to PNG. macOS: `brew install poppler`. Debian: `apt-get install poppler-utils`.",
        }),
  });

  checks.push({ name: "tools", status: "ok", detail: toolNames().join(", ") });
  return checks;
}

async function runDoctor(): Promise<number> {
  const checks = await collectChecks();
  const mark = { ok: "ok  ", warn: "warn", fail: "FAIL" } as const;
  for (const check of checks) {
    process.stdout.write(`${mark[check.status]}  ${check.name}: ${check.detail}\n`);
    if (check.fix) process.stdout.write(`      ${check.fix}\n`);
  }
  const failed = checks.filter((c) => c.status === "fail").length;
  process.stdout.write(
    failed === 0
      ? "\nReady.\n"
      : `\n${failed} check${failed === 1 ? "" : "s"} failed. Fix those first.\n`,
  );
  return failed === 0 ? 0 : 1;
}

function which(command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(process.platform === "win32" ? "where" : "which", [command]);
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => resolve(code === 0 && out.trim() ? out.trim().split("\n")[0] : undefined));
  });
}

// ---------------------------------------------------------------------------
// card, vendor: thin wrappers over the scripts/ helpers, run from a checkout
// of the repo (they ship as source, not compiled into dist/).
// ---------------------------------------------------------------------------

function runRepoScript(name: string, args: string[], what: string): Promise<number> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = path.resolve(here, "..", "scripts", name);
  if (!fs.existsSync(script)) {
    process.stderr.write(`No ${what} at ${script}. Run this from a checkout of the repo.\n`);
    return Promise.resolve(1);
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: "inherit" });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 0));
  });
}

function runCard(args: string[]): Promise<number> {
  return runRepoScript("card.mjs", args, "card generator");
}

function runVendor(args: string[]): Promise<number> {
  // vendor.mjs prints its own usage and exits 1 when <repo-dir> is missing;
  // no need to duplicate that check here.
  return runRepoScript("vendor.mjs", args, "vendor script");
}

// ---------------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  main().then(
    (code) => {
      if (code !== 0) process.exitCode = code;
    },
    (error: unknown) => {
      const hint = (error as { hint?: string }).hint;
      process.stderr.write(`${(error as Error).message}\n`);
      if (hint) process.stderr.write(`${hint}\n`);
      process.exitCode = 1;
    },
  );
}
