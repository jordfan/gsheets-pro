// Spike 1: can we render a tab to a picture, and does the picture tell the
// truth about formatting?
//
// Builds a tab carrying the five things the plan cares about (merged title,
// frozen header, banding, a conditional-format fill, an API-created dropdown),
// then renders it through the undocumented export URL and through Drive's
// documented files.export, and reports what each one paints.
import { writeFileSync } from 'node:fs';
import { sheetsApi, spikeSpreadsheetId, ensureTab, grantedScopes, resetTab } from './lib/auth.mjs';
import { renderViaExportUrl, renderViaDriveExport, exportUrl, fetchAutoRedirect, outPath } from './lib/render.mjs';
import { accessToken } from './lib/auth.mjs';

const TAB = 'Spike1 Render';
const LONG_TAB = 'Spike1 Long';

// invented roster data
const NAMES = [
  ['Priya Ramanathan', 3, 'Enrolled'], ['Desmond Okafor', 4, 'Enrolled'],
  ['Wren Kalloch', 2, 'Waitlisted'], ['Tobias Lindqvist', 4, 'Enrolled'],
  ['Amara Silvestri', 3, 'Dropped'], ['Ines Bergeron', 1, 'Enrolled'],
  ['Caspian Duval', 4, 'Waitlisted'], ['Marisol Ferreira', 2, 'Enrolled'],
  ['Rafferty Nkemelu', 3, 'Enrolled'], ['Juniper Halvorsen', 1, 'Dropped'],
];

const HEADER = ['Student', 'Grade', 'Status', 'Sessions', 'Notes'];
const NOTE = ['needs early pickup', 'carpool with sibling', '', 'allergy on file', ''];

function gridRange(sheetId, r1, c1, r2, c2) {
  return { sheetId, startRowIndex: r1, startColumnIndex: c1, endRowIndex: r2, endColumnIndex: c2 };
}

async function buildTab(spreadsheetId) {
  const sheets = sheetsApi();
  const sheetId = await ensureTab(spreadsheetId, TAB);
  const rows = NAMES.length;
  const lastRow = 2 + rows; // header on row 2 (index 1), data starts index 2

  // start clean so reruns are idempotent. addBanding refuses to overlap an
  // existing banded range, and updateCells does not remove banding, so the
  // reset has to delete banding and conditional rules explicitly.
  await resetTab(spreadsheetId, sheetId);

  const requests = [
    // --- merged title cell across the five columns
    { mergeCells: { range: gridRange(sheetId, 0, 0, 1, 5), mergeType: 'MERGE_ALL' } },
    {
      repeatCell: {
        range: gridRange(sheetId, 0, 0, 1, 5),
        cell: {
          userEnteredFormat: {
            backgroundColorStyle: { rgbColor: { red: 0.094, green: 0.439, blue: 0.329 } },
            textFormat: { bold: true, fontSize: 14, foregroundColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } } },
            horizontalAlignment: 'LEFT',
            verticalAlignment: 'MIDDLE',
            padding: { left: 10, top: 6, bottom: 6, right: 10 },
          },
        },
        fields: 'userEnteredFormat(backgroundColorStyle,textFormat,horizontalAlignment,verticalAlignment,padding)',
      },
    },

    // --- header row styling
    {
      repeatCell: {
        range: gridRange(sheetId, 1, 0, 2, 5),
        cell: {
          userEnteredFormat: {
            backgroundColorStyle: { rgbColor: { red: 0.878, green: 0.945, blue: 0.925 } },
            textFormat: { bold: true },
          },
        },
        fields: 'userEnteredFormat(backgroundColorStyle,textFormat)',
      },
    },

    // --- frozen header: title row + header row
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 2 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },

    // --- banding over the data region
    {
      addBanding: {
        bandedRange: {
          range: gridRange(sheetId, 1, 0, lastRow, 5),
          rowProperties: {
            headerColorStyle: { rgbColor: { red: 0.878, green: 0.945, blue: 0.925 } },
            firstBandColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } },
            secondBandColorStyle: { rgbColor: { red: 0.957, green: 0.973, blue: 0.965 } },
          },
        },
      },
    },

    // --- API-created dropdown on the Status column
    {
      setDataValidation: {
        range: gridRange(sheetId, 2, 2, lastRow, 3),
        rule: {
          condition: {
            type: 'ONE_OF_LIST',
            values: [
              { userEnteredValue: 'Enrolled' },
              { userEnteredValue: 'Waitlisted' },
              { userEnteredValue: 'Dropped' },
            ],
          },
          showCustomUi: true,
          strict: true,
          inputMessage: 'Pick one. Waitlisted rows are reviewed each Friday.',
        },
      },
    },

    // --- conditional-format fills keyed on the Status text
    {
      addConditionalFormatRule: {
        index: 0,
        rule: {
          ranges: [gridRange(sheetId, 2, 0, lastRow, 5)],
          booleanRule: {
            condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=$C3="Waitlisted"' }] },
            format: { backgroundColorStyle: { rgbColor: { red: 0.996, green: 0.925, blue: 0.776 } } },
          },
        },
      },
    },
    {
      addConditionalFormatRule: {
        index: 0,
        rule: {
          ranges: [gridRange(sheetId, 2, 0, lastRow, 5)],
          booleanRule: {
            condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=$C3="Dropped"' }] },
            format: {
              backgroundColorStyle: { rgbColor: { red: 0.973, green: 0.827, blue: 0.788 } },
              textFormat: { strikethrough: true, foregroundColorStyle: { rgbColor: { red: 0.4, green: 0.15, blue: 0.1 } } },
            },
          },
        },
      },
    },

    // --- column widths, so the render is legible
    { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 190 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 3 }, properties: { pixelSize: 100 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 4, endIndex: 5 }, properties: { pixelSize: 200 }, fields: 'pixelSize' } },
  ];

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });

  // values second, so formatting is already in place
  const values = [
    ['Fall 2026 Robotics Club, Tuesday block'],
    HEADER,
    ...NAMES.map(([n, g, s], i) => [n, g, s, 8, NOTE[i % NOTE.length]]),
  ];
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${TAB}'!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
  return { sheetId, lastRow };
}

// A tall tab, purely to find out whether fzr=true repeats the frozen header
// on page two of the PDF.
async function buildLongTab(spreadsheetId) {
  const sheets = sheetsApi();
  const sheetId = await ensureTab(spreadsheetId, LONG_TAB);
  await resetTab(spreadsheetId, sheetId);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: gridRange(sheetId, 0, 0, 1, 3),
            cell: { userEnteredFormat: { backgroundColorStyle: { rgbColor: { red: 0.094, green: 0.439, blue: 0.329 } }, textFormat: { bold: true, foregroundColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } } } } },
            fields: 'userEnteredFormat(backgroundColorStyle,textFormat)',
          },
        },
        { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
      ],
    },
  });
  const rows = [['Row label (frozen header above)', 'Grade', 'Sessions']];
  for (let i = 1; i <= 120; i++) rows.push([`Participant ${String(i).padStart(3, '0')}`, (i % 4) + 1, 8]);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${LONG_TAB}'!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });
  return sheetId;
}

// ---- run
const report = { spike: 1, ranAt: new Date().toISOString() };

report.tokenScopes = await grantedScopes();
console.log('token scopes:', JSON.stringify(report.tokenScopes.scopes));

const spreadsheetId = await spikeSpreadsheetId();
const { sheetId, lastRow } = await buildTab(spreadsheetId);
const longSheetId = await buildLongTab(spreadsheetId);
console.log(`built tabs. gid(${TAB})=${sheetId} gid(${LONG_TAB})=${longSheetId}`);

// 1a. the naive call, to show why manual redirect handling is required
report.autoRedirect = await fetchAutoRedirect(exportUrl(spreadsheetId, { gid: sheetId }), await accessToken());
console.log('auto-redirect fetch:', JSON.stringify(report.autoRedirect, null, 2));

// 1b. the whole tab, manual redirect, bearer re-attached
report.wholeTab = await renderViaExportUrl(spreadsheetId, 'spike1-whole-tab', { gid: sheetId, dpi: 120 });
console.log('whole tab:', JSON.stringify({ ...report.wholeTab, trail: report.wholeTab.trail }, null, 2));

// 1c. a sub-range, to test r1/c1/r2/c2 (zero-based, end-exclusive)
report.subRange = await renderViaExportUrl(spreadsheetId, 'spike1-subrange', {
  gid: sheetId, r1: 0, c1: 0, r2: lastRow, c2: 5, dpi: 120,
});
console.log('sub-range:', JSON.stringify({ bytes: report.subRange.bytes, isPdf: report.subRange.isPdf, pngPaths: report.subRange.pngPaths }, null, 2));

// 1d. the tall tab, to test whether fzr repeats the header on page 2
report.frozenRepeat = await renderViaExportUrl(spreadsheetId, 'spike1-frozen', { gid: longSheetId, fzr: true, dpi: 96 });
console.log('frozen-repeat pages:', report.frozenRepeat.pngPaths.length);

// 1e. Drive files.export, the documented fallback
try {
  report.driveExport = await renderViaDriveExport(spreadsheetId, 'spike1-drive-export');
  console.log('drive export:', JSON.stringify({ bytes: report.driveExport.bytes, pages: report.driveExport.pngPaths.length }, null, 2));
} catch (err) {
  report.driveExport = { error: err?.message, code: err?.code };
  console.log('drive export FAILED:', report.driveExport.error);
}

writeFileSync(outPath('spike1-report.json'), JSON.stringify(report, null, 2));
console.log('\nPNGs to look at:');
for (const k of ['wholeTab', 'subRange', 'frozenRepeat', 'driveExport']) {
  for (const p of report[k]?.pngPaths ?? []) console.log('  ' + p);
}
