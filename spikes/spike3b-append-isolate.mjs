// Spike 3b: isolate what appendCells(tableId) actually does, and whether
// declaring footerColorStyle silently creates a footer row.
//
// The combined spike-3 run left a Table whose last row held SUM() over the
// Table's own structured references and whose appended values had vanished, so
// this dumps state after every single request instead of at the end.
import { writeFileSync } from 'node:fs';
import { sheetsApi, spikeSpreadsheetId, ensureTab, resetTab } from './lib/auth.mjs';
import { outPath } from './lib/render.mjs';

const sheets = sheetsApi();
const spreadsheetId = await spikeSpreadsheetId();

function gr(sheetId, r1, c1, r2, c2) {
  return { sheetId, startRowIndex: r1, startColumnIndex: c1, endRowIndex: r2, endColumnIndex: c2 };
}

async function dump(label, sheetId, tab) {
  const v = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tab}'!A1:E9`,
    valueRenderOption: 'FORMULA',
  });
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(sheetId,title),tables(tableId,name,range,rowsProperties))',
  });
  const s = meta.data.sheets.find((x) => x.properties.sheetId === sheetId);
  const t = s?.tables?.[0];
  const snapshot = {
    label,
    tableRange: t?.range ? `rows ${t.range.startRowIndex}..${t.range.endRowIndex}` : null,
    rowsPropertiesKeys: t?.rowsProperties ? Object.keys(t.rowsProperties) : null,
    grid: v.data.values ?? [],
  };
  console.log(`\n--- ${label} ---  table ${snapshot.tableRange}`);
  (snapshot.grid).forEach((r, i) => console.log(`  row ${i + 1} ${JSON.stringify(r)}`));
  return snapshot;
}

const seed = [
  ['Instructor', 'Vendor', 'Status', 'Sessions', 'Fee'],
  ['Nadia Okonkwo', 'Bright Circuits', 'Confirmed', 8, '=D2*55'],
  ['Emil Sandoval', 'Bright Circuits', 'Pending', 8, '=D3*55'],
  ['Thea Vasquez', 'Clay & Kiln', 'Confirmed', 6, '=D4*55'],
  ['Oren Whitfield', 'Clay & Kiln', 'Pending', 6, '=D5*55'],
];

const cols = [
  { columnIndex: 0, columnName: 'Instructor', columnType: 'TEXT' },
  { columnIndex: 1, columnName: 'Vendor', columnType: 'TEXT' },
  { columnIndex: 2, columnName: 'Status', columnType: 'DROPDOWN', dataValidationRule: { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'Confirmed' }, { userEnteredValue: 'Pending' }] } } },
  { columnIndex: 3, columnName: 'Sessions', columnType: 'DOUBLE' },
  { columnIndex: 4, columnName: 'Fee', columnType: 'CURRENCY' },
];

/**
 * One trial: build a Table (with or without footerColorStyle), then append.
 */
async function trial(tab, { withFooter }) {
  console.log(`\n\n======== ${tab} (footerColorStyle: ${withFooter}) ========`);
  const sheetId = await ensureTab(spreadsheetId, tab);
  await resetTab(spreadsheetId, sheetId);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tab}'!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: seed },
  });
  const snaps = [await dump('after seed, before Table', sheetId, tab)];

  const rowsProperties = {
    headerColorStyle: { rgbColor: { red: 0.094, green: 0.439, blue: 0.329 } },
    firstBandColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } },
    secondBandColorStyle: { rgbColor: { red: 0.906, green: 0.965, blue: 0.945 } },
  };
  if (withFooter) {
    rowsProperties.footerColorStyle = { rgbColor: { red: 0.85, green: 0.93, blue: 0.9 } };
  }

  const add = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addTable: { table: { name: `T_${tab.replace(/\W/g, '')}`, range: gr(sheetId, 0, 0, 5, 5), rowsProperties, columnProperties: cols } } }],
    },
  });
  const tableId = add.data.replies[0].addTable.table.tableId;
  snaps.push(await dump('after addTable', sheetId, tab));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          appendCells: {
            tableId,
            rows: [
              {
                values: [
                  { userEnteredValue: { stringValue: 'Sable Adeyemi' } },
                  { userEnteredValue: { stringValue: 'Clay & Kiln' } },
                  { userEnteredValue: { stringValue: 'Pending' } },
                  { userEnteredValue: { numberValue: 6 } },
                  { userEnteredValue: { formulaValue: '=D6*55' } },
                ],
              },
            ],
            fields: 'userEnteredValue',
          },
        },
      ],
    },
  });
  snaps.push(await dump('after appendCells(tableId)', sheetId, tab));
  return { tab, tableId, snaps };
}

const noFooter = await trial('Spike3b NoFooter', { withFooter: false });
const withFooter = await trial('Spike3b Footer', { withFooter: true });

writeFileSync(outPath('spike3b-report.json'), JSON.stringify({ noFooter, withFooter }, null, 2));
console.log('\nreport: spikes/out/spike3b-report.json');
