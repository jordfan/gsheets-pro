/**
 * The error gate: one masked read after a write, so the tool can say whether
 * the sheet is still healthy.
 *
 * A write that succeeds at the API level can still leave the spreadsheet full
 * of #REF!. Deleting a column, sorting a range a formula pointed into, or
 * replacing text inside a formula all return HTTP 200 and then break something
 * three tabs away. So every mutating call closes with one `spreadsheets.get`
 * over the union of what it touched and reports what it found.
 *
 * The shape is deliberately the one Anthropic's xlsx recalc check produces:
 * status, a formula count, an error count, and a summary keyed on the API's own
 * `ErrorValue.type` enum. A model that has seen one has seen the other.
 *
 * LOADING is not an error. It is Sheets saying a volatile function has not
 * finished, and it clears on its own within a second or two. The gate waits a
 * short while for it and then reports `pending` rather than crying wolf.
 */
import { columnIndexToLetter, rangeCellCount } from "./a1.js";
import { withRetry } from "./batch.js";
/** The `ErrorValue.type` enum, as of discovery revision 20260831. */
export const ERROR_VALUE_TYPES = [
    "ERROR",
    "NULL_VALUE",
    "DIVIDE_BY_ZERO",
    "VALUE",
    "REF",
    "NAME",
    "NUM",
    "N_A",
    "LOADING",
];
/** How many ranges one gate read will ask for before it gives up on precision. */
export const MAX_GATE_RANGES = 20;
/** How many offending cells the response names. */
export const MAX_GATE_CELLS = 20;
/** How long to wait out LOADING before reporting `pending`. */
export const LOADING_BUDGET_MS = 5000;
const GATE_MASK = [
    "sheets(",
    "properties(sheetId,title),",
    "data(startRow,startColumn,rowData(values(",
    "userEnteredValue(formulaValue),",
    "effectiveValue(errorValue(type,message))",
    ")))",
    ")",
].join("");
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Past this many cells a re-read costs more than it teaches. */
export const MAX_GATE_CELL_COUNT = 20_000;
/**
 * Is this range small enough, and bounded enough, to be worth reading back?
 *
 * An open-ended range like `B:B` covers the whole column, so re-reading it
 * would pull the entire sheet to check a formatting change. The tools that can
 * touch an unbounded range consult this and say they skipped rather than
 * quietly reading a million cells.
 */
export function withinGateCap(bounds, cap = MAX_GATE_CELL_COUNT) {
    const cells = rangeCellCount(bounds);
    return cells !== undefined && cells <= cap;
}
/**
 * Re-read the touched ranges and report their health.
 *
 * `ranges` are fully qualified A1 references ("'Roster'!A1:F80"). An empty list
 * means the caller touched nothing readable, which is `skipped` rather than
 * `success`: claiming a clean bill of health on a check that never ran is worse
 * than admitting it did not run.
 */
export async function runErrorGate(api, spreadsheetId, ranges, options = {}) {
    if (options.skip) {
        return {
            status: "skipped",
            total_formulas: 0,
            total_errors: 0,
            error_summary: {},
            cells: [],
            ranges: [],
            note: options.skip,
        };
    }
    const unique = [...new Set(ranges.filter((r) => typeof r === "string" && r.trim() !== ""))];
    if (unique.length === 0) {
        return {
            status: "skipped",
            total_formulas: 0,
            total_errors: 0,
            error_summary: {},
            cells: [],
            ranges: [],
            note: "Nothing to re-read, so nothing was checked. This action did not change any cell values.",
        };
    }
    const maxRanges = options.maxRanges ?? MAX_GATE_RANGES;
    let note;
    let wanted = unique;
    if (wanted.length > maxRanges) {
        note = `${unique.length} ranges were touched and the gate reads at most ${maxRanges}, so the check covers the first ${maxRanges}. Run sheets_check for the whole spreadsheet.`;
        wanted = unique.slice(0, maxRanges);
    }
    const sleep = options.sleep ?? defaultSleep;
    const now = options.now ?? Date.now;
    const budget = options.loadingBudgetMs ?? LOADING_BUDGET_MS;
    const startedAt = now();
    let tally = await readTally(api, spreadsheetId, wanted);
    while (tally.loading > 0 && now() - startedAt < budget) {
        await sleep(Math.min(500 + (now() - startedAt), 1500));
        tally = await readTally(api, spreadsheetId, wanted);
    }
    const status = tally.errors > 0 ? "errors_found" : tally.loading > 0 ? "pending" : "success";
    const check = {
        status,
        total_formulas: tally.formulas,
        total_errors: tally.errors,
        error_summary: tally.summary,
        cells: tally.cells.slice(0, MAX_GATE_CELLS),
        ranges: wanted,
    };
    if (tally.cells.length > MAX_GATE_CELLS) {
        note = joinNotes(note, `${tally.cells.length} cells carry an error; the first ${MAX_GATE_CELLS} are named.`);
    }
    if (status === "pending") {
        note = joinNotes(note, `${tally.loading} cell(s) were still calculating after ${Math.round(budget / 1000)} seconds. That is Sheets working, not a failure. Read again in a moment to settle it.`);
    }
    if (note)
        check.note = note;
    return check;
}
async function readTally(api, spreadsheetId, ranges) {
    const response = await withRetry(() => api.spreadsheets.get({ spreadsheetId, ranges, includeGridData: true, fields: GATE_MASK }));
    const data = (response.data ?? {});
    const tally = { formulas: 0, errors: 0, loading: 0, summary: {}, cells: [] };
    for (const sheet of data.sheets ?? []) {
        const title = sheet.properties?.title ?? "";
        for (const block of sheet.data ?? []) {
            const startRow = block.startRow ?? 0;
            const startColumn = block.startColumn ?? 0;
            (block.rowData ?? []).forEach((row, r) => {
                (row.values ?? []).forEach((cell, c) => {
                    if (cell?.userEnteredValue?.formulaValue)
                        tally.formulas += 1;
                    const error = cell?.effectiveValue?.errorValue;
                    if (!error?.type)
                        return;
                    const type = error.type;
                    if (type === "LOADING") {
                        tally.loading += 1;
                        return;
                    }
                    tally.errors += 1;
                    tally.summary[type] = (tally.summary[type] ?? 0) + 1;
                    const entry = {
                        cell: `${title ? `'${title}'!` : ""}${columnIndexToLetter(startColumn + c)}${startRow + r + 1}`,
                        type,
                    };
                    if (error.message)
                        entry.message = error.message;
                    tally.cells.push(entry);
                });
            });
        }
    }
    return tally;
}
function joinNotes(a, b) {
    return a ? `${a} ${b}` : b;
}
/** One or two sentences of prose for the check, for `content[0].text`. */
export function describeCheck(check) {
    if (check.status === "skipped") {
        return check.note ?? "No cell values changed, so there was nothing to check.";
    }
    const scope = check.ranges.length === 1 ? check.ranges[0] : `${check.ranges.length} ranges`;
    if (check.status === "success") {
        return `Check: clean. ${check.total_formulas} formula(s) across ${scope}, no errors.`;
    }
    if (check.status === "pending") {
        return `Check: still calculating. ${check.total_formulas} formula(s) across ${scope}, no errors yet.${check.note ? ` ${check.note}` : ""}`;
    }
    const kinds = Object.entries(check.error_summary)
        .map(([type, n]) => `${n} ${type}`)
        .join(", ");
    const worst = check.cells
        .slice(0, 3)
        .map((c) => c.cell)
        .join(", ");
    return `Check: ${check.total_errors} error(s) across ${scope} (${kinds}). First: ${worst}.${check.note ? ` ${check.note}` : ""}`;
}
//# sourceMappingURL=errorgate.js.map