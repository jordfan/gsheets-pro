// Spike 4: does rewriting a dropdown with an IDENTICAL condition preserve the
// chip colors a human set in the UI?
//
// This is the one spike that needs a human in the loop, because the API has no
// color field on any validation rule, so the colors can only be set by hand.
//
// Two phases:
//   node spike4-chip-colors.mjs setup     -> creates the dropdown, prints the
//                                            60-second UI step for Jordan
//   node spike4-chip-colors.mjs verify    -> re-applies setDataValidation with
//                                            a byte-identical condition and
//                                            reports whether colors survived
//
// "Colors survived" cannot be read back through the API (there is no field), so
// verify captures what IS readable and renders the tab before and after, and
// the answer is settled by looking at the two PNGs.
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { sheetsApi, spikeSpreadsheetId, ensureTab, readState, writeState, resetTab } from './lib/auth.mjs';
import { renderViaExportUrl, outPath } from './lib/render.mjs';

const TAB = 'Spike4 Chips';
const mode = process.argv[2] ?? 'setup';

function gr(sheetId, r1, c1, r2, c2) {
  return { sheetId, startRowIndex: r1, startColumnIndex: c1, endRowIndex: r2, endColumnIndex: c2 };
}

// The condition is defined ONCE and used by both phases, so the rewrite is
// provably identical to what the API originally wrote.
const CONDITION = {
  type: 'ONE_OF_LIST',
  values: [
    { userEnteredValue: 'Confirmed' },
    { userEnteredValue: 'Pending' },
    { userEnteredValue: 'Declined' },
  ],
};
const RULE = { condition: CONDITION, showCustomUi: true, strict: true };

const sheets = sheetsApi();
const spreadsheetId = await spikeSpreadsheetId();
const sheetId = await ensureTab(spreadsheetId, TAB);
const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheetId}`;

/** Everything about the rule the API is willing to tell us. */
async function readRule() {
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    ranges: [`'${TAB}'!B2:B7`],
    includeGridData: true,
    fields: 'sheets.data.rowData.values(dataValidation,effectiveFormat.backgroundColorStyle,userEnteredValue)',
  });
  const rows = res.data.sheets[0].data[0].rowData ?? [];
  return rows.map((r, i) => {
    const v = r.values?.[0];
    return {
      row: i + 2,
      value: v?.userEnteredValue?.stringValue,
      condition: v?.dataValidation?.condition?.type,
      options: v?.dataValidation?.condition?.values?.map((x) => x.userEnteredValue),
      showCustomUi: v?.dataValidation?.showCustomUi,
      strict: v?.dataValidation?.strict,
      // if chip colors ever became readable, they would surface here
      allValidationKeys: v?.dataValidation ? Object.keys(v.dataValidation) : null,
      cellBackground: v?.effectiveFormat?.backgroundColorStyle?.rgbColor,
    };
  });
}

if (mode === 'setup') {
  await resetTab(spreadsheetId, sheetId);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: gr(sheetId, 0, 0, 1, 2),
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat.textFormat',
          },
        },
        { setDataValidation: { range: gr(sheetId, 1, 1, 7, 2), rule: RULE } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 2 }, properties: { pixelSize: 180 }, fields: 'pixelSize' } },
      ],
    },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${TAB}'!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [
        ['Contract', 'Status'],
        ['Bright Circuits, robotics', 'Confirmed'],
        ['Clay & Kiln, ceramics', 'Pending'],
        ['Northgate Chess', 'Declined'],
        ['Riverbend Dance', 'Confirmed'],
        ['Alder Lane Theatre', 'Pending'],
        ['Summit Fencing', 'Declined'],
      ],
    },
  });

  const before = await readRule();
  const render = await renderViaExportUrl(spreadsheetId, 'spike4-before-ui-colors', { gid: sheetId, dpi: 140 });
  writeState({ spike4: { sheetId, tab: TAB, setupAt: new Date().toISOString(), beforeRule: before } });
  writeFileSync(outPath('spike4-setup.json'), JSON.stringify({ url, before, render: { pngPaths: render.pngPaths } }, null, 2));

  console.log(`
=== Spike 4 setup done. The dropdown was created by the API, uncolored. ===

The 60-second step for Jordan, then run: node spike4-chip-colors.mjs verify

  1. Open ${url}
  2. Click cell B2, then Data > Data validation in the menu.
  3. Click the rule in the side panel to open it.
  4. Under the option list, give TWO of the three options a color: set
     "Confirmed" to green and "Declined" to red. Leave "Pending" uncolored,
     so the run has an untouched control to compare against.
  5. Set "Display style" to Chip.
  6. Click Done.

Before PNG (API-created, no colors): ${render.pngPaths.join(', ')}
`);
} else if (mode === 'verify') {
  const state = readState();
  const before = state.spike4?.beforeRule;
  if (!before) {
    console.log('No setup state found. Run: node spike4-chip-colors.mjs setup');
    process.exit(1);
  }

  // what the API can see AFTER the human colored the chips, but BEFORE we rewrite
  const afterHuman = await readRule();
  const humanRender = await renderViaExportUrl(spreadsheetId, 'spike4-after-ui-colors', { gid: sheetId, dpi: 140 });

  // the rewrite under test: byte-identical condition, same range
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ setDataValidation: { range: gr(sheetId, 1, 1, 7, 2), rule: RULE } }] },
  });

  const afterRewrite = await readRule();
  const rewriteRender = await renderViaExportUrl(spreadsheetId, 'spike4-after-rewrite', { gid: sheetId, dpi: 140 });

  const apiSawAnyColorField = [...afterHuman, ...afterRewrite].some(
    (r) => r.allValidationKeys && r.allValidationKeys.some((k) => /color|chip|display/i.test(k)),
  );

  const out = {
    spike: 4,
    url,
    apiSawAnyColorField,
    validationKeysObserved: [...new Set([...afterHuman, ...afterRewrite].flatMap((r) => r.allValidationKeys ?? []))],
    before,
    afterHuman,
    afterRewrite,
    renders: {
      beforeUiColors: 'spikes/out/spike4-before-ui-colors-1.png',
      afterUiColors: humanRender.pngPaths,
      afterRewrite: rewriteRender.pngPaths,
    },
  };
  writeFileSync(outPath('spike4-verify.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.log(`
Compare these two PNGs to settle the spike:
  after the human colored chips: ${humanRender.pngPaths.join(', ')}
  after the identical rewrite:   ${rewriteRender.pngPaths.join(', ')}
If the colors are gone in the second, setDataValidation wipes UI chip colors and
the plugin must never rewrite a ui_owned rule without force.
`);
} else {
  console.log('usage: node spike4-chip-colors.mjs [setup|verify]');
  process.exit(1);
}
