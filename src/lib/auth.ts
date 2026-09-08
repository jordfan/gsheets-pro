/**
 * Credentials.
 *
 * Three ways in, tried in order, because the three audiences are genuinely
 * different people.
 *
 * Path A, a stranger on a laptop: their own GCP project, a Desktop OAuth
 * client, and a loopback PKCE sign in that writes a token under the plugin's
 * data directory. It is the most setup and it is the only path that works for
 * someone with no Google Cloud experience beyond making a project.
 *
 * Path B, anyone who already has gcloud: Application Default Credentials, with
 * no OAuth client to create at all. `gcloud auth application-default login
 * --scopes=...` and they are done.
 *
 * Hosted: a token file the deployment already writes, in the shape Python's
 * `google.oauth2.credentials.Credentials.to_json()` produces, plus an optional
 * bearer that the HTTP transport enforces on every request.
 *
 * One thing worth stating plainly: while the OAuth consent screen is in
 * Testing, Google expires the refresh token after seven days. `doctor` checks
 * for it because otherwise the failure arrives as a bewildering 401 a week
 * after everything worked.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";

import { CodeChallengeMethod, GoogleAuth, OAuth2Client, type Credentials } from "google-auth-library";

import { GsheetsError, err } from "./errors.js";

/** Read and write cells and formatting. Sensitive, and exempt for personal use. */
export const SCOPE_SPREADSHEETS = "https://www.googleapis.com/auth/spreadsheets";
/** Files this app created or the user picked. Cannot open an existing sheet by id. */
export const SCOPE_DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
/** Restricted. Only needed to search Drive for a spreadsheet by title. */
export const SCOPE_DRIVE_READONLY = "https://www.googleapis.com/auth/drive.readonly";

export const DEFAULT_SCOPES = [SCOPE_SPREADSHEETS, SCOPE_DRIVE_FILE];

/** How long a Testing mode refresh token lives. */
export const TESTING_TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export type AuthSource = "oauth_token_file" | "application_default" | "explicit_client";

export interface AuthState {
  client: OAuth2Client | GoogleAuth;
  source: AuthSource;
  /** Where the credential came from, for `doctor` to print. */
  location: string;
  scopes: string[];
  /** When the stored token was last written, for the seven day warning. */
  tokenWrittenAt?: Date;
  /** The access token's own expiry, which is an hour and not interesting. */
  accessTokenExpiry?: Date;
  hasRefreshToken: boolean;
}

// ---------------------------------------------------------------------------
// Where things live
// ---------------------------------------------------------------------------

/**
 * The plugin's data directory, in the order Claude Code makes one available.
 * `GSHEETS_PRO_DATA` is a plain alias of `GSHEETS_PRO_DATA_DIR`: it is what
 * the gsheets-pro-local plugin's `.mcp.json` passes (`${CLAUDE_PLUGIN_DATA}`,
 * unmodified) so the server lands on exactly the directory Claude Code
 * already gives that plugin, `~/.claude/plugins/data/gsheets-pro-local/` on a
 * normal install, with no `gsheets-pro` subfolder appended, matching what
 * `SECURITY.md` documents. Falling back to the temp directory is deliberate:
 * a token that vanishes on reboot is better than a crash in an environment
 * with no writable home.
 */
export function dataDir(): string {
  const explicit = process.env.GSHEETS_PRO_DATA_DIR ?? process.env.GSHEETS_PRO_DATA;
  if (explicit) return explicit;
  const plugin = process.env.CLAUDE_PLUGIN_DATA;
  if (plugin) return path.join(plugin, "gsheets-pro");
  const home = os.homedir();
  if (home) return path.join(home, ".claude", "plugins", "data", "gsheets-pro");
  return path.join(os.tmpdir(), "gsheets-pro");
}

export function tokenPath(): string {
  return process.env.GSHEETS_PRO_TOKEN_FILE ?? path.join(dataDir(), "token.json");
}

export function clientSecretPath(): string {
  return (
    process.env.GSHEETS_PRO_OAUTH_CLIENT ??
    process.env.GSHEETS_PRO_CREDENTIALS ??
    path.join(dataDir(), "credentials.json")
  );
}

function ensureDir(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

// ---------------------------------------------------------------------------
// Token files
// ---------------------------------------------------------------------------

/**
 * Both shapes we accept. Python's `Credentials.to_json()` uses `token` and
 * snake_case; the Node library uses `access_token` and `expiry_date`. The
 * hosted deployment writes the Python shape, so tolerating it is not a nicety.
 */
export interface StoredToken {
  token?: string | null;
  access_token?: string | null;
  refresh_token?: string;
  token_uri?: string;
  client_id?: string;
  client_secret?: string;
  scopes?: string[];
  scope?: string;
  expiry?: string;
  expiry_date?: number;
  /** Written by us, so `doctor` can age the refresh token. */
  saved_at?: string;
  /** Some writers nest the real token one level down. */
  tokens?: StoredToken;
}

export interface NormalizedToken {
  refreshToken?: string;
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  scopes: string[];
  expiryDate?: number;
  savedAt?: Date;
}

/** Flatten either shape into one. */
export function normalizeToken(raw: StoredToken): NormalizedToken {
  const token = raw.tokens ?? raw;
  const scopes = token.scopes ?? (token.scope ? token.scope.split(/\s+/).filter(Boolean) : []);

  let expiryDate: number | undefined;
  if (typeof token.expiry_date === "number") {
    expiryDate = token.expiry_date;
  } else if (token.expiry) {
    // Python writes a naive UTC timestamp with no zone marker. Reading that as
    // local time makes an unexpired token look hours stale, so assume UTC when
    // no offset is present.
    const text = /(Z|[+-]\d{2}:?\d{2})$/.test(token.expiry) ? token.expiry : `${token.expiry}Z`;
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) expiryDate = parsed;
  }

  const out: NormalizedToken = { scopes };
  if (token.refresh_token) out.refreshToken = token.refresh_token;
  const access = token.access_token ?? token.token;
  if (access) out.accessToken = access;
  if (token.client_id) out.clientId = token.client_id;
  if (token.client_secret) out.clientSecret = token.client_secret;
  if (expiryDate !== undefined) out.expiryDate = expiryDate;
  if (token.saved_at) {
    const saved = Date.parse(token.saved_at);
    if (Number.isFinite(saved)) out.savedAt = new Date(saved);
  }
  return out;
}

export interface OAuthClientFile {
  installed?: { client_id?: string; client_secret?: string; redirect_uris?: string[] };
  web?: { client_id?: string; client_secret?: string; redirect_uris?: string[] };
}

export interface OAuthClientInfo {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  kind: "installed" | "web";
}

/** Pull the client id and secret out of a downloaded Desktop client JSON. */
export function readOAuthClient(file: OAuthClientFile, where = "the OAuth client file"): OAuthClientInfo {
  const kind = file.installed ? "installed" : file.web ? "web" : undefined;
  const key = file.installed ?? file.web;
  if (!kind || !key?.client_id || !key?.client_secret) {
    throw new GsheetsError(
      "auth_missing",
      `${where} has no client id and secret.`,
      'Download the JSON for a Desktop app OAuth client from Google Cloud Console under APIs and services, Credentials. The file has one top level key, "installed".',
    );
  }
  return {
    clientId: key.client_id,
    clientSecret: key.client_secret,
    redirectUris: key.redirect_uris ?? [],
    kind,
  };
}

function readJsonFile<T>(file: string, label: string): T {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new GsheetsError(
      "auth_missing",
      `Could not read ${label} at ${file}: ${(error as Error).message}`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new GsheetsError(
      "auth_missing",
      `${label} at ${file} is not valid JSON: ${(error as Error).message}`,
      "Re-download the file, or delete it and run `gsheets-pro auth` again.",
    );
  }
}

/**
 * The OAuth client, id and secret, from a file first and the environment
 * second. A file is the deliberate, explicit choice: Path A's downloaded
 * Desktop client JSON, or a hosted deployment's mounted secret. The
 * environment pair, `GSHEETS_PRO_CLIENT_ID` and `GSHEETS_PRO_CLIENT_SECRET`,
 * is how the gsheets-pro-local plugin supplies one instead, through its own
 * `/plugin` configuration (stored in the system keychain, not a file) rather
 * than a downloaded JSON on disk. Returns undefined when neither is there, so
 * callers can build their own error naming the actual next step.
 */
export function resolveOAuthClientInfo(clientFile?: string): OAuthClientInfo | undefined {
  const file = clientFile ?? clientSecretPath();
  if (fs.existsSync(file)) {
    return readOAuthClient(readJsonFile<OAuthClientFile>(file, "the OAuth client file"), file);
  }
  const clientId = process.env.GSHEETS_PRO_CLIENT_ID;
  const clientSecret = process.env.GSHEETS_PRO_CLIENT_SECRET;
  if (clientId && clientSecret) {
    return { clientId, clientSecret, redirectUris: [], kind: "installed" };
  }
  return undefined;
}

export function saveToken(credentials: Credentials, client: OAuthClientInfo, file = tokenPath()): void {
  const payload: StoredToken = {
    token: credentials.access_token ?? null,
    refresh_token: credentials.refresh_token ?? undefined,
    token_uri: "https://oauth2.googleapis.com/token",
    client_id: client.clientId,
    client_secret: client.clientSecret,
    scopes: credentials.scope ? credentials.scope.split(/\s+/).filter(Boolean) : DEFAULT_SCOPES,
    expiry_date: credentials.expiry_date ?? undefined,
    saved_at: new Date().toISOString(),
  };
  ensureDir(file);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Resolving a credential
// ---------------------------------------------------------------------------

export interface ResolveAuthOptions {
  scopes?: string[];
  /** Read this token file instead of the default location. */
  tokenFile?: string;
  /** Read this OAuth client file instead of the default location. */
  clientFile?: string;
  /** Skip Application Default Credentials, which `doctor` wants to do. */
  skipAdc?: boolean;
}

/**
 * Find a usable credential. Order matters: an explicit token file is the
 * deliberate choice, ADC is the convenient one, and a helpful error beats a
 * mystery 401.
 */
export async function resolveAuth(options: ResolveAuthOptions = {}): Promise<AuthState> {
  const scopes = options.scopes ?? DEFAULT_SCOPES;
  const file = options.tokenFile ?? tokenPath();

  if (fs.existsSync(file)) {
    return fromTokenFile(file, options.clientFile, scopes);
  }

  if (!options.skipAdc) {
    const adc = await tryApplicationDefault(scopes);
    if (adc) return adc;
  }

  throw err.authMissing(
    `No credentials. Looked for a token at ${file} and for Application Default Credentials.`,
    [
      "Two ways to fix this.",
      "Run `gsheets-pro auth` after putting a Desktop OAuth client JSON at " +
        clientSecretPath() +
        ".",
      "Or, if you have gcloud: `gcloud auth application-default login --scopes=" +
        scopes.join(",") +
        "`.",
      "`gsheets-pro doctor` prints which of these it can see.",
    ].join(" "),
  );
}

function fromTokenFile(file: string, clientFile: string | undefined, scopes: string[]): AuthState {
  const stored = normalizeToken(readJsonFile<StoredToken>(file, "the token file"));

  let clientId = stored.clientId;
  let clientSecret = stored.clientSecret;
  let redirectUri: string | undefined;

  const override = resolveOAuthClientInfo(clientFile);
  if (override) {
    clientId = override.clientId;
    clientSecret = override.clientSecret;
    redirectUri = override.redirectUris[0];
  }

  if (!clientId || !clientSecret) {
    const secretFile = clientFile ?? clientSecretPath();
    throw err.authMissing(
      `The token at ${file} has no client id and secret, there is no OAuth client file at ${secretFile}, and GSHEETS_PRO_CLIENT_ID / GSHEETS_PRO_CLIENT_SECRET are not both set.`,
      "Put the Desktop client JSON at that path, set GSHEETS_PRO_CLIENT_ID and GSHEETS_PRO_CLIENT_SECRET, or run `gsheets-pro auth` to sign in again and write a complete token.",
    );
  }
  if (!stored.refreshToken) {
    throw new GsheetsError(
      "auth_expired",
      `The token at ${file} has no refresh token, so no new access token can be minted.`,
      "Run `gsheets-pro auth` to sign in again. If this is a hosted deployment, re-run whatever writes the token file.",
    );
  }

  const client = new OAuth2Client({
    clientId,
    clientSecret,
    redirectUri,
    forceRefreshOnFailure: true,
  });
  // Only the refresh token is set. A stored access token is usually expired,
  // and letting the library mint a fresh one is both simpler and correct.
  client.setCredentials({ refresh_token: stored.refreshToken });

  const state: AuthState = {
    client,
    source: "oauth_token_file",
    location: file,
    scopes: stored.scopes.length ? stored.scopes : scopes,
    hasRefreshToken: true,
  };
  if (stored.savedAt) state.tokenWrittenAt = stored.savedAt;
  else {
    try {
      state.tokenWrittenAt = fs.statSync(file).mtime;
    } catch {
      // Not worth failing over.
    }
  }
  if (stored.expiryDate) state.accessTokenExpiry = new Date(stored.expiryDate);
  return state;
}

async function tryApplicationDefault(scopes: string[]): Promise<AuthState | undefined> {
  try {
    const auth = new GoogleAuth({ scopes });
    // getClient throws when there is nothing to find, which is the signal.
    await auth.getClient();
    return {
      client: auth,
      source: "application_default",
      location:
        process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "Application Default Credentials (gcloud)",
      scopes,
      hasRefreshToken: true,
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Path A: the loopback PKCE sign in
// ---------------------------------------------------------------------------

export interface AuthFlowOptions {
  scopes?: string[];
  clientFile?: string;
  tokenFile?: string;
  /** Loopback port. 0 asks the OS for a free one, which is the default. */
  port?: number;
  /** Called with the URL to open. Defaults to printing it. */
  onUrl?: (url: string) => void;
  timeoutMs?: number;
}

/**
 * Run the sign in and write the token. Loopback with PKCE is what Google
 * documents for a Desktop client, and it means no client secret ever has to
 * travel through a browser.
 */
export async function runAuthFlow(options: AuthFlowOptions = {}): Promise<{ tokenFile: string; scopes: string[] }> {
  const scopes = options.scopes ?? DEFAULT_SCOPES;
  const outFile = options.tokenFile ?? tokenPath();

  const info = resolveOAuthClientInfo(options.clientFile);
  if (!info) {
    const file = options.clientFile ?? clientSecretPath();
    throw err.authMissing(
      `No OAuth client file at ${file}, and GSHEETS_PRO_CLIENT_ID / GSHEETS_PRO_CLIENT_SECRET are not both set.`,
      "In Google Cloud Console, enable the Google Sheets API, create an OAuth client of type Desktop app, then either download its JSON and save it at that path, or set GSHEETS_PRO_CLIENT_ID and GSHEETS_PRO_CLIENT_SECRET directly, which is how the gsheets-pro-local plugin's own configuration reaches here. `gsheets-pro doctor` repeats these steps.",
    );
  }

  const server = http.createServer();
  const port = await listen(server, options.port ?? 0);
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;

  const client = new OAuth2Client({
    clientId: info.clientId,
    clientSecret: info.clientSecret,
    redirectUri,
  });
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const state = randomState();
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,
    state,
  });

  (options.onUrl ?? defaultOnUrl)(url);

  try {
    const code = await waitForCode(server, state, options.timeoutMs ?? 5 * 60 * 1000);
    const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    if (!tokens.refresh_token) {
      throw new GsheetsError(
        "auth_expired",
        "Google returned an access token but no refresh token, so the sign in would stop working within the hour.",
        "Revoke the app at myaccount.google.com/permissions and run `gsheets-pro auth` again. Google only issues a refresh token on the first consent unless the app is re-approved.",
      );
    }
    saveToken(tokens, info, outFile);
    return { tokenFile: outFile, scopes };
  } finally {
    server.close();
  }
}

function defaultOnUrl(url: string): void {
  process.stderr.write(`\nOpen this URL to sign in:\n\n${url}\n\n`);
}

function randomState(): string {
  return Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join("");
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("Could not open a loopback port for the sign in."));
    });
  });
}

function waitForCode(server: http.Server, expectedState: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new GsheetsError(
          "auth_missing",
          "The sign in timed out before the browser came back.",
          "Run `gsheets-pro auth` again and finish the consent screen in the browser.",
        ),
      );
    }, timeoutMs);

    server.on("request", (req, res) => {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname !== "/oauth2callback") {
        res.writeHead(404).end("Not here.");
        return;
      }
      const code = requestUrl.searchParams.get("code");
      const state = requestUrl.searchParams.get("state");
      const error = requestUrl.searchParams.get("error");

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (error) {
        res.end(page("Sign in was refused.", `Google said: ${escapeHtml(error)}`));
        clearTimeout(timer);
        reject(new GsheetsError("auth_missing", `Google refused the sign in: ${error}`));
        return;
      }
      if (state !== expectedState) {
        res.end(page("That response did not match this sign in.", "Close this tab and try again."));
        clearTimeout(timer);
        reject(
          new GsheetsError(
            "auth_missing",
            "The OAuth state did not match, so the response was discarded.",
            "Run `gsheets-pro auth` again, and finish the sign in that the command opens rather than an older tab.",
          ),
        );
        return;
      }
      if (!code) {
        res.end(page("No code came back.", "Close this tab and run the command again."));
        clearTimeout(timer);
        reject(new GsheetsError("auth_missing", "Google returned no authorization code."));
        return;
      }
      res.end(page("You are signed in.", "You can close this tab and go back to the terminal."));
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>gsheets-pro</title><body style="font:16px/1.5 system-ui;margin:4rem auto;max-width:32rem;padding:0 1rem"><h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body>`;
}

// ---------------------------------------------------------------------------
// The hosted bearer
// ---------------------------------------------------------------------------

/** The shared secret the HTTP transport requires, when one is configured. */
export function expectedBearer(): string | undefined {
  const token = process.env.GSHEETS_PRO_TOKEN;
  return token && token.trim() ? token.trim() : undefined;
}

/**
 * Constant time compare, so a wrong bearer cannot be discovered a byte at a
 * time by timing the rejection.
 */
export function bearerMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Pull the bearer out of an Authorization header. */
export function readBearer(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1].trim() : undefined;
}
