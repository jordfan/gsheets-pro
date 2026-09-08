// Fetch an OAuth token file and client file out of Google Secret Manager into
// spikes/.secrets/ so the live spikes can run. Uses Application Default
// Credentials. Writes files, prints only byte counts, never the payload.
//
// Configure with environment variables; nothing about any deployment lives in
// this repo:
//   SPIKE_GCP_PROJECT   the GCP project that holds the secrets
//   SPIKE_TOKEN_SECRET  secret holding a google-auth Credentials.to_json() file
//   SPIKE_OAUTH_SECRET  secret holding the Desktop OAuth client JSON
// The files land as spikes/.secrets/sheets-mcp-token.json and
// spikes/.secrets/sheets-mcp-oauth-keys.json, which is what spikes/lib/auth.mjs reads.
import { writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { GoogleAuth } from 'google-auth-library';

const PROJECT = process.env.SPIKE_GCP_PROJECT;
const SECRETS = {
  'sheets-mcp-token': process.env.SPIKE_TOKEN_SECRET,
  'sheets-mcp-oauth-keys': process.env.SPIKE_OAUTH_SECRET,
};
const missing = [
  !PROJECT && 'SPIKE_GCP_PROJECT',
  !SECRETS['sheets-mcp-token'] && 'SPIKE_TOKEN_SECRET',
  !SECRETS['sheets-mcp-oauth-keys'] && 'SPIKE_OAUTH_SECRET',
].filter(Boolean);
if (missing.length) {
  console.error(`Set ${missing.join(', ')} before running this script.`);
  process.exit(2);
}

const OUT = new URL('./.secrets/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const client = await auth.getClient();

for (const [localName, secretName] of Object.entries(SECRETS)) {
  const url = `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${secretName}/versions/latest:access`;
  const res = await client.request({ url });
  const payload = Buffer.from(res.data.payload.data, 'base64').toString('utf8');
  const file = new URL(`${localName}.json`, OUT);
  writeFileSync(file, payload);
  chmodSync(file, 0o600);
  console.log(`${localName}: wrote ${payload.length} bytes`);
}
