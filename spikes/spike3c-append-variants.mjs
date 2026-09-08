// Spike 3c: appendCells(tableId) came back empty in spike 3b. Find out why.
//
// Variants, all appending one fully-populated row to the same shape of Table:
//   v1  tableId, fields 'userEnteredValue'      (what 3b did)
//   v2  tableId, fields '*'
//   v3  sheetId, fields 'userEnteredValue'      (the non-Table path, as control)
//   v4  values.append with a Table present      (the values API, as control)
import { writeFileSync } from 'node:fs';
import { sheetsApi, spikeSpreadsheetId, ensureTab, resetTab } from './lib/auth.mjs';
import { outPath } from './lib/render.mjs';

const sheets = sheetsApi();
const spreadsheetId = await spikeSpreadsheetId();

function gr(sheetId, r1, c1, r2, c2) {
  return { sheetId, startRowIndex: r1, startColumnIndex: c1, endRowIndex: r2, endColumnIndex: c2 };
}

const seed = [
  ['Instructor', 'Vendor', 'Status', 'Sessions'],
  ['Nadia Okonkwo', 'Bright Circuits', 'Confirmed', 8],
  ['Emil Sandoval', 'Bright Circuits', 'Pending', 8],
];
const cols = [
  { columnIndex: 0, columnName: 'Instructor', columnType: 'TEXT' },
  { columnIndex: 1, columnName: 'Vendor', columnType: 'TEXT' },
  { columnIndex: 2, columnName: 'Status', columnType: 'TEXT' },
  { columnIndex: 3, columnName: 'Sessions', columnType: 'DOUBLE' },
];
const NEW_ROW = {
  values: [
    { userEnteredValue: { stringValue: 'Sable Adeyemi' } },
    { userEnteredValue: { stringValue: 'Clay & Kiln' } },
    { userEnteredValue: { stringValue: 'Pending' } },
    { userEnteredValue: { numberValue: 6 } },
  ],
};

async function setup(tab) {
  const sheetId = await ensureTab(spreadsheetId, tab);
  await resetTab(spreadsheetId, sheetId);
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `'${tab}'!A1`, valueInputOption: 'USER_ENTERED', requestBody: { values: seed },
  });
  const add = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        addTable: {
          table: {
            name: `T${tab.replace(/\W/g, '')}`,
            range: gr(sheetId, 0, 0, 3, 4),
            // no footerColorStyle: spike 3b showed it destroys the last data row
            rowsProperties: {
              headerColorStyle: { rgbColor: { red: 0.094, green: 0.439, blue: 0.329 } },
              firstBandColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } },
              secondBandColorStyle: { rgbColor: { red: 0.906, green: 0.965, blue: 0.945 } },
            },
            columnProperties: cols,
          },
        },
      }],
    },
  });
  return { sheetId, tableId: add.data.replies[0].addTable.table.tableId };
}

async function readBack(tab) {
  const v = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tab}'!A1:D8` });
  return v.data.values ?? [];
}

async function variant(label, tab, run) {
  const ctx = await setup(tab);
  let error = null;
  try {
    await run(ctx, tab);
  } catch (err) {
    error = err?.response?.data?.error?.message ?? err?.message;
  }
  const grid = await readBack(tab);
  const appended = grid[3] ?? [];
  const landed = appended[0] === 'Sable Adeyemi';
  console.log(`\n${label}`);
  console.log(`  row 4 -> ${JSON.stringify(appended)}`);
  console.log(`  values landed: ${landed}${error ? ` | ERROR: ${error}` : ''}`);
  return { label, tab, landed, appended, error };
}

const results = [];

results.push(await variant("v1  appendCells tableId, fields 'userEnteredValue'", 'Spike3c v1', async ({ tableId }) => {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ appendCells: { tableId, rows: [NEW_ROW], fields: 'userEnteredValue' } }] },
  });
}));

results.push(await variant("v2  appendCells tableId, fields '*'", 'Spike3c v2', async ({ tableId }) => {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ appendCells: { tableId, rows: [NEW_ROW], fields: '*' } }] },
  });
}));

results.push(await variant("v3  appendCells sheetId (control, no tableId)", 'Spike3c v3', async ({ sheetId }) => {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ appendCells: { sheetId, rows: [NEW_ROW], fields: 'userEnteredValue' } }] },
  });
}));

results.push(await variant('v4  values.append over the Table range', 'Spike3c v4', async (_ctx, tab) => {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${tab}'!A1:D3`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [['Sable Adeyemi', 'Clay & Kiln', 'Pending', 6]] },
  });
}));

console.log('\n=== summary ===');
for (const r of results) console.log(`  ${r.landed ? 'LANDED ' : 'DROPPED'}  ${r.label}`);
writeFileSync(outPath('spike3c-report.json'), JSON.stringify(results, null, 2));
