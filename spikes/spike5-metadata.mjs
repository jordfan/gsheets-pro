// Spike 5: is PROJECT-visibility developer metadata a usable contract carrier?
//
// The plan hangs the column contract on developer metadata riding a column
// dimension. Four questions:
//   a. write PROJECT-visibility metadata on a column, read it back through
//      developerMetadata.search
//   b. read the same metadata through spreadsheets.get with a field mask
//   c. does it survive inserting a column to its LEFT (does the metadata move
//      with the column, or stay pinned to the old index)
//   d. does it survive File > Make a copy, which is drive.files.copy
//
// The cross-client question (can a Desktop OAuth client in the same GCP project
// see metadata written by the VM client) is NOT testable with one token; the
// report says so.
import { writeFileSync } from 'node:fs';
import { sheetsApi, driveApi, spikeSpreadsheetId, ensureTab } from './lib/auth.mjs';
import { outPath } from './lib/render.mjs';

const TAB = 'Spike5 Metadata';
const KEY = 'gsheets.column';

const report = { spike: 5, ranAt: new Date().toISOString(), steps: {} };
const sheets = sheetsApi();
const drive = driveApi();
const spreadsheetId = await spikeSpreadsheetId();
const sheetId = await ensureTab(spreadsheetId, TAB);

async function step(name, fn) {
  try {
    const value = await fn();
    report.steps[name] = { ok: true, ...value };
    console.log(`  OK   ${name}`);
    return value;
  } catch (err) {
    const d = err?.response?.data?.error;
    report.steps[name] = { ok: false, message: err?.message, apiStatus: d?.status, apiMessage: d?.message };
    console.log(`  FAIL ${name}: ${d?.message ?? err?.message}`);
    return null;
  }
}

// ---- seed a small grid so the columns are meaningful
await sheets.spreadsheets.values.update({
  spreadsheetId,
  range: `'${TAB}'!A1`,
  valueInputOption: 'USER_ENTERED',
  requestBody: {
    values: [
      ['Email', 'Instructor', 'Status'],
      ['n.okonkwo@example.org', 'Nadia Okonkwo', 'Confirmed'],
      ['e.sandoval@example.org', 'Emil Sandoval', 'Pending'],
    ],
  },
});

// ---- a. create PROJECT-visibility metadata on column B (index 1)
console.log('\n[a] createDeveloperMetadata on a COLUMN, PROJECT visibility');
const created = await step('a_create_project_visibility', async () => {
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          createDeveloperMetadata: {
            developerMetadata: {
              metadataKey: KEY,
              metadataValue: JSON.stringify({ logical: 'instructor', header: 'Instructor', role: 'input', owner: 'agent', type: 'TEXT' }),
              visibility: 'PROJECT',
              location: {
                dimensionRange: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 },
              },
            },
          },
        },
      ],
    },
  });
  const md = res.data.replies[0].createDeveloperMetadata.developerMetadata;
  return { metadataId: md.metadataId, visibility: md.visibility, location: md.location };
});

// ---- a2. read it back through developerMetadata.search
await step('a2_search_readback', async () => {
  const res = await sheets.spreadsheets.developerMetadata.search({
    spreadsheetId,
    requestBody: { dataFilters: [{ developerMetadataLookup: { metadataKey: KEY } }] },
  });
  const found = res.data.matchedDeveloperMetadata ?? [];
  return {
    count: found.length,
    entries: found.map((m) => ({
      id: m.developerMetadata.metadataId,
      visibility: m.developerMetadata.visibility,
      startIndex: m.developerMetadata.location?.dimensionRange?.startIndex,
      valuePreview: String(m.developerMetadata.metadataValue).slice(0, 60),
    })),
  };
});

// ---- b. read it through spreadsheets.get with developerMetadata in the mask
console.log('\n[b] spreadsheets.get with developerMetadata in the field mask');
await step('b_get_with_mask', async () => {
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'developerMetadata,sheets(properties.title,developerMetadata)',
  });
  const sheetLevel = res.data.sheets?.find((s) => s.properties.title === TAB)?.developerMetadata ?? [];
  return {
    spreadsheetLevelCount: (res.data.developerMetadata ?? []).length,
    sheetLevelCount: sheetLevel.length,
    sheetLevelEntries: sheetLevel.map((m) => ({ id: m.metadataId, startIndex: m.location?.dimensionRange?.startIndex })),
    note: 'column metadata surfaces under the sheet, not at spreadsheet level',
  };
});

// ---- c. insert a column to the LEFT and see whether the metadata follows
console.log('\n[c] insert a column to the left of the tagged column');
await step('c_insert_column_left', async () => {
  const beforeIdx = created?.location?.dimensionRange?.startIndex;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        { insertDimension: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, inheritFromBefore: false } },
      ],
    },
  });
  const res = await sheets.spreadsheets.developerMetadata.search({
    spreadsheetId,
    requestBody: { dataFilters: [{ developerMetadataLookup: { metadataKey: KEY } }] },
  });
  const m = (res.data.matchedDeveloperMetadata ?? [])[0]?.developerMetadata;
  const afterIdx = m?.location?.dimensionRange?.startIndex;
  // what header actually sits at the new index, to prove it tracked the data
  const vals = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${TAB}'!A1:D1` });
  return {
    startIndexBefore: beforeIdx,
    startIndexAfter: afterIdx,
    followedTheColumn: beforeIdx != null && afterIdx === beforeIdx + 1,
    headerRowNow: vals.data.values?.[0],
    headerAtMetadataIndex: vals.data.values?.[0]?.[afterIdx],
  };
});

// ---- d. does it survive a copy (the API equivalent of File > Make a copy)
console.log('\n[d] drive.files.copy, the File > Make a copy equivalent');
const copied = await step('d_copy_spreadsheet', async () => {
  const res = await drive.files.copy({
    fileId: spreadsheetId,
    requestBody: { name: 'gsheets-pro spike COPY (safe to delete)' },
  });
  const copyId = res.data.id;
  const search = await sheets.spreadsheets.developerMetadata.search({
    spreadsheetId: copyId,
    requestBody: { dataFilters: [{ developerMetadataLookup: { metadataKey: KEY } }] },
  });
  const found = search.data.matchedDeveloperMetadata ?? [];
  return {
    copyId,
    copyUrl: `https://docs.google.com/spreadsheets/d/${copyId}/edit`,
    metadataFoundInCopy: found.length,
    entries: found.map((m) => ({
      id: m.developerMetadata.metadataId,
      visibility: m.developerMetadata.visibility,
      startIndex: m.developerMetadata.location?.dimensionRange?.startIndex,
    })),
  };
});

// clean up the copy: it is an artifact of this spike, not something to leave behind
if (copied?.copyId) {
  await step('d2_trash_the_copy', async () => {
    await drive.files.update({ fileId: copied.copyId, requestBody: { trashed: true } });
    return { trashed: copied.copyId };
  });
}

// ---- e. what a DOCUMENT-visibility entry looks like next to a PROJECT one,
// since that is the fallback if PROJECT turns out to be unusable across clients
console.log('\n[e] a DOCUMENT-visibility entry for comparison');
await step('e_document_visibility', async () => {
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          createDeveloperMetadata: {
            developerMetadata: {
              metadataKey: 'gsheets.doc.probe',
              metadataValue: 'visible to any client that opens this file',
              visibility: 'DOCUMENT',
              location: { spreadsheet: true },
            },
          },
        },
      ],
    },
  });
  const md = res.data.replies[0].createDeveloperMetadata.developerMetadata;
  return { metadataId: md.metadataId, visibility: md.visibility };
});

report.notTestableHere =
  'Cross-client visibility (a second Desktop OAuth client in the same GCP project reading PROJECT metadata written by the VM client) needs two distinct OAuth clients. Only one token exists here, so this spike cannot answer it.';

writeFileSync(outPath('spike5-report.json'), JSON.stringify(report, null, 2));
console.log('\nreport: spikes/out/spike5-report.json');
console.log(report.notTestableHere);
