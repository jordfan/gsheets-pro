// Spike 1b: does the export URL's redirect hop actually need the bearer?
//
// The plan assumes Authorization must be re-attached across the redirect to
// googleusercontent.com. Once the URL itself was correct, the naive fetch
// succeeded too, which suggests the redirect target is a pre-signed URL that
// needs no header at all. Four cases settle it.
//
// Nothing here prints the redirect URL: it carries a credential-shaped token.
import { writeFileSync } from 'node:fs';
import { accessToken, spikeSpreadsheetId, sheetsApi } from './lib/auth.mjs';
import { exportUrl, outPath } from './lib/render.mjs';

const spreadsheetId = await spikeSpreadsheetId();
const sheets = sheetsApi();
const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(sheetId,title)' });
const gid = meta.data.sheets.find((s) => s.properties.title === 'Spike1 Render').properties.sheetId;
const url = exportUrl(spreadsheetId, { gid });
const token = await accessToken();

function verdict(res, buf) {
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    bytes: buf.length,
    isPdf: buf.subarray(0, 5).toString('latin1') === '%PDF-',
  };
}

const results = {};

// A. no Authorization at all. Expect a rejection: proves auth is required somewhere.
{
  const res = await fetch(url, { redirect: 'follow' });
  const buf = Buffer.from(await res.arrayBuffer());
  results.A_noAuthAtAll = verdict(res, buf);
}

// B. automatic redirect following, Authorization set on the initial request.
// Node's fetch strips Authorization on a cross-origin redirect, so if this
// yields a PDF the second hop did not need it.
{
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const buf = Buffer.from(await res.arrayBuffer());
  results.B_autoRedirect = verdict(res, buf);
}

// C. manual redirect, bearer deliberately NOT re-attached on hop 2.
{
  const first = await fetch(url, { redirect: 'manual', headers: { Authorization: `Bearer ${token}` } });
  const location = first.headers.get('location');
  results.C_manualNoReattach = { hop0Status: first.status, redirectHost: location ? new URL(location).host : null };
  if (location) {
    const second = await fetch(location, { redirect: 'follow' }); // no Authorization
    const buf = Buffer.from(await second.arrayBuffer());
    Object.assign(results.C_manualNoReattach, verdict(second, buf));
  }
}

// D. manual redirect, bearer re-attached on hop 2 (what lib/render.mjs does).
{
  const first = await fetch(url, { redirect: 'manual', headers: { Authorization: `Bearer ${token}` } });
  const location = first.headers.get('location');
  results.D_manualReattach = { hop0Status: first.status };
  if (location) {
    const second = await fetch(location, { redirect: 'follow', headers: { Authorization: `Bearer ${token}` } });
    const buf = Buffer.from(await second.arrayBuffer());
    Object.assign(results.D_manualReattach, verdict(second, buf));
  }
}

for (const [k, v] of Object.entries(results)) console.log(`${k.padEnd(22)} ${JSON.stringify(v)}`);
writeFileSync(outPath('spike1b-report.json'), JSON.stringify(results, null, 2));
