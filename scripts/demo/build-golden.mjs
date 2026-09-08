#!/usr/bin/env node
/**
 * Builds the golden demo spreadsheet: the one the README screenshots and the
 * skill points at as "this is what good looks like".
 *
 * It is deliberately not a fixture generator. It drives the shipped stdio
 * server over real MCP, calling the same thirteen tools a session calls, in the
 * order the skill tells a session to call them. So if the tool surface drifts,
 * or the preset stops compiling, or `fill` stops adjusting references, this
 * script fails rather than the README quietly becoming a lie.
 *
 * Every name, address, instrument and number in here is invented.
 *
 * Run it:
 *
 *   GSHEETS_PRO_TOKEN_FILE=$PWD/spikes/.secrets/sheets-mcp-token.json \
 *   GSHEETS_PRO_OAUTH_CLIENT=$PWD/spikes/.secrets/sheets-mcp-oauth-keys.json \
 *   node scripts/demo/build-golden.mjs
 *
 * It creates a NEW spreadsheet every time and prints its URL. It never opens,
 * reads, or writes any spreadsheet that already exists, so there is no id to
 * pass in and no way to point it at something that matters by mistake. The one
 * file it writes is the render, at docs/images/golden-roster.png.
 *
 * Roughly a dozen API calls, well inside the sixty-a-minute quota, but it does
 * share that quota with the live vitest suite. Do not run both at once.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const SERVER = path.join(REPO, "dist", "cli.js");
const RENDER_OUT = path.join(REPO, "docs", "images", "golden-roster.png");

const TITLE = `gsheets-pro: Rivermill private lessons (demo, ${new Date()
  .toISOString()
  .slice(0, 10)})`;

// ---------------------------------------------------------------------------
// The content. Invented, and deliberately shaped to show every claim the skill
// makes: an assumption with a source, a typed Table, a status column worded for
// a stranger, a formula column filled from one cell, and a Check column that
// makes the sheet audit itself.
// ---------------------------------------------------------------------------

/** Plain sentences, so a colleague opening this cold knows what each means. */
const STATUS_OPTIONS = [
  "Interest noted, details still to come",
  "Details in, no time offered yet",
  "Time offered, waiting to hear back",
  "Time confirmed by the family",
  "Waitlisted for this term",
  "Not continuing this term",
];

const ROSTER_HEADERS = [
  "Student",
  "Guardian email",
  "Instrument",
  "Teacher",
  "Length",
  "Status",
];

const ROSTER_ROWS = [
  ["Wren Adeyemi-Clarke", "wren.family@example.org", "Cello", "N. Okafor", "30", STATUS_OPTIONS[3]],
  ["Idris Bellweather", "idris.home@example.org", "Piano", "T. Bright", "45", STATUS_OPTIONS[2]],
  ["Juno Castellanos", "juno.c@example.org", "Violin", "H. Kerr", "30", STATUS_OPTIONS[1]],
  ["Ottoline Fitzgerald", "o.fitzgerald@example.org", "Flute", "N. Okafor", "60", STATUS_OPTIONS[3]],
  ["Bartholomew Ige", "b.ige@example.org", "Trumpet", "T. Bright", "30", STATUS_OPTIONS[0]],
  ["Sunniva Haugen", "s.haugen@example.org", "Piano", "H. Kerr", "45", STATUS_OPTIONS[4]],
  ["Kwabena Mensah", "k.mensah@example.org", "Guitar", "T. Bright", "30", STATUS_OPTIONS[3]],
  ["Perpetua Nwankwo", "", "Viola", "", "", STATUS_OPTIONS[0]],
];

const FIRST_DATA_ROW = 2;
const LAST_DATA_ROW = FIRST_DATA_ROW + ROSTER_ROWS.length - 1; // 9

/**
 * Lessons: the term default unless this student has an override.
 * One reference to the override, read once, so nothing below cares about it.
 */
const LESSONS_FORMULA = `=IF($A${FIRST_DATA_ROW}="", "", IF($I${FIRST_DATA_ROW}<>"", $I${FIRST_DATA_ROW}, Term_Lessons))`;

/**
 * Term fee: every number in it comes from a named range on Settings, so the day
 * a rate changes it changes in one cell. Four clauses, so it gets real
 * newlines rather than being crammed onto one line.
 */
const FEE_FORMULA = [
  "=LET(",
  `  lessons, $G${FIRST_DATA_ROW},`,
  // `Length` is a DROPDOWN column whose options look like numbers, and Sheets
  // stores them as numbers. Comparing the cell to the string "30" silently
  // matched nothing and every fee came out blank. Coercing to text first works
  // whichever way the value is stored.
  `  rate, SWITCH($E${FIRST_DATA_ROW} & "", "30", Rate_30_Minutes, "45", Rate_45_Minutes, "60", Rate_60_Minutes, 0),`,
  `  inactive, OR($F${FIRST_DATA_ROW}="Not continuing this term", $F${FIRST_DATA_ROW}="Waitlisted for this term"),`,
  "  IF(OR(inactive, lessons=\"\", rate=0), \"\", rate * lessons)",
  ")",
].join("\n");

/**
 * The Check column: the sheet saying what is missing, in sentences somebody can
 * act on. Not ERR_MISSING_FIELD_B.
 */
const CHECK_FORMULA = [
  "=LET(",
  `  named, $A${FIRST_DATA_ROW}<>"",`,
  "  TEXTJOIN(\"; \", TRUE,",
  `    IF(AND(named, $B${FIRST_DATA_ROW}=""), "No guardian email", ""),`,
  `    IF(AND(named, $D${FIRST_DATA_ROW}=""), "No teacher yet", ""),`,
  `    IF(AND(named, $E${FIRST_DATA_ROW}=""), "No lesson length", ""),`,
  `    IF(AND($F${FIRST_DATA_ROW}="Time confirmed by the family", $D${FIRST_DATA_ROW}=""), "Confirmed with the family but no teacher assigned", ""))`,
  ")",
].join("\n");

const ROSTER_COLUMNS = [
  {
    name: "Student",
    type: "TEXT",
    key: "student",
    role: "key",
    note: "Preferred name, written the way the family writes it.",
  },
  {
    name: "Guardian email",
    type: "TEXT",
    role: "input",
    note: "Where term reminders and schedule changes go. One address is enough.",
  },
  { name: "Instrument", type: "TEXT", role: "input", note: "What the student is studying this term." },
  {
    name: "Teacher",
    type: "DROPDOWN",
    role: "input",
    options: ["N. Okafor", "T. Bright", "H. Kerr"],
    note: "Who teaches this student. Lesson counts per teacher live on Settings.",
  },
  {
    name: "Length",
    type: "DROPDOWN",
    role: "input",
    options: ["30", "45", "60"],
    note: "Lesson length in minutes. Most students take 30.",
  },
  {
    name: "Status",
    type: "DROPDOWN",
    role: "status",
    options: STATUS_OPTIONS,
    note: "Where this family is in the process. This column says nothing about whether they have paid.",
  },
  {
    name: "Lessons",
    type: "DOUBLE",
    role: "formula",
    owner: "agent",
    note: "The term default, unless the override in column I says otherwise. Calculated, so anything typed here is lost.",
  },
  {
    name: "Term fee",
    type: "CURRENCY",
    role: "formula",
    owner: "agent",
    note: "Lessons times the rate for this lesson length. Calculated, so anything typed here is lost.",
  },
  {
    name: "Lesson override",
    type: "DOUBLE",
    role: "input",
    note: "Only when this student's lesson count differs from the term default. Leave it blank otherwise.",
  },
  {
    name: "Check",
    type: "TEXT",
    role: "check",
    owner: "agent",
    note: "The sheet checking itself. Resolve what it says rather than deleting the column.",
  },
];

const SETTINGS_ITEMS = [
  {
    label: "30 minute lesson",
    value: 80,
    unit: "$ per lesson",
    format: "currency",
    name: "Rate_30_Minutes",
    source: "Term rate sheet, confirmed by the office 2027-01-12.",
  },
  {
    label: "45 minute lesson",
    value: 120,
    unit: "$ per lesson",
    format: "currency",
    name: "Rate_45_Minutes",
    source: "Term rate sheet, confirmed by the office 2027-01-12.",
  },
  {
    label: "60 minute lesson",
    value: 160,
    unit: "$ per lesson",
    format: "currency",
    name: "Rate_60_Minutes",
    source: "Term rate sheet, confirmed by the office 2027-01-12.",
  },
  {
    label: "Lessons in the term",
    value: 14,
    unit: "lessons",
    format: "integer",
    name: "Term_Lessons",
    source: "Spring calendar, less the two weeks the building is closed in March.",
    note: "A student who joins late or leaves early gets an override in column I of the Roster rather than a change here.",
  },
];

const ABOUT_LINES = [
  ["Rivermill Community Music: private lessons, spring term"],
  [""],
  ["One row per student on the Roster tab. Add a row at the bottom as families sign up."],
  [
    "Student, guardian email, instrument, teacher, length, status and the lesson override are yours to fill in. Lessons, term fee and Check calculate themselves, so anything typed over them will be lost.",
  ],
  [
    "Rates and the term lesson count live on the Settings tab. Change them there and every fee on the Roster updates.",
  ],
  [
    "The Check column flags rows that are missing something, in plain words. Fix what it says rather than deleting the column.",
  ],
  [""],
  ["This is a demonstration spreadsheet. Every name, address and number in it is invented."],
];

// ---------------------------------------------------------------------------
// Talking to the server
// ---------------------------------------------------------------------------

let client;
let calls = 0;

/** Call one tool, print what it was, and fail loudly on a tool-level error. */
async function call(name, args) {
  calls += 1;
  process.stdout.write(`  ${String(calls).padStart(2)}. ${name} `);
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  if (result.isError) {
    process.stdout.write("failed\n");
    throw new Error(`${name} refused:\n${text}`);
  }
  const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
  process.stdout.write(`ok — ${firstLine.slice(0, 96)}\n`);
  return result.structuredContent ?? {};
}

/**
 * The row `gap` rows below the bottom of an A1 range like `A1:C7`.
 * Falls back to a row well clear of any plausible block if the range is
 * missing, because a summary written one row too low is a cosmetic problem and
 * a summary written on top of the assumptions is not.
 */
function rowBelow(rangeA1, gap) {
  const end = typeof rangeA1 === "string" ? rangeA1.split(":").pop() : "";
  const row = Number.parseInt(String(end).replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(row) && row > 0 ? row + gap : 20;
}

function requireCredential() {
  const token = process.env.GSHEETS_PRO_TOKEN_FILE;
  if (token && !fs.existsSync(token)) {
    throw new Error(`GSHEETS_PRO_TOKEN_FILE points at ${token}, which does not exist.`);
  }
  if (!fs.existsSync(SERVER)) {
    throw new Error(`${path.relative(REPO, SERVER)} is missing. Run \`npm run build\` first.`);
  }
}

async function connect(renderDir) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER, "stdio"],
    cwd: REPO,
    env: {
      ...process.env,
      // Renders land somewhere disposable; the one we keep is copied out below.
      GSHEETS_PRO_RENDER_DIR: renderDir,
      GSHEETS_PRO_RENDER_MODE: "local",
    },
    stderr: "inherit",
  });
  const c = new Client({ name: "gsheets-pro-golden-demo", version: "1.0.0" });
  await c.connect(transport);
  return c;
}

// ---------------------------------------------------------------------------
// The build, in the order the skill says to build
// ---------------------------------------------------------------------------

async function build() {
  console.log("Building the golden demo spreadsheet.\n");

  // 1. Create it. Three tabs, named for what they are.
  const opened = await call("sheets_open", {
    create: { title: TITLE, tabs: ["Roster", "Settings", "About"] },
  });
  const id = opened?.spreadsheet?.id;
  const url = opened?.spreadsheet?.url;
  if (!id) throw new Error("sheets_open created a spreadsheet but reported no id.");

  // 2. The theme, before anything is painted, so every role token resolves
  //    through Format > Theme rather than through hardcoded hex.
  await call("sheets_style", { spreadsheet_id: id, preset: "park" });

  // 3. The assumptions, before anything that depends on them. Each one gets a
  //    named range and a line saying where the number came from.
  const settings = await call("sheets_settings", {
    spreadsheet_id: id,
    action: "block",
    sheet: "Settings",
    at: "A1",
    title: "Lesson rates and term length",
    items: SETTINGS_ITEMS,
    preset: "park",
    protect: true,
  });

  // Where the summary goes depends on how tall the block came out, and the
  // block's height depends on how the tool chose to lay it out. Ask rather
  // than guess: a hardcoded row here is a collision waiting for the day
  // somebody adds a fifth assumption.
  const summaryRow = rowBelow(settings?.settings?.range, 2);

  // 4. The values a person owns, written before the Table exists, so the
  //    contract this build is about to record is never something the build
  //    itself had to force its way past.
  await call("sheets_write", {
    spreadsheet_id: id,
    sheet: "Roster",
    mode: "range",
    range: `A1:F${LAST_DATA_ROW}`,
    values: [ROSTER_HEADERS, ...ROSTER_ROWS],
  });

  // 5. The Table: typed columns, a note on every header, a frozen header, and
  //    the status dropdown carrying sentences rather than state codes.
  await call("sheets_table", {
    spreadsheet_id: id,
    sheet: "Roster",
    action: "create",
    name: "Roster",
    range: `A1:J${LAST_DATA_ROW}`,
    columns: ROSTER_COLUMNS,
    preset: "park",
    freeze_header: true,
    filter: true,
    protect_header: true,
    // Status fills are off deliberately. `status_fill_rules` paints every
    // option, and any option not named in `status_colors` falls back to the
    // `muted` role, which in every shipped preset is a text colour rather than
    // a tint: park's is #6B7770. As a fill behind black text it is unreadable,
    // and the first render of this sheet had three illegible status rows
    // because of it. Until `muted` is either given a fill value or dropped from
    // the status roles, the words carry the status here and the one signal
    // worth painting is painted below, on the Check column.
    status_fill_rules: false,
  });

  // The one conditional rule this sheet needs: a row the Check column is
  // flagging should be visible from across the room. A rule rather than a
  // painted cell, so it applies itself to every row anyone adds later.
  await call("sheets_conditional_format", {
    spreadsheet_id: id,
    action: "add",
    sheet: "Roster",
    ranges: [`J${FIRST_DATA_ROW}:J${LAST_DATA_ROW}`],
    kind: "boolean",
    operator: "not_blank",
    format: { fill: "flag" },
    preset: "park",
  });

  // Widths. Autofit for the nine columns holding short values, because
  // hand-picked pixels are a losing game: three rounds of tuning here moved a
  // truncation from the Check column to the header of `Lesson override` to the
  // longest status option, and the next change to the data would move it again.
  // Autofit sizes each column to its own longest cell, header included.
  await call("sheets_style", {
    spreadsheet_id: id,
    sheet: "Roster",
    autofit: { columns: "A:I" },
  });

  // The Check column is the exception, and it is the exception for a reason
  // autofit cannot help with: it holds whole sentences, so autofitting it would
  // make one column wider than the page. A fixed width plus wrapping is what a
  // column of prose wants, and it survives a longer message where more pixels
  // only move the cliff.
  await call("sheets_style", {
    spreadsheet_id: id,
    sheet: "Roster",
    range: `J1:J${LAST_DATA_ROW}`,
    style: { wrap: "WRAP", vertical_align: "TOP" },
    column_widths: [{ columns: "J:J", pixels: 250 }],
  });

  // 6. One formula per column, written once and filled down.
  for (const [column, formula] of [
    ["G", LESSONS_FORMULA],
    ["H", FEE_FORMULA],
    ["J", CHECK_FORMULA],
  ]) {
    await call("sheets_write", {
      spreadsheet_id: id,
      sheet: "Roster",
      mode: "fill",
      range: `${column}${FIRST_DATA_ROW}:${column}${LAST_DATA_ROW}`,
      formula,
    });
  }

  // 7. A summary block, on Settings so the Roster stays one clean table.
  //    Structured references, so the counts keep working as the Table grows.
  await call("sheets_write", {
    spreadsheet_id: id,
    sheet: "Settings",
    mode: "range",
    range: `A${summaryRow}:B${summaryRow + 4}`,
    values: [
      ["This term at a glance", ""],
      ["Students on the roster", "=COUNTA(Roster[Student])"],
      ["Times confirmed", `=COUNTIF(Roster[Status], "${STATUS_OPTIONS[3]}")`],
      ["Still to hear back", `=COUNTIF(Roster[Status], "${STATUS_OPTIONS[2]}")`],
      ["Rows the Check column is flagging", '=COUNTIF(Roster[Check], "<>")'],
    ],
  });

  // 8. The sheet's own documentation, written to a colleague.
  await call("sheets_write", {
    spreadsheet_id: id,
    sheet: "About",
    mode: "range",
    range: `A1:A${ABOUT_LINES.length}`,
    values: ABOUT_LINES,
  });

  // 9. The lint.
  const check = await call("sheets_check", {
    spreadsheet_id: id,
    sheets: ["Roster", "Settings", "About"],
  });

  // 10. The picture.
  const rendered = await call("sheets_render", { spreadsheet_id: id, sheet: "Roster" });

  return { id, url, check, rendered };
}

function keepTheRender(rendered) {
  // `sheets_render` reports its files under `pages`, one entry per PDF page,
  // each carrying `path` locally and `url` when the server is hosted. Page one
  // is the hero image; a tab long enough to paginate is too long for a README.
  const first = (rendered?.pages ?? [])[0];
  const source = first?.path;
  if (!source || !fs.existsSync(source)) {
    return {
      kept: false,
      why:
        rendered?.mode === "hosted"
          ? "the server is in hosted mode, so the render came back as a URL rather than a path"
          : "the render reported no local file path",
    };
  }
  fs.mkdirSync(path.dirname(RENDER_OUT), { recursive: true });
  fs.copyFileSync(source, RENDER_OUT);
  return { kept: true, bytes: fs.statSync(RENDER_OUT).size };
}

async function main() {
  requireCredential();
  const renderDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsheets-pro-golden-"));
  let outcome;
  try {
    client = await connect(renderDir);
    outcome = await build();
  } finally {
    await client?.close().catch(() => {});
  }

  const render = keepTheRender(outcome.rendered);
  fs.rmSync(renderDir, { recursive: true, force: true });

  const status = outcome.check?.status ?? "unknown";
  console.log("\n" + "-".repeat(72));
  console.log(`Spreadsheet: ${outcome.url}`);
  console.log(`Lint:        ${status}, ${outcome.check?.total_errors ?? "?"} errors in ${outcome.check?.total_formulas ?? "?"} formulas`);
  console.log(
    render.kept
      ? `Render:      ${path.relative(REPO, RENDER_OUT)} (${render.bytes} bytes)`
      : `Render:      not kept, ${render.why}`,
  );
  // A clean status still leaves warnings worth reading, and a demo nobody reads
  // the warnings on is how a golden sheet stops being golden.
  for (const finding of outcome.check?.findings ?? []) {
    console.log(
      `Finding:     [${finding.severity ?? "?"}] ${finding.rule ?? ""} ${finding.location ?? ""} ${finding.message ?? ""}`.trim(),
    );
  }
  console.log("-".repeat(72));
  console.log("\nShare it view-only before putting the link in the README or the skill.");

  if (status !== "success") {
    console.error(`\nThe lint did not come back clean (${status}). The demo is not golden until it does.`);
    process.exitCode = 1;
  }
  if (!render.kept) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
