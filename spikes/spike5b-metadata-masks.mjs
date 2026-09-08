// Spike 5b: spreadsheets.get with `developerMetadata` in the mask returned
// nothing for COLUMN-location metadata. Is the mask wrong, or is column
// metadata search-only?
//
// Writes one entry at each of the three location types and then reads with
// several masks, so sheets_open knows exactly which call it must make.
import { writeFileSync } from 'node:fs';
import { sheetsApi, spikeSpreadsheetId, ensureTab, resetTab } from './lib/auth.mjs';
import { outPath } from './lib/render.mjs';

const TAB = 'Spike5b Masks';
const sheets = sheetsApi();
const spreadsheetId = await spikeSpreadsheetId();
const sheetId = await ensureTab(spreadsheetId, TAB);
await resetTab(spreadsheetId, sheetId);

await sheets.spreadsheets.values.update({
  spreadsheetId, range: `'${TAB}'!A1`, valueInputOption: 'USER_ENTERED',
  requestBody: { values: [['Email', 'Instructor', 'Status']] },
});

// clear any entries left by a previous run so counts are meaningful
const existing = await sheets.spreadsheets.developerMetadata.search({
  spreadsheetId, requestBody: { dataFilters: [{ developerMetadataLookup: { metadataKey: 'spike5b' } }] },
});
const stale = (existing.data.matchedDeveloperMetadata ?? []).map((m) => ({
  deleteDeveloperMetadata: { dataFilter: { developerMetadataLookup: { metadataId: m.developerMetadata.metadataId } } },
}));
if (stale.length) await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: stale } });

const requests = [
  {
    createDeveloperMetadata: {
      developerMetadata: {
        metadataKey: 'spike5b', metadataValue: 'column-location', visibility: 'PROJECT',
        location: { dimensionRange: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 } },
      },
    },
  },
  {
    createDeveloperMetadata: {
      developerMetadata: {
        metadataKey: 'spike5b', metadataValue: 'sheet-location', visibility: 'PROJECT',
        location: { sheetId },
      },
    },
  },
  {
    createDeveloperMetadata: {
      developerMetadata: {
        metadataKey: 'spike5b', metadataValue: 'spreadsheet-location', visibility: 'PROJECT',
        location: { spreadsheet: true },
      },
    },
  },
];
await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });

const masks = [
  'developerMetadata',
  'sheets.developerMetadata',
  'developerMetadata,sheets.developerMetadata',
  'sheets(properties.title,developerMetadata)',
  'sheets.data.columnMetadata.developerMetadata',
  'sheets(properties.title,data.columnMetadata.developerMetadata)',
];

const out = { masks: {} };
for (const mask of masks) {
  try {
    const res = await sheets.spreadsheets.get({ spreadsheetId, fields: mask, ranges: [`'${TAB}'!A1:C1`] });
    const top = (res.data.developerMetadata ?? []).map((m) => m.metadataValue);
    const bySheet = (res.data.sheets ?? []).flatMap((s) => (s.developerMetadata ?? []).map((m) => m.metadataValue));
    const byColumn = (res.data.sheets ?? []).flatMap((s) =>
      (s.data ?? []).flatMap((d) => (d.columnMetadata ?? []).flatMap((c) => (c.developerMetadata ?? []).map((m) => m.metadataValue))),
    );
    out.masks[mask] = { spreadsheetLevel: top, sheetLevel: bySheet, columnLevel: byColumn };
    console.log(`\nmask: ${mask}`);
    console.log(`  spreadsheet-level: ${JSON.stringify(top)}`);
    console.log(`  sheet-level:       ${JSON.stringify(bySheet)}`);
    console.log(`  column-level:      ${JSON.stringify(byColumn)}`);
  } catch (err) {
    const msg = err?.response?.data?.error?.message ?? err?.message;
    out.masks[mask] = { error: msg };
    console.log(`\nmask: ${mask}\n  ERROR: ${msg}`);
  }
}

const search = await sheets.spreadsheets.developerMetadata.search({
  spreadsheetId, requestBody: { dataFilters: [{ developerMetadataLookup: { metadataKey: 'spike5b' } }] },
});
out.search = (search.data.matchedDeveloperMetadata ?? []).map((m) => ({
  value: m.developerMetadata.metadataValue,
  locationType: m.developerMetadata.location?.locationType,
}));
console.log(`\ndeveloperMetadata.search found: ${JSON.stringify(out.search)}`);

writeFileSync(outPath('spike5b-report.json'), JSON.stringify(out, null, 2));
