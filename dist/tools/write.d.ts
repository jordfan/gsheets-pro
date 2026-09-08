/**
 * `sheets_write`: the only tool that changes a cell's value.
 *
 * Five modes, one set of guards. The modes exist because "write these values"
 * means five different things to a person, and collapsing them into one
 * `range` write is what produces the classic failures: an append that lands
 * below a second block of data, an update that renumbers rows, a fill that
 * copies a formula without adjusting its references.
 *
 * The guards are the point of the tool.
 *
 * A **formula guard** pre-reads the target with FORMULA render and refuses to
 * replace a cell that currently holds a formula. Overwriting somebody's
 * `=XLOOKUP(...)` with the number it happened to produce is silent and
 * permanent, and it is the single commonest way an agent ruins a spreadsheet.
 *
 * A **contract check** refuses a column the registry or the sheet's own
 * developer metadata marks as somebody else's. Hadeer's date columns are not
 * ours to fill in, whatever the email said.
 *
 * A **colleague-safe text check** refuses message ids, task markers, and
 * self-references on any sheet a person owns or shares. Somebody opens that
 * sheet with no idea an agent touched it.
 *
 * An **error gate** reads the written range back and reports whether it still
 * evaluates. `check: false` turns it off for the interior writes of a build,
 * where only the last one needs to answer.
 *
 * `force` overrides the first three. It never overrides the gate, because the
 * gate reports rather than refuses.
 *
 * Two API facts shape the append paths, both from spike 3. `appendCells` with
 * a `tableId` returns success, grows the Table by a row, and writes an EMPTY
 * one: the values are silently discarded. And `values.append` with
 * `INSERT_ROWS` appends past everything on the tab, so on a tab holding two
 * blocks of data it lands in the wrong place.
 *
 * So a Table append uses `values.append` over the Table's own range, which is
 * the only path that both writes the values and extends the Table. A non-Table
 * append finds the end of the first block itself and writes there through
 * `values.batchUpdate`, the plain update endpoint in its batched form: it
 * inserts no rows, so nothing below it moves, and it can carry the tail block
 * alongside an upsert's matched rows in a single call. A tab holding two
 * blocks has no single end to append to and is refused rather than guessed at.
 */
import { z } from "zod";
import { type CellValue } from "../lib/records.js";
import type { ToolDefinition, ToolDeps } from "./types.js";
export declare const writeInputSchema: {
    spreadsheet_id: z.ZodString;
    sheet: z.ZodString;
    mode: z.ZodOptional<z.ZodEnum<{
        fill: "fill";
        log: "log";
        range: "range";
        append: "append";
        upsert: "upsert";
    }>>;
    range: z.ZodOptional<z.ZodString>;
    values: z.ZodOptional<z.ZodArray<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]>>>>;
    records: z.ZodOptional<z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]>>>>;
    rows: z.ZodOptional<z.ZodArray<z.ZodObject<{
        key: z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>;
        set: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]>>;
    }, z.core.$strip>>>;
    key_column: z.ZodOptional<z.ZodString>;
    header_row: z.ZodOptional<z.ZodNumber>;
    at_row: z.ZodOptional<z.ZodNumber>;
    formula: z.ZodOptional<z.ZodString>;
    timestamp_column: z.ZodOptional<z.ZodString>;
    note: z.ZodOptional<z.ZodString>;
    raw: z.ZodOptional<z.ZodBoolean>;
    force: z.ZodOptional<z.ZodBoolean>;
    expect_contract: z.ZodOptional<z.ZodObject<{
        source: z.ZodOptional<z.ZodEnum<{
            registry: "registry";
            metadata: "metadata";
            "registry+metadata": "registry+metadata";
            none: "none";
        }>>;
        owner: z.ZodOptional<z.ZodEnum<{
            human: "human";
            shared: "shared";
            agent: "agent";
        }>>;
        headers: z.ZodOptional<z.ZodArray<z.ZodString>>;
        key_column: z.ZodOptional<z.ZodString>;
        positional_rows: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    dry_run: z.ZodOptional<z.ZodBoolean>;
    check: z.ZodOptional<z.ZodBoolean>;
};
export declare function createWriteTool(deps: ToolDeps): ToolDefinition<typeof writeInputSchema>;
/** One based header row: what was asked for, then frozen rows, then the first text row. */
export declare function resolveHeaderRow(headerRow: number | undefined, frozenRowCount: number | undefined, grid: CellValue[][]): number | undefined;
/**
 * Where the first block of data ends, and whether there is a second one.
 *
 * A tab holding a roster and then, four rows below it, a small summary table
 * is the case that breaks a naive append. The end of the data is the end of
 * the FIRST block, not the last filled row on the tab.
 */
export declare function findBlocks(grid: CellValue[][], firstDataRow: number): {
    lastDataRow: number;
    multipleBlocks: boolean;
};
/** A header name or a column letter to a column. */
export declare function resolveColumn(nameOrLetter: string, headers: string[]): {
    index: number;
    letter: string;
    header?: string;
};
/** Contiguous runs of column indexes, so one row becomes as few ranges as possible. */
export declare function coalesce(indexes: number[]): number[][];
//# sourceMappingURL=write.d.ts.map