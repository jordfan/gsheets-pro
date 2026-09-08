/**
 * Credential resolution: the data directory alias, and the OAuth client
 * coming from an environment pair (GSHEETS_PRO_CLIENT_ID /
 * GSHEETS_PRO_CLIENT_SECRET) rather than only a downloaded JSON file. This is
 * how the gsheets-pro-local plugin's `.mcp.json` supplies credentials: it has
 * no way to place a file, only environment variables, configured through
 * `/plugin` rather than a Cloud Console download.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { dataDir, resolveAuth, resolveOAuthClientInfo, runAuthFlow } from "../src/lib/auth.js";

const ENV_KEYS = [
  "GSHEETS_PRO_DATA_DIR",
  "GSHEETS_PRO_DATA",
  "CLAUDE_PLUGIN_DATA",
  "GSHEETS_PRO_OAUTH_CLIENT",
  "GSHEETS_PRO_CREDENTIALS",
  "GSHEETS_PRO_CLIENT_ID",
  "GSHEETS_PRO_CLIENT_SECRET",
] as const;

let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("dataDir", () => {
  test("GSHEETS_PRO_DATA_DIR wins over everything, including GSHEETS_PRO_DATA", () => {
    process.env.GSHEETS_PRO_DATA_DIR = "/explicit/dir";
    process.env.GSHEETS_PRO_DATA = "/plugin/data";
    expect(dataDir()).toBe("/explicit/dir");
  });

  test("GSHEETS_PRO_DATA is a plain alias of GSHEETS_PRO_DATA_DIR: used directly, no subfolder appended", () => {
    process.env.GSHEETS_PRO_DATA = "/plugin/data";
    expect(dataDir()).toBe("/plugin/data");
  });

  test("falls back to CLAUDE_PLUGIN_DATA/gsheets-pro when neither is set", () => {
    process.env.CLAUDE_PLUGIN_DATA = "/plugin/root";
    expect(dataDir()).toBe(path.join("/plugin/root", "gsheets-pro"));
  });
});

describe("resolveOAuthClientInfo", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsheets-auth-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("undefined when neither a file nor the environment pair is present", () => {
    expect(resolveOAuthClientInfo(path.join(dir, "credentials.json"))).toBeUndefined();
  });

  test("GSHEETS_PRO_CLIENT_ID / GSHEETS_PRO_CLIENT_SECRET are used when no file exists", () => {
    process.env.GSHEETS_PRO_CLIENT_ID = "env-id";
    process.env.GSHEETS_PRO_CLIENT_SECRET = "env-secret";
    expect(resolveOAuthClientInfo(path.join(dir, "credentials.json"))).toEqual({
      clientId: "env-id",
      clientSecret: "env-secret",
      redirectUris: [],
      kind: "installed",
    });
  });

  test("a client file wins over the environment pair when both are present", () => {
    process.env.GSHEETS_PRO_CLIENT_ID = "env-id";
    process.env.GSHEETS_PRO_CLIENT_SECRET = "env-secret";
    const file = path.join(dir, "credentials.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ installed: { client_id: "file-id", client_secret: "file-secret" } }),
    );
    expect(resolveOAuthClientInfo(file)).toMatchObject({
      clientId: "file-id",
      clientSecret: "file-secret",
    });
  });

  test("a partial pair (only one of the two) is not enough", () => {
    process.env.GSHEETS_PRO_CLIENT_ID = "env-id";
    expect(resolveOAuthClientInfo(path.join(dir, "credentials.json"))).toBeUndefined();
  });
});

describe("resolveAuth honors the environment pair for a token with no embedded client", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsheets-auth-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("succeeds using GSHEETS_PRO_CLIENT_ID / GSHEETS_PRO_CLIENT_SECRET", async () => {
    const tokenFile = path.join(dir, "token.json");
    fs.writeFileSync(tokenFile, JSON.stringify({ refresh_token: "rt" }));
    process.env.GSHEETS_PRO_CLIENT_ID = "env-id";
    process.env.GSHEETS_PRO_CLIENT_SECRET = "env-secret";

    const state = await resolveAuth({
      tokenFile,
      clientFile: path.join(dir, "does-not-exist.json"),
      skipAdc: true,
    });
    expect(state.source).toBe("oauth_token_file");
    expect(state.hasRefreshToken).toBe(true);
  });

  test("without a file or the environment pair it fails naming both", async () => {
    const tokenFile = path.join(dir, "token.json");
    fs.writeFileSync(tokenFile, JSON.stringify({ refresh_token: "rt" }));

    await expect(
      resolveAuth({ tokenFile, clientFile: path.join(dir, "does-not-exist.json"), skipAdc: true }),
    ).rejects.toThrow(/client id and secret/);
  });

  test("a client file still overrides the environment pair for a stored token", async () => {
    const dirForFile = fs.mkdtempSync(path.join(os.tmpdir(), "gsheets-auth-test-"));
    try {
      const tokenFile = path.join(dir, "token.json");
      fs.writeFileSync(tokenFile, JSON.stringify({ refresh_token: "rt" }));
      process.env.GSHEETS_PRO_CLIENT_ID = "env-id";
      process.env.GSHEETS_PRO_CLIENT_SECRET = "env-secret";
      const clientFile = path.join(dirForFile, "credentials.json");
      fs.writeFileSync(
        clientFile,
        JSON.stringify({ installed: { client_id: "file-id", client_secret: "file-secret" } }),
      );

      const state = await resolveAuth({ tokenFile, clientFile, skipAdc: true });
      expect(state.source).toBe("oauth_token_file");
    } finally {
      fs.rmSync(dirForFile, { recursive: true, force: true });
    }
  });
});

describe("runAuthFlow accepts the environment pair in place of a client file", () => {
  test("gets past client resolution and into the PKCE flow, timing out on the browser step rather than on a missing client", async () => {
    process.env.GSHEETS_PRO_CLIENT_ID = "env-id";
    process.env.GSHEETS_PRO_CLIENT_SECRET = "env-secret";

    await expect(
      runAuthFlow({
        clientFile: "/nonexistent/credentials.json",
        onUrl: () => {},
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/timed out/);
  });

  test("still fails naming both options when neither a file nor the pair is present", async () => {
    await expect(
      runAuthFlow({ clientFile: "/nonexistent/credentials.json", onUrl: () => {} }),
    ).rejects.toThrow(/OAuth client/);
  });
});
