// Spike 3: native Tables.
//
// Five questions, in the order that would sink the plan fastest:
//  a. does addTable work over a range that ALREADY has formatting and formulas
//  b. does updateTable replace the options on a DROPDOWN column
//  c. are TableRowsProperties header and band colors actually honored
//  d. does appendCells with tableId add a row inside the Table
//  e. does setBasicFilter with tableId attach to the Table's range
// Then render the result and look at it.
import { writeFileSync } from 'node:fs';
import { sheetsApi, spikeSpreadsheetId, ensureTab, resetTab } from './lib/auth.mjs';
import { renderViaExportUrl, outPath } from './lib/render.mjs';

const TAB = 'Spike3 Tables';

function gr(sheetId, r1, c1, r2, c2) {
  return { sheetId, startRowIndex: r1, startColumnIndex: c1, endRowIndex: r2, endColumnIndex: c2 };
}

const report = { spike: 3, ranAt: new Date().toISOString(), steps: {} };
const sheets = sheetsApi();
const spreadsheetId = await spikeSpreadsheetId();
const sheetId = await ensureTab(spreadsheetId, TAB);

async function step(name, fn) {
  try {
    const value = await fn();
    report.steps[name] = { ok: true, ...value };
    console.log(`  OK   ${name}`);
    return value;
  } catch (err) {
    const detail = err?.response?.data?.error;
    report.steps[name] = {
      ok: false,
      message: err?.message,
      apiStatus: detail?.status,
      apiMessage: detail?.message,
    };
    console.log(`  FAIL ${name}: ${detail?.message ?? err?.message}`);
    return null;
  }
}

// ---- pre-state: formatting and a formula in the range BEFORE the Table exists.
// If addTable refuses or silently wipes these, that is the finding.
console.log('\n[pre] formatted range with a formula, before any Table exists');
await resetTab(spreadsheetId, sheetId);
await step('pre_format_and_formula', async () => {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: gr(sheetId, 0, 0, 1, 5),
            cell: { userEnteredFormat: { textFormat: { bold: true, italic: true }, backgroundColorStyle: { rgbColor: { red: 0.98, green: 0.86, blue: 0.6 } } } },
            fields: 'userEnteredFormat(textFormat,backgroundColorStyle)',
          },
        },
        // a distinctive pre-existing fill on one data cell, to see if it survives
        {
          repeatCell: {
            range: gr(sheetId, 2, 0, 3, 1),
            cell: { userEnteredFormat: { backgroundColorStyle: { rgbColor: { red: 0.85, green: 0.75, blue: 0.98 } } } },
            fields: 'userEnteredFormat.backgroundColorStyle',
          },
        },
      ],
    },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${TAB}'!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [
        ['Instructor', 'Vendor', 'Status', 'Sessions', 'Fee'],
        ['Nadia Okonkwo', 'Bright Circuits', 'Confirmed', 8, '=D2*55'],
        ['Emil Sandoval', 'Bright Circuits', 'Pending', 8, '=D3*55'],
        ['Thea Vasquez', 'Clay & Kiln', 'Confirmed', 6, '=D4*55'],
        ['Oren Whitfield', 'Clay & Kiln', 'Pending', 6, '=D5*55'],
      ],
    },
  });
  const before = await sheets.spreadsheets.get({
    spreadsheetId,
    ranges: [`'${TAB}'!A1:E5`],
    includeGridData: true,
    fields: 'sheets.data.rowData.values(userEnteredValue,effectiveFormat.backgroundColorStyle,userEnteredFormat.textFormat)',
  });
  const cells = before.data.sheets[0].data[0].rowData;
  return {
    formulaInE2: cells[1].values[4].userEnteredValue?.formulaValue,
    headerBoldItalic: cells[0].values[0].userEnteredFormat?.textFormat,
    a3Fill: cells[2].values[0].effectiveFormat?.backgroundColorStyle?.rgbColor,
  };
});

// ---- a. addTable over that formatted, formula-bearing range
console.log('\n[a] addTable over a formatted range that holds formulas');
const added = await step('a_addTable_over_formatted', async () => {
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addTable: {
            table: {
              name: 'Instructors',
              range: gr(sheetId, 0, 0, 5, 5),
              rowsProperties: {
                headerColorStyle: { rgbColor: { red: 0.094, green: 0.439, blue: 0.329 } },
                firstBandColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } },
                secondBandColorStyle: { rgbColor: { red: 0.906, green: 0.965, blue: 0.945 } },
                footerColorStyle: { rgbColor: { red: 0.85, green: 0.93, blue: 0.9 } },
              },
              columnProperties: [
                { columnIndex: 0, columnName: 'Instructor', columnType: 'TEXT' },
                { columnIndex: 1, columnName: 'Vendor', columnType: 'TEXT' },
                {
                  columnIndex: 2,
                  columnName: 'Status',
                  columnType: 'DROPDOWN',
                  dataValidationRule: {
                    condition: {
                      type: 'ONE_OF_LIST',
                      values: [
                        { userEnteredValue: 'Confirmed' },
                        { userEnteredValue: 'Pending' },
                      ],
                    },
                  },
                },
                { columnIndex: 3, columnName: 'Sessions', columnType: 'DOUBLE' },
                { columnIndex: 4, columnName: 'Fee', columnType: 'CURRENCY' },
              ],
            },
          },
        },
      ],
    },
  });
  const t = res.data.replies[0].addTable.table;
  return { tableId: t.tableId, name: t.name, range: t.range, columnTypes: t.columnProperties?.map((c) => `${c.columnName}:${c.columnType}`) };
});

// did the pre-existing formula and the odd purple fill survive the Table?
await step('a_after_addTable_state', async () => {
  const after = await sheets.spreadsheets.get({
    spreadsheetId,
    ranges: [`'${TAB}'!A1:E5`],
    includeGridData: true,
    fields: 'sheets.data.rowData.values(userEnteredValue,effectiveValue,effectiveFormat.backgroundColorStyle)',
  });
  const rows = after.data.sheets[0].data[0].rowData;
  return {
    formulaStillThere: rows[1].values[4].userEnteredValue?.formulaValue,
    formulaValue: rows[1].values[4].effectiveValue?.numberValue,
    headerFillNow: rows[0].values[0].effectiveFormat?.backgroundColorStyle?.rgbColor,
    a3FillNow: rows[2].values[0].effectiveFormat?.backgroundColorStyle?.rgbColor,
    bandRow2Fill: rows[2].values[1].effectiveFormat?.backgroundColorStyle?.rgbColor,
  };
});

const tableId = added?.tableId;

// ---- b. updateTable replacing the DROPDOWN options
console.log('\n[b] updateTable replacing DROPDOWN options');
await step('b_updateTable_dropdown_options', async () => {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          updateTable: {
            table: {
              tableId,
              columnProperties: [
                {
                  columnIndex: 2,
                  columnName: 'Status',
                  columnType: 'DROPDOWN',
                  dataValidationRule: {
                    condition: {
                      type: 'ONE_OF_LIST',
                      values: [
                        { userEnteredValue: 'Confirmed' },
                        { userEnteredValue: 'Pending' },
                        { userEnteredValue: 'Declined' },
                        { userEnteredValue: 'On hold' },
                      ],
                    },
                  },
                },
              ],
            },
            fields: 'columnProperties',
          },
        },
      ],
    },
  });
  const check = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.tables(tableId,name,columnProperties)',
  });
  const t = check.data.sheets.flatMap((s) => s.tables ?? []).find((x) => x.tableId === tableId);
  const status = t?.columnProperties?.find((c) => c.columnIndex === 2);
  return { optionsNow: status?.dataValidationRule?.condition?.values?.map((v) => v.userEnteredValue) };
});

// does the cell-level validation follow the Table column definition?
await step('b_cell_validation_follows_table', async () => {
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    ranges: [`'${TAB}'!C2:C5`],
    includeGridData: true,
    fields: 'sheets.data.rowData.values.dataValidation',
  });
  const dv = res.data.sheets[0].data[0].rowData?.[0]?.values?.[0]?.dataValidation;
  return { cellCondition: dv?.condition?.type, cellOptions: dv?.condition?.values?.map((v) => v.userEnteredValue) };
});

// ---- c. TableRowsProperties colors honored (read back the effective fills)
console.log('\n[c] TableRowsProperties header and band colors');
await step('c_rows_properties_effective', async () => {
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    ranges: [`'${TAB}'!A1:E5`],
    includeGridData: true,
    fields: 'sheets.data.rowData.values.effectiveFormat.backgroundColorStyle',
  });
  const rows = res.data.sheets[0].data[0].rowData;
  const fill = (r, c) => rows[r]?.values?.[c]?.effectiveFormat?.backgroundColorStyle?.rgbColor;
  const declared = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.tables(tableId,rowsProperties)' });
  const t = declared.data.sheets.flatMap((s) => s.tables ?? []).find((x) => x.tableId === tableId);
  return {
    declaredRowsProperties: t?.rowsProperties,
    headerFill: fill(0, 0),
    band1Fill: fill(1, 0),
    band2Fill: fill(2, 0),
    band3Fill: fill(3, 0),
  };
});

// ---- d. appendCells with tableId
console.log('\n[d] appendCells with tableId');
await step('d_appendCells_tableId', async () => {
  const beforeMeta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.tables(tableId,range)' });
  const beforeRange = beforeMeta.data.sheets.flatMap((s) => s.tables ?? []).find((x) => x.tableId === tableId)?.range;
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
                  { userEnteredValue: { stringValue: 'On hold' } },
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
  const afterMeta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.tables(tableId,range)' });
  const afterRange = afterMeta.data.sheets.flatMap((s) => s.tables ?? []).find((x) => x.tableId === tableId)?.range;
  const vals = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${TAB}'!A6:E6` });
  return { beforeEndRow: beforeRange?.endRowIndex, afterEndRow: afterRange?.endRowIndex, newRow: vals.data.values?.[0] };
});

// ---- e. setBasicFilter with tableId
console.log('\n[e] setBasicFilter with tableId');
await step('e_setBasicFilter_tableId', async () => {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ setBasicFilter: { filter: { tableId } } }] },
  });
  const res = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties.title,basicFilter,tables(tableId,range))' });
  const s = res.data.sheets.find((x) => x.properties.title === TAB);
  return { basicFilter: s?.basicFilter, tableRange: s?.tables?.[0]?.range };
});

// ---- render and look
console.log('\n[render] export the Table tab so we can see it');
const render = await renderViaExportUrl(spreadsheetId, 'spike3-tables', { gid: sheetId, dpi: 120 });
report.render = { isPdf: render.isPdf, bytes: render.bytes, pngPaths: render.pngPaths };
console.log('  PNG:', render.pngPaths.join(', ') || '(none)');

writeFileSync(outPath('spike3-report.json'), JSON.stringify(report, null, 2));
console.log('\nreport: spikes/out/spike3-report.json');
