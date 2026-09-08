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
import { type NullableBounds } from "./a1.js";
/** The `ErrorValue.type` enum, as of discovery revision 20260831. */
export declare const ERROR_VALUE_TYPES: readonly ["ERROR", "NULL_VALUE", "DIVIDE_BY_ZERO", "VALUE", "REF", "NAME", "NUM", "N_A", "LOADING"];
export type ErrorValueType = (typeof ERROR_VALUE_TYPES)[number];
/**
 * One vocabulary, shared with the lint.
 *
 * `references/lint-rules.md` documents `sheets_check` as returning `success`,
 * `errors_found` or `pending`, and every write's `check` uses the same words,
 * plus `skipped` for a check that did not run. A model that has read one
 * knows what the other means without being told twice.
 */
export type GateStatus = "success" | "errors_found" | "pending" | "skipped";
export interface GateErrorCell {
    /** "'Roster'!D14", so it can be pasted into the sheet's name box. */
    cell: string;
    type: string;
    message?: string;
}
export interface GateCheck {
    status: GateStatus;
    total_formulas: number;
    total_errors: number;
    /** Counts keyed on `ErrorValue.type`, so REF and N_A are told apart. */
    error_summary: Record<string, number>;
    /** The first few offending cells, for a person to go look at. */
    cells: GateErrorCell[];
    /** The A1 references that were re-read. */
    ranges: string[];
    /** Why the gate did less than a full check, when it did. */
    note?: string;
}
/** The slice of the Sheets client the gate needs. Structural, so tests can fake it. */
export interface GateCapableSheets {
    spreadsheets: {
        get(params: {
            spreadsheetId: string;
            ranges?: string[];
            includeGridData?: boolean;
            fields?: string;
        }): Promise<{
            data: unknown;
        }>;
    };
}
/** How many ranges one gate read will ask for before it gives up on precision. */
export declare const MAX_GATE_RANGES = 20;
/** How many offending cells the response names. */
export declare const MAX_GATE_CELLS = 20;
/** How long to wait out LOADING before reporting `pending`. */
export declare const LOADING_BUDGET_MS = 5000;
export interface GateOptions {
    /** Injectable for tests. */
    sleep?: (ms: number) => Promise<void>;
    /** Injectable for tests. */
    now?: () => number;
    loadingBudgetMs?: number;
    maxRanges?: number;
    /**
     * Do not read anything, and say why in these words.
     *
     * `sheets_write` takes `check: false` for the interior writes of a build,
     * where only the last one needs to answer. The reason is carried through
     * rather than dropped, because a response that simply omits the check reads
     * identically to one that passed.
     */
    skip?: string;
}
/** Past this many cells a re-read costs more than it teaches. */
export declare const MAX_GATE_CELL_COUNT = 20000;
/**
 * Is this range small enough, and bounded enough, to be worth reading back?
 *
 * An open-ended range like `B:B` covers the whole column, so re-reading it
 * would pull the entire sheet to check a formatting change. The tools that can
 * touch an unbounded range consult this and say they skipped rather than
 * quietly reading a million cells.
 */
export declare function withinGateCap(bounds: NullableBounds, cap?: number): boolean;
/**
 * Re-read the touched ranges and report their health.
 *
 * `ranges` are fully qualified A1 references ("'Roster'!A1:F80"). An empty list
 * means the caller touched nothing readable, which is `skipped` rather than
 * `success`: claiming a clean bill of health on a check that never ran is worse
 * than admitting it did not run.
 */
export declare function runErrorGate(api: GateCapableSheets, spreadsheetId: string, ranges: string[], options?: GateOptions): Promise<GateCheck>;
/** One or two sentences of prose for the check, for `content[0].text`. */
export declare function describeCheck(check: GateCheck): string;
//# sourceMappingURL=errorgate.d.ts.map