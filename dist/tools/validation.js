/**
 * `sheets_validation`: dropdowns, checkboxes, and the rest of the rules that
 * decide what a cell will accept.
 *
 * The whole tool turns on one restraint. The Sheets API has no color field on
 * any validation rule, so the chip colors a person picked in the UI cannot be
 * read and cannot be written back. Spike 4 settled what that costs: re-applying
 * `setDataValidation` with a condition byte-identical to the one already there
 * wiped the colors a person had set by hand, with renders before and after to
 * prove it, and a success response that said nothing. So a dropdown the plugin
 * did not create is treated as the human's: reported, not touched, and changed
 * only when the caller passes `force` and accepts losing the colors.
 *
 * The second restraint comes from spike 3. On a native Table, a DROPDOWN
 * column's rule lives on the Table's column properties and not on its cells, so
 * setting cell validation there fights the Table rather than editing it. That
 * case is sent to `sheets_table update`.
 */
import { z } from "zod";
import { a1ToGridRange, columnIndexToLetter, gridRangeToA1, parseA1, quoteSheetName, } from "../lib/a1.js";
import { withRetry, runBatchUpdate } from "../lib/batch.js";
import { recordWrite } from "../lib/writelog.js";
import { buildCondition, CONDITION_KINDS, CONDITION_OPERATORS, describeCondition } from "../lib/conditions.js";
import { err, GsheetsError } from "../lib/errors.js";
import { columnRecords, hasColumnRecord, readMetadata } from "../lib/metaread.js";
import { assertWritable, isColumnWritable } from "../lib/registry.js";
import { count, guarded, lines, listOf, ok } from "../lib/result.js";
import { METADATA_KEYS } from "../lib/contract.js";
import { MAX_RECORDED_COLUMNS, metadataRequest, } from "../lib/tables.js";
const STATE_MASK = [
    "sheets.properties(sheetId,title)",
    "sheets.tables(tableId,name,range,columnProperties(columnIndex,columnName,columnType))",
    "sheets.data(startRow,startColumn,rowData.values(dataValidation(condition(type,values(userEnteredValue)),strict,inputMessage,showCustomUi)))",
].join(",");
export const VALIDATION_TYPES = [
    "list",
    "source_range",
    "checkbox",
    "date",
    "number",
    "text",
    "custom",
    "clear",
];
export const validationInputSchema = {
    spreadsheet_id: z.string().describe("The spreadsheet id, the long id in the middle of the sheet's URL."),
    sheet: z.string().describe("The tab name, as it reads on the tab strip."),
    range: z
        .string()
        .describe("A1 range the rule covers, for example E2:E200 or E:E. Give the data rows only, not the header."),
    type: z
        .enum(VALIDATION_TYPES)
        .describe("list is a dropdown of fixed options. source_range is a dropdown fed by a range elsewhere. checkbox, date, number and text constrain what may be typed. custom takes a formula. clear removes the rule."),
    values: z
        .array(z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe("The options, for type list. Also the checked and unchecked values, for a custom checkbox."),
    source_range: z
        .string()
        .optional()
        .describe('For type source_range: where the options live, with the tab name, for example "Lists!A2:A20".'),
    operator: z
        .enum(CONDITION_OPERATORS)
        .optional()
        .describe("For date, number and text: how the value is compared, for example greater_than or between."),
    kind: z
        .enum(CONDITION_KINDS)
        .optional()
        .describe("Only needed when the operator reads the same for a number, a date and a string, such as equal or between."),
    value: z.union([z.string(), z.number(), z.boolean()]).optional().describe("The value compared against."),
    value2: z.union([z.string(), z.number(), z.boolean()]).optional().describe("The far end of a between."),
    formula: z
        .string()
        .optional()
        .describe('For type custom: the formula, written for the first cell of the range, for example "=ISNUMBER(E2)".'),
    help: z
        .string()
        .optional()
        .describe("Help text shown when somebody selects the cell. Say what belongs there in a sentence, the way a colleague would explain it."),
    strict: z
        .boolean()
        .optional()
        .describe("Reject anything that does not match, rather than warning. Default true."),
    show_dropdown: z
        .boolean()
        .optional()
        .describe("Show the dropdown arrow in the cell. Default true, and only meaningful for a list."),
    force: z
        .boolean()
        .optional()
        .describe("Overwrite a rule this plugin did not create. Its chip colours cannot be read through the API and will be lost."),
    dry_run: z.boolean().optional().describe("Report what would be sent, and send nothing."),
};
export function createValidationTool(deps) {
    return {
        name: "sheets_validation",
        config: {
            title: "Set data validation",
            description: "Put a rule on a range: a dropdown from a list or from a source range, a checkbox, a date, number or text constraint, a custom formula, or clear. Refuses to overwrite a dropdown somebody set in the Sheets UI, because its chip colours cannot be read back and would be lost.",
            inputSchema: validationInputSchema,
            annotations: { idempotentHint: true, openWorldHint: true },
        },
        handler: guarded(async (raw) => {
            const args = raw;
            const ctx = await deps.getContext();
            const info = await ctx.cache.resolve(args.spreadsheet_id, args.sheet);
            const rangeA1 = String(args.range ?? "").trim();
            if (!rangeA1) {
                throw err.invalid("range is required.", "Give the data rows the rule covers, for example E2:E200. A whole column such as E:E works too.");
            }
            parseA1(rangeA1);
            const grid = a1ToGridRange(rangeA1, info.sheetId);
            const reference = `${quoteSheetName(info.title)}!${rangeA1}`;
            // The registry has the final word on which columns are ours to write.
            const policy = ctx.registry?.policyFor(args.spreadsheet_id, info.title);
            assertWritable(policy, { tool: "sheets_validation", ...(args.force === true ? { force: true } : {}) });
            const refusals = [];
            const firstColumn = grid.startColumnIndex ?? 0;
            const lastColumn = (grid.endColumnIndex ?? firstColumn + 1) - 1;
            for (let c = firstColumn; c <= lastColumn && c - firstColumn < 50; c += 1) {
                const writable = isColumnWritable(policy, { letter: columnIndexToLetter(c) });
                if (!writable.writable && writable.reason)
                    refusals.push(writable.reason);
            }
            if (refusals.length) {
                throw new GsheetsError("contract_violation", refusals[0], "Validation changes what a colleague may type into their own column, so it follows the same rule as a write. Change the registry entry if the column really is ours.", { refusals });
            }
            const state = await withRetry(() => ctx.sheets.spreadsheets.get({
                spreadsheetId: args.spreadsheet_id,
                ranges: [reference],
                includeGridData: true,
                fields: STATE_MASK,
            }));
            const sheet = (state.data.sheets ?? [])[0];
            // A Table's typed column carries its rule on the Table, not on the cells.
            const table = (sheet?.tables ?? []).find((t) => overlaps(t.range, grid.startColumnIndex, grid.endColumnIndex));
            if (table && !args.force) {
                const columnNames = (table.columnProperties ?? [])
                    .filter((c) => {
                    const absolute = (table.range?.startColumnIndex ?? 0) + (c.columnIndex ?? 0);
                    return absolute >= firstColumn && absolute <= lastColumn;
                })
                    .map((c) => `${c.columnName ?? "?"}${c.columnType ? ` (${c.columnType})` : ""}`);
                throw new GsheetsError("invalid_argument", `${rangeA1} sits inside the Table "${table.name ?? table.tableId}", and a Table column's rule lives on the Table rather than on its cells.`, `Use sheets_table with action update to change ${columnNames.length ? listOf(columnNames) : "that column"}. Pass force to write cell level validation anyway, which will fight the Table's own typing.`, { tableId: table.tableId, tableName: table.name });
            }
            // The contract is read every time now, not only when a rule is in the
            // way: setting a rule records who set it, and that record has to be
            // merged into whatever the column already carries rather than replacing it.
            const snapshot = await readMetadata(ctx.sheets, args.spreadsheet_id);
            const records = columnRecords(snapshot, info.sheetId);
            const existing = collectExisting(sheet, grid.startColumnIndex ?? 0);
            const uiOwnedColumns = existing
                .filter((e) => records.get(e.column)?.validation === undefined)
                .map((e) => columnIndexToLetter(e.column));
            if (uiOwnedColumns.length && !args.force) {
                throw new GsheetsError("ui_owned", `${listOf(uiOwnedColumns.map((c) => `column ${c}`))} already carries a validation rule this plugin did not create.`, "Rewriting it would discard the chip colours somebody set in the Sheets interface. The API cannot read those colours back, so nothing can save them first. That is measured, not a precaution: an identical rewrite wiped them in testing. Leave the rule alone, or pass force if losing the colours is acceptable.", { columns: uiOwnedColumns, existing });
            }
            const rule = args.type === "clear" ? undefined : buildRule(args);
            const requests = [
                rule === undefined
                    ? { setDataValidation: { range: grid } }
                    : { setDataValidation: { range: grid, rule } },
            ];
            const provenance = provenanceRequests({
                snapshot,
                records,
                sheetId: info.sheetId,
                firstColumn: grid.startColumnIndex,
                lastColumn: grid.endColumnIndex === undefined ? undefined : grid.endColumnIndex - 1,
                rule,
                kind: args.type,
                strict: args.strict !== false,
            });
            requests.push(...provenance.requests);
            const result = await runBatchUpdate(ctx.sheets, args.spreadsheet_id, requests, {
                dryRun: args.dry_run === true,
            });
            // A validation rule changes what a colleague may type into their own
            // column, so the ledger counts it the way it counts a value write.
            if (args.dry_run !== true) {
                recordWrite({
                    spreadsheetId: args.spreadsheet_id,
                    range: reference,
                    sheet: info.title,
                    tool: "sheets_validation",
                });
            }
            const description = rule === undefined
                ? `Cleared the validation on ${reference}.`
                : `${reference} now accepts ${describeCondition(rule.condition)}.`;
            const structured = {
                spreadsheet_id: args.spreadsheet_id,
                sheet: info.title,
                range: gridRangeToA1(grid),
                applied: args.dry_run !== true,
                dry_run: args.dry_run === true,
                type: args.type,
                rule: rule ?? null,
                replaced: existing.map((e) => ({
                    column: columnIndexToLetter(e.column),
                    conditionType: e.conditionType,
                    values: e.values,
                })),
                forced_over_ui_owned: uiOwnedColumns.length > 0 && args.force === true,
                recorded_columns: provenance.columns,
                request_count: result.requestCount,
            };
            const notes = [];
            if (args.dry_run)
                notes.push("Dry run: nothing was sent.");
            if (uiOwnedColumns.length && args.force) {
                notes.push(`Overwrote a rule set outside this plugin on ${listOf(uiOwnedColumns)}. Any chip colours a person had chosen there are gone. The API never exposed them, so they cannot be restored; somebody has to set them again by hand.`);
            }
            if (existing.length && !uiOwnedColumns.length) {
                notes.push(`Replaced ${count(existing.length, "rule")} the plugin had set earlier.`);
            }
            if (rule && args.type === "list") {
                notes.push("A rendered picture of the sheet will not show this dropdown as a chip, so use sheets_read or the lint to confirm it, not a render.");
            }
            if (rule?.inputMessage)
                notes.push(`Help text: "${rule.inputMessage}"`);
            if (provenance.columns.length) {
                notes.push(`Recorded ${listOf(provenance.columns.map((c) => `column ${c}`))} as this plugin's, so a later call knows the rule is ours to change rather than a colleague's.`);
            }
            if (provenance.note)
                notes.push(provenance.note);
            return ok(lines(description, ...notes.map((n) => `- ${n}`)), structured);
        }),
    };
}
function buildRule(args) {
    const condition = buildCondition(conditionSpecFor(args));
    const rule = { condition };
    rule.strict = args.strict !== false;
    if (args.type === "list" || args.type === "source_range") {
        rule.showCustomUi = args.show_dropdown !== false;
    }
    if (args.help?.trim())
        rule.inputMessage = args.help.trim();
    return rule;
}
function conditionSpecFor(args) {
    switch (args.type) {
        case "list":
            return { operator: "one_of_list", values: args.values ?? [] };
        case "source_range":
            return { operator: "one_of_range", source_range: args.source_range };
        case "checkbox":
            return { operator: "checkbox", values: args.values };
        case "custom":
            return { operator: "custom_formula", formula: args.formula, value: args.value };
        case "number":
        case "text":
        case "date": {
            if (!args.operator) {
                throw err.invalid(`A ${args.type} rule needs an operator.`, `For example operator: ${args.type === "text" ? "contains" : args.type === "date" ? "after" : "greater_than"}, with the value to compare against.`);
            }
            const spec = { operator: args.operator, kind: args.kind ?? args.type };
            if (args.value !== undefined)
                spec.value = args.value;
            if (args.value2 !== undefined)
                spec.value2 = args.value2;
            return spec;
        }
        default:
            throw err.invalid(`Unsupported validation type "${args.type}".`);
    }
}
function overlaps(range, start, end) {
    if (!range)
        return false;
    const rs = range.startColumnIndex ?? 0;
    const re = range.endColumnIndex ?? Number.MAX_SAFE_INTEGER;
    const ts = start ?? 0;
    const te = end ?? Number.MAX_SAFE_INTEGER;
    return ts < re && rs < te;
}
function collectExisting(sheet, fallbackStartColumn) {
    const seen = new Map();
    for (const block of sheet?.data ?? []) {
        const startColumn = block.startColumn ?? fallbackStartColumn;
        for (const row of block.rowData ?? []) {
            (row.values ?? []).forEach((cell, c) => {
                const rule = cell["dataValidation"];
                if (!rule?.condition)
                    return;
                const column = startColumn + c;
                if (seen.has(column))
                    return;
                const entry = {
                    column,
                    values: (rule.condition.values ?? [])
                        .map((v) => v.userEnteredValue)
                        .filter((v) => typeof v === "string"),
                };
                if (rule.condition.type)
                    entry.conditionType = rule.condition.type;
                seen.set(column, entry);
            });
        }
    }
    return [...seen.values()].sort((a, b) => a.column - b.column);
}
/**
 * Say, in the sheet itself, that this plugin set this rule.
 *
 * Without it every rule looks like a colleague's on the next call, including
 * the one the plugin set a second ago, and the tool refuses to touch its own
 * work. The record merges into whatever the column already carries, so a Table
 * created column keeps its header, role and type.
 *
 * Clearing a rule removes the marker rather than the record: the column may
 * still be under contract for other reasons.
 */
function provenanceRequests(input) {
    const { firstColumn, lastColumn } = input;
    if (firstColumn === undefined || lastColumn === undefined) {
        return {
            requests: [],
            columns: [],
            note: "That range covers whole rows rather than named columns, so there was nowhere to record which columns this rule belongs to. A later call will read the rule as somebody else's.",
        };
    }
    const width = lastColumn - firstColumn + 1;
    if (width > MAX_RECORDED_COLUMNS) {
        return {
            requests: [],
            columns: [],
            note: `The range spans ${width} columns, past the ${MAX_RECORDED_COLUMNS} this tool will record one at a time, so no provenance was written. Set the rule a column or a few at a time if a later call should recognise it as ours.`,
        };
    }
    const requests = [];
    const columns = [];
    for (let columnIndex = firstColumn; columnIndex <= lastColumn; columnIndex += 1) {
        const current = input.records.get(columnIndex);
        if (input.rule === undefined && current === undefined)
            continue;
        const record = { ...(current ?? {}) };
        if (input.rule === undefined)
            delete record.validation;
        else
            record.validation = { kind: input.kind, strict: input.strict };
        requests.push(metadataRequest({
            key: METADATA_KEYS.column,
            value: record,
            location: {
                dimensionRange: {
                    sheetId: input.sheetId,
                    dimension: "COLUMNS",
                    startIndex: columnIndex,
                    endIndex: columnIndex + 1,
                },
            },
            exists: hasColumnRecord(input.snapshot, input.sheetId, columnIndex),
        }));
        columns.push(columnIndexToLetter(columnIndex));
    }
    return { requests, columns };
}
//# sourceMappingURL=validation.js.map