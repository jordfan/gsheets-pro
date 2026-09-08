// Move throwaway spike spreadsheets to the Drive trash, by exact title.
//
// Live tests and spikes create disposable spreadsheets and do not always clean
// up after themselves, so they accumulate in the owner's Drive. This trashes
// them safely.
//
//   node trash-spike-sheet.mjs "<exact title>"          list what would go
//   node trash-spike-sheet.mjs "<exact title>" --yes    actually trash them
//
// Guards, applied per file immediately before that file is touched:
//   - the title must match the argument EXACTLY, not a prefix or a substring
//   - the file must be a Google spreadsheet
//   - the file must be owned by the authenticated user
//   - files already trashed are skipped
// Anything failing a guard is reported and left alone. This trashes rather than
// deletes, so everything stays recoverable from Drive's trash.
//
// Drive's `name =` query is not case sensitive, so the exact-title check is
// repeated client side against the value read back for each individual file.
import { driveApi } from './lib/auth.mjs';

const SPREADSHEET = 'application/vnd.google-apps.spreadsheet';

const args = process.argv.slice(2);
const apply = args.includes('--yes');
const title = args.find((a) => !a.startsWith('--'));

if (!title) {
  console.error('usage: node trash-spike-sheet.mjs "<exact title>" [--yes]');
  process.exit(2);
}

const drive = driveApi();

// ---- find candidates by title, paging so nothing is missed
const candidates = [];
let pageToken;
do {
  const res = await drive.files.list({
    q: `name = '${title.replace(/'/g, "\\'")}' and mimeType = '${SPREADSHEET}' and trashed = false`,
    fields: 'nextPageToken, files(id,name,mimeType,trashed,ownedByMe,createdTime)',
    pageSize: 100,
    pageToken,
  });
  candidates.push(...(res.data.files ?? []));
  pageToken = res.data.nextPageToken;
} while (pageToken);

console.log(`Title requested: ${JSON.stringify(title)}`);
console.log(`Untrashed spreadsheets matching: ${candidates.length}`);
if (!candidates.length) process.exit(0);

if (!apply) {
  for (const f of candidates) {
    console.log(`  would trash  ${f.id}  created ${f.createdTime}  ownedByMe=${f.ownedByMe}`);
  }
  console.log('\nDry run. Re-run with --yes to trash these.');
  process.exit(0);
}

// ---- trash one at a time, re-verifying each file just before touching it
let trashed = 0;
const skipped = [];

for (const c of candidates) {
  const { data: f } = await drive.files.get({
    fileId: c.id,
    fields: 'id,name,mimeType,trashed,ownedByMe',
  });

  if (f.name !== title) {
    skipped.push(`${f.id}: title is ${JSON.stringify(f.name)}`);
    continue;
  }
  if (f.mimeType !== SPREADSHEET) {
    skipped.push(`${f.id}: not a spreadsheet (${f.mimeType})`);
    continue;
  }
  if (!f.ownedByMe) {
    skipped.push(`${f.id}: not owned by this account`);
    continue;
  }
  if (f.trashed) {
    skipped.push(`${f.id}: already trashed`);
    continue;
  }

  await drive.files.update({ fileId: f.id, requestBody: { trashed: true } });
  const { data: after } = await drive.files.get({ fileId: f.id, fields: 'id,trashed' });
  if (after.trashed) {
    trashed += 1;
    console.log(`  trashed ${f.id}`);
  } else {
    skipped.push(`${f.id}: update reported success but the file is not trashed`);
  }
}

console.log(`\nTrashed ${trashed} of ${candidates.length}. Recoverable from Drive trash.`);
if (skipped.length) {
  console.log(`Skipped ${skipped.length}:`);
  for (const s of skipped) console.log(`  ${s}`);
}
