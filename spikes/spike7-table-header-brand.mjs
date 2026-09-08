// Spike 7: why does the export brand SOME native Table headers and not others?
//
// The golden demo renders every header as "Student [1]" ... "Check [10]", each
// with a column-type icon, while spike 3's Table renders "Instructor",
// "Vendor", "Status" clean with an icon on the dropdown only. Both are native
// Tables with typed columns. Neither stores a bracket anywhere: the header
// cells and the Table's own columnName values are plain in both.
//
// So something the plugin does to a Table, and spike 3 does not, flips the
// export into painting full header chrome. Four candidates, one per tab, each
// added to an otherwise identical spike-3-shaped baseline:
//
//   base     addTable over written headers. Nothing else. Expect clean.
//   notes    + a note on every header cell
//   protect  + a warning-only protected range over the header row
//   freeze   + frozenRowCount 1
//   repaint  + a repeatCell over the header row (fill and bold), which is what
//              applying a preset does
//
// Render all five and look. Whichever one brands is the answer; if none does,
// it is a combination and the next run pairs them.
import { writeFileSync } from 'node:fs';
import { sheetsApi, spikeSpreadsheetId, ensureTab, resetTab } from './lib/auth.mjs';
import { renderViaExportUrl, outPath } from './lib/render.mjs';

const HEADERS = ['Instructor', 'Vendor', 'Status', 'Sessions', 'Fee'];
const ROWS = [
  ['Nadia Okonkwo', 'Bright Circuits', 'Confirmed', 8, '=D2*55'],
  ['Emil Sandoval', 'Bright Circuits', 'Pending', 8, '=D3*55'],
  ['Thea Vasquez', 'Clay & Kiln', 'Confirmed', 6, '=D4*55'],
];
const LAST_ROW = ROWS.length + 1; // header + data

/** The variants, in the order they are built and rendered. */
const VARIANTS = ['base', 'notes', 'protect', 'freeze', 'repaint'];

const report = { spike: 7, ranAt: new Date().toISOString(), variants: {} };
const sheets = sheetsApi();
const spreadsheetId = await spikeSpreadsheetId();

function gr(sheetId, r1, c1, r2, c2) {
  return { sheetId, startRowIndex: r1, startColumnIndex: c1, endRowIndex: r2, endColumnIndex: c2 };
}

function columnProperties() {
  return [
    { columnIndex: 0, columnName: 'Instructor', columnType: 'TEXT' },
    { columnIndex: 1, columnName: 'Vendor', columnType: 'TEXT' },
    {
      columnIndex: 2,
      columnName: 'Status',
      columnType: 'DROPDOWN',
      dataValidationRule: {
        condition: {
          type: 'ONE_OF_LIST',
          values: [{ userEnteredValue: 'Confirmed' }, { userEnteredValue: 'Pending' }],
        },
      },
    },
    { columnIndex: 3, columnName: 'Sessions', columnType: 'DOUBLE' },
    { columnIndex: 4, columnName: 'Fee', columnType: 'CURRENCY' },
  ];
}

/** The one extra request that distinguishes this variant from `base`. */
function extraRequests(variant, sheetId) {
  switch (variant) {
    case 'notes':
      return [
        {
          updateCells: {
            range: gr(sheetId, 0, 0, 1, HEADERS.length),
            rows: [{ values: HEADERS.map((h) => ({ note: `What belongs in ${h}.` })) }],
            fields: 'note',
          },
        },
      ];
    case 'protect':
      return [
        {
          addProtectedRange: {
            protectedRange: {
              range: gr(sheetId, 0, 0, 1, HEADERS.length),
              description: 'Header row',
              warningOnly: true,
            },
          },
        },
      ];
    case 'freeze':
      return [
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount',
          },
        },
      ];
    case 'repaint':
      return [
        {
          repeatCell: {
            range: gr(sheetId, 0, 0, 1, HEADERS.length),
            cell: {
              userEnteredFormat: {
                backgroundColorStyle: { rgbColor: { red: 0.094, green: 0.439, blue: 0.329 } },
                textFormat: { bold: true, foregroundColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } } },
              },
            },
            fields: 'userEnteredFormat(backgroundColorStyle,textFormat)',
          },
        },
      ];
    default:
      return [];
  }
}

for (const variant of VARIANTS) {
  const title = `Spike7 ${variant}`;
  console.log(`\n[${variant}]`);
  const sheetId = await ensureTab(spreadsheetId, title);
  await resetTab(spreadsheetId, sheetId);

  // Same seed for every variant: header row written first, then the data.
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${title}'!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [HEADERS, ...ROWS] },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addTable: {
            table: {
              name: `Spike7${variant}`,
              range: gr(sheetId, 0, 0, LAST_ROW, HEADERS.length),
              columnProperties: columnProperties(),
            },
          },
        },
        ...extraRequests(variant, sheetId),
      ],
    },
  });

  const render = await renderViaExportUrl(spreadsheetId, `spike7-${variant}`, {
    gid: sheetId,
    dpi: 120,
    fzr: true,
  });
  report.variants[variant] = {
    sheetId,
    isPdf: render.isPdf,
    pngPaths: render.pngPaths,
  };
  console.log(`  rendered -> ${render.pngPaths.join(', ')}`);
}

writeFileSync(outPath('spike7-report.json'), JSON.stringify(report, null, 2));
console.log('\nNow look at the five PNGs. The one whose headers read "Instructor [1]" is the cause.');
