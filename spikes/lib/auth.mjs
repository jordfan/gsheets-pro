// Shared auth for the live spikes.
//
// The stored token has the shape Python google-auth writes with
// Credentials.to_json(): token, refresh_token, token_uri, client_id,
// client_secret, scopes. Node's googleapis wants different key names, so this
// translates. Nothing here ever prints a secret.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { google } from 'googleapis';

const SECRETS = new URL('../.secrets/', import.meta.url);
const TOKEN_FILE = new URL('sheets-mcp-token.json', SECRETS);
const OUT = new URL('../out/', import.meta.url);
const STATE_FILE = new URL('state.json', OUT);

export function loadToken() {
  if (!existsSync(TOKEN_FILE)) {
    throw new Error(
      'spikes/.secrets/sheets-mcp-token.json is missing. Run fetch-secrets.mjs after a gcloud reauth.',
    );
  }
  return JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
}

/** An authorized OAuth2 client for googleapis calls. */
export function authClient() {
  const t = loadToken();
  const client = new google.auth.OAuth2(t.client_id, t.client_secret, 'http://localhost');
  // Deliberately NOT seeding access_token. The stored `token` is the last
  // access token Python wrote and is almost always expired; seeding it without
  // an expiry_date makes google-auth-library hand it back as if it were live,
  // and every raw-bearer call then 401s. Refresh token only, so the library is
  // forced to mint a fresh one.
  client.setCredentials({ refresh_token: t.refresh_token });
  return client;
}

/** A raw bearer string, for the undocumented export URL that googleapis cannot call. */
export async function accessToken() {
  const client = authClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('no access token returned by refresh');
  return token;
}

/**
 * The scopes Google says this token actually carries, which is the only
 * trustworthy answer. Returns scope strings only, never the token.
 */
export async function grantedScopes() {
  const token = await accessToken();
  const res = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`,
  );
  if (!res.ok) return { error: `tokeninfo ${res.status}` };
  const info = await res.json();
  return {
    scopes: String(info.scope || '').split(/\s+/).filter(Boolean),
    expiresInSeconds: Number(info.expires_in),
  };
}

export function sheetsApi() {
  return google.sheets({ version: 'v4', auth: authClient() });
}

export function driveApi() {
  return google.drive({ version: 'v3', auth: authClient() });
}

// ---- shared spike state, so every script uses the ONE disposable spreadsheet
export function readState() {
  if (!existsSync(STATE_FILE)) return {};
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

export function writeState(patch) {
  mkdirSync(OUT, { recursive: true });
  const next = { ...readState(), ...patch };
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

export const SPIKE_TITLE = 'gsheets-pro spike (safe to delete)';

/** The one disposable spreadsheet. Creates it once, then reuses it forever. */
export async function spikeSpreadsheetId() {
  const state = readState();
  if (state.spreadsheetId) return state.spreadsheetId;
  const sheets = sheetsApi();
  const res = await sheets.spreadsheets.create({
    requestBody: { properties: { title: SPIKE_TITLE } },
  });
  const id = res.data.spreadsheetId;
  writeState({ spreadsheetId: id, url: res.data.spreadsheetUrl, createdAt: new Date().toISOString() });
  console.log(`created disposable spreadsheet: ${res.data.spreadsheetUrl}`);
  return id;
}

/**
 * Wipe a tab back to empty so a spike can be re-run.
 *
 * `updateCells` over a whole sheet clears values, formats, and validation but
 * does NOT clear banding, conditional-format rules, merges, or basic filters,
 * and `addBanding` refuses to overlap existing banding. So each of those has to
 * be deleted by hand, newest index first.
 */
export async function resetTab(spreadsheetId, sheetId) {
  const sheets = sheetsApi();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(sheetId,title),bandedRanges,conditionalFormats,merges,basicFilter,tables(tableId))',
  });
  const s = meta.data.sheets.find((x) => x.properties.sheetId === sheetId);
  if (!s) throw new Error(`sheetId ${sheetId} not found`);
  const requests = [];

  for (const t of s.tables ?? []) requests.push({ deleteTable: { tableId: t.tableId } });
  if (s.basicFilter) requests.push({ clearBasicFilter: { sheetId } });
  for (const b of s.bandedRanges ?? []) requests.push({ deleteBanding: { bandedRangeId: b.bandedRangeId } });
  // conditional formats are addressed by index, so delete from the end
  for (let i = (s.conditionalFormats ?? []).length - 1; i >= 0; i--) {
    requests.push({ deleteConditionalFormatRule: { sheetId, index: i } });
  }
  for (const m of s.merges ?? []) requests.push({ unmergeCells: { range: m } });
  requests.push({
    updateCells: { range: { sheetId }, fields: 'userEnteredValue,userEnteredFormat,dataValidation,note' },
  });

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  return { cleared: requests.length - 1 };
}

/** Resolve a tab name to its sheetId, creating the tab if absent. */
export async function ensureTab(spreadsheetId, title) {
  const sheets = sheetsApi();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title)',
  });
  const found = meta.data.sheets.find((s) => s.properties.title === title);
  if (found) return found.properties.sheetId;
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
  return res.data.replies[0].addSheet.properties.sheetId;
}
