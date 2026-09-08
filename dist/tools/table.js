/**
 * `sheets_table`: native Tables, created, adopted, updated and deleted.
 *
 * A native Table is the closest thing Sheets has to saying "this block is one
 * thing": it types its columns, bands its rows, keeps its own range as data is
 * added, and gives every column a name that formulas can use. It is also the
 * feature most likely to destroy data if used naively, so three findings from
 * spike 3 are enforced here rather than left to the caller.
 *
 * `footerColorStyle` is never sent. It reads like a colour and behaves like a
 * command: it converts the Table's last data row into a footer and overwrites
 * that row's cells with SUM formulas, silently. A totals row has to be asked
 * for explicitly, and this tool does not offer one.
 *
 * A Table's DROPDOWN column carries its rule on the Table, not on its cells, so
 * this tool is the only way to change one, and it refuses to rewrite a rule the
 * plugin did not create. Spike 4 measured what a rewrite costs: an identical
 * condition, re-applied, wiped the chip colours a person had set by hand, and
 * the API reported success. Those colours are not readable in either direction,
 * so nothing could have saved them first.
 *
 * `adopt` writes metadata and notes and nothing else. Adopting is what happens
 * to somebody else's sheet, and the polite version of that is to record what
 * the columns mean without repainting anything.
 */
import { z } from "zod";
import { a1ToGridRange, columnIndexToLetter, gridRangeToA1, parseA1, quoteSheetName, } from "../lib/a1.js";
import { runBatchUpdate, withRetry } from "../lib/batch.js";
import { assertWritable } from "../lib/registry.js";
import { recordWrite } from "../lib/writelog.js";
import { fingerprintRule } from "../lib/cfrules.js";
import { COLUMN_ROLES, METADATA_KEYS } from "../lib/contract.js";
import { err, GsheetsError } from "../lib/errors.js";
import { columnRecords, hasColumnRecord, hasManifest, hasSheetRecord, presetFor, readMetadata, sheetRecord, } from "../lib/metaread.js";
import { count, guarded, lines, listOf, ok } from "../lib/result.js";
import { numberFormatForColumnType, STATUS_ROLES, tableRowsProperties, } from "../lib/tablecolors.js";
import { buildColumnProperties, columnLetterOf, columnMetadataWrite, describeTableRange, headerRangeOf, metadataRequest, requireBoundedRange, statusFillGate, statusFillSpecs, TABLE_COLUMN_TYPES, } from "../lib/tables.js";
import { statusRuleFor } from "./conditional_format.js";
const STATE_MASK = [
    "sheets.properties(sheetId,title,gridProperties(rowCount,columnCount,frozenRowCount))",
    "sheets.tables(tableId,name,range,columnProperties(columnIndex,columnName,columnType,dataValidationRule(condition(type,values(userEnteredValue)))))",
    "sheets.protectedRanges(protectedRangeId,range,warningOnly,description)",
    "sheets.conditionalFormats(ranges,booleanRule(condition(type,values(userEnteredValue)),format(backgroundColorStyle)))",
    "sheets.basicFilter(range,tableId)",
    "sheets.data(startRow,startColumn,rowData.values(formattedValue,note,userEnteredFormat.backgroundColorStyle,dataValidation(condition(type,values(userEnteredValue)))))",
].join(",");
const columnSchema = z.object({
    name: z.string().min(1).describe("The header text, which is also the Table column's name."),
    type: z
        .enum(TABLE_COLUMN_TYPES)
        .optional()
        .describe("The column type. TEXT when omitted. DROPDOWN needs options or options_range."),
    options: z.array(z.string()).optional().describe("The options of a DROPDOWN column."),
    options_range: z
        .string()
        .optional()
        .describe('Where a dropdown\'s options live instead, with the tab name, for example "Lists!A2:A20".'),
    note: z
        .string()
        .optional()
        .describe("A note on the header cell saying what belongs in this column, in a sentence a colleague would write."),
    role: z
        .enum(COLUMN_ROLES)
        .optional()
        .describe("What the column is for: key, input, formula, status, log or check. Recorded as contract metadata."),
    owner: z
        .enum(["human", "shared", "agent"])
        .optional()
        .describe("Who the column belongs to. A human owned column is never written to without force."),
    key: z.string().optional().describe("A stable name, so renaming the header does not orphan the contract."),
});
export const tableInputSchema = {
    spreadsheet_id: z.string().describe("The spreadsheet id, the long id in the middle of the sheet's URL."),
    sheet: z.string().describe("The tab name, as it reads on the tab strip."),
    action: z
        .enum(["create", "adopt", "update", "delete"])
        .describe("create makes a Table and paints it. adopt records what an existing block means and paints nothing. update changes an existing Table. delete removes the Table, leaving the values."),
    name: z
        .string()
        .optional()
        .describe("The Table's name, which formulas can use. Required for create; identifies the Table otherwise."),
    range: z
        .string()
        .optional()
        .describe("The whole block including the header row, for example A1:F40. A Table cannot cover an open range like A:F."),
    columns: z
        .array(columnSchema)
        .optional()
        .describe("One entry per column, left to right. Read from the header row when omitted on create."),
    preset: z.string().optional().describe("Which preset to paint with. Defaults to the preset the sheet records."),
    freeze_header: z.boolean().optional().describe("Freeze the header row. Default true when the Table starts at row 1."),
    filter: z.boolean().optional().describe("Attach a filter to the Table, which tracks it as it grows. Default true."),
    protect_header: z
        .boolean()
        .optional()
        .describe("Put a warning only protection on the header row, so renaming a column asks first. Default true."),
    status_fill_rules: z
        .boolean()
        .optional()
        .describe("Paint each option of a DROPDOWN column with its status colour, using conditional format rules. This is how the plugin stands in for chip colours, which the API cannot set. Only on sheets the plugin created."),
    status_column: z
        .string()
        .optional()
        .describe("Which dropdown column the status fills apply to. The first DROPDOWN column when omitted."),
    status_colors: z
        .record(z.string(), z.enum(STATUS_ROLES))
        .optional()
        .describe('Override the colour of an option, for example { "On hold": "warn" }.'),
    confirm: z.string().optional().describe("For delete: the Table's name, typed again."),
    force: z
        .boolean()
        .optional()
        .describe("Rewrite a dropdown rule this plugin did not create. Its chip colours will be lost."),
    dry_run: z.boolean().optional().describe("Report what would be sent, and send nothing."),
};
export function createTableTool(deps) {
    return {
        name: "sheets_table",
        config: {
            title: "Native Tables",
            description: "Create, adopt, update or delete a native Table: typed columns including dropdowns, header notes, preset header and band colours, a frozen header, a filter that tracks the Table, warning only header protection, and column contract metadata. adopt records what an existing block means without repainting it.",
            inputSchema: tableInputSchema,
            annotations: { openWorldHint: true },
        },
        handler: guarded(async (raw) => {
            const args = raw;
            const ctx = await deps.getContext();
            const info = await ctx.cache.resolve(args.spreadsheet_id, args.sheet);
            assertWritable(ctx.registry?.policyFor(args.spreadsheet_id, info.title), {
                tool: "sheets_table",
                ...(args.force === true ? { force: true } : {}),
            });
            const readRange = args.range?.trim();
            if (readRange)
                parseA1(readRange);
            const reference = readRange
                ? `${quoteSheetName(info.title)}!${readRange}`
                : quoteSheetName(info.title);
            const state = await readState(ctx, args.spreadsheet_id, info.sheetId, reference);
            const snapshot = await readMetadata(ctx.sheets, args.spreadsheet_id);
            const preset = presetFor(snapshot, info.sheetId, args.preset);
            switch (args.action) {
                case "create":
                    return createTable(ctx, args, state, snapshot, preset);
                case "adopt":
                    return adoptTable(ctx, args, state, snapshot);
                case "update":
                    return updateTable(ctx, args, state, snapshot, preset);
                default:
                    return deleteTable(ctx, args, state);
            }
        }),
    };
}
// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------
/**
 * Put the Table's range in the session's write ledger.
 *
 * Creating, adopting, updating or deleting a Table changes typed columns,
 * dropdowns, banding and header notes across a block a colleague may own.
 * None of that leaves a mark saying who did it, so lint rule L14 reads this
 * ledger instead.
 */
function recordTableRange(args, state, range) {
    if (args.dry_run === true || !range)
        return;
    recordWrite({
        spreadsheetId: args.spreadsheet_id,
        range: `${quoteSheetName(state.title)}!${gridRangeToA1(range)}`,
        sheet: state.title,
        tool: "sheets_table",
    });
}
async function createTable(ctx, args, state, snapshot, preset) {
    const name = requireName(args, "create");
    if (!args.range?.trim()) {
        throw err.invalid("range is required to create a Table.", "Give the whole block including the header row, for example A1:F40. The Table grows on its own from there.");
    }
    const range = requireBoundedRange(a1ToGridRange(args.range, state.sheetId), args.range);
    const clash = state.tables.find((t) => overlapsRange(t.range, range));
    if (clash) {
        throw new GsheetsError("invalid_argument", `The Table "${clash.name ?? clash.tableId}" already covers ${clash.range ? gridRangeToA1(clash.range) : "part of that range"}.`, "Use action update to change it, action adopt to record what its columns mean, or pick a range that does not overlap it.", { tableId: clash.tableId });
    }
    if (state.tables.some((t) => (t.name ?? "").toLowerCase() === name.toLowerCase())) {
        throw new GsheetsError("invalid_argument", `This tab already has a Table named "${name}".`, "Table names have to be unique. Pick another name, or use action update.");
    }
    const width = range.endColumnIndex - range.startColumnIndex;
    const headers = headerRowFrom(state, range);
    const columns = resolveColumns(args, headers, width);
    const columnProperties = buildColumnProperties(columns);
    // Two round trips, on purpose: setBasicFilter binds to a tableId, and the id
    // only exists after addTable has run. Everything that does not need the id
    // rides in the second batch with it.
    const headerRequest = headerCellRequests(columns, range, state.sheetId);
    const addRequest = {
        addTable: {
            table: {
                name,
                range,
                rowsProperties: tableRowsProperties(preset),
                columnProperties,
            },
        },
    };
    if (args.dry_run) {
        return ok(lines(`Dry run. Would create the Table "${name}" over ${gridRangeToA1(range)} on ${state.title}.`, `Columns: ${listOf(columns.map((c) => `${c.name}${c.type ? ` (${c.type})` : ""}`))}.`, "Nothing was sent."), {
            spreadsheet_id: args.spreadsheet_id,
            sheet: state.title,
            action: "create",
            applied: false,
            dry_run: true,
            name,
            range: gridRangeToA1(range),
            columns: columns.map((c) => ({ name: c.name, type: c.type ?? "TEXT", role: c.role ?? null })),
            requests: [...headerRequest, addRequest],
        });
    }
    const added = await runBatchUpdate(ctx.sheets, args.spreadsheet_id, [
        ...headerRequest,
        addRequest,
    ]);
    const tableId = tableIdFrom(added.response);
    const follow = [];
    const notes = [];
    follow.push(...headerNoteRequests(columns, range, state.sheetId));
    const formatNote = numberFormatNote(columns, preset);
    if (formatNote)
        notes.push(formatNote);
    if (args.freeze_header !== false) {
        if (range.startRowIndex === 0) {
            follow.push({
                updateSheetProperties: {
                    properties: { sheetId: state.sheetId, gridProperties: { frozenRowCount: 1 } },
                    fields: "gridProperties.frozenRowCount",
                },
            });
        }
        else {
            notes.push(`The header sits on row ${range.startRowIndex + 1}, and Sheets can only freeze from row 1 down, so it was left unfrozen.`);
        }
    }
    if (args.filter !== false && tableId) {
        follow.push({ setBasicFilter: { filter: { tableId } } });
    }
    if (args.protect_header !== false) {
        follow.push({
            addProtectedRange: {
                protectedRange: {
                    range: headerRangeOf(range),
                    warningOnly: true,
                    description: `Header of the ${name} table. Renaming a column here breaks the formulas and the contract that point at it.`,
                },
            },
        });
    }
    const statusResult = statusFillRequests(args, columns, range, preset, state, {
        creatingNow: true,
        registryOwner: registryOwner(ctx, args.spreadsheet_id, state.title),
    });
    follow.push(...statusResult.requests);
    if (statusResult.note)
        notes.push(statusResult.note);
    const record = {
        ...(sheetRecord(snapshot, state.sheetId) ?? {}),
        origin: "plugin",
        preset: preset.name,
        archetype: preset.archetype_default ?? "tracker",
        headerRow: range.startRowIndex + 1,
        table: { name, range: gridRangeToA1(range), ...(tableId ? { tableId } : {}) },
    };
    const keyColumn = columns.findIndex((c) => c.role === "key");
    if (keyColumn >= 0)
        record.keyColumn = columnLetterOf(range, keyColumn);
    if (statusResult.fills.length)
        record.statusFills = statusResult.fills;
    follow.push(...contractRequests({
        snapshot,
        sheetId: state.sheetId,
        range,
        columns,
        columnProperties,
        record,
        preset,
    }));
    const followed = await runBatchUpdate(ctx.sheets, args.spreadsheet_id, follow);
    recordTableRange(args, state, range);
    const structured = {
        spreadsheet_id: args.spreadsheet_id,
        sheet: state.title,
        action: "create",
        applied: true,
        dry_run: false,
        name,
        table_id: tableId ?? null,
        range: gridRangeToA1(range),
        preset: preset.name,
        columns: columns.map((c, i) => ({
            name: c.name,
            letter: columnLetterOf(range, i),
            type: c.type ?? "TEXT",
            role: c.role ?? null,
            owner: c.owner ?? null,
            options: c.options ?? null,
            note: c.note ?? null,
        })),
        frozen_header: args.freeze_header !== false && range.startRowIndex === 0,
        filtered: args.filter !== false && !!tableId,
        header_protected: args.protect_header !== false,
        status_fills: statusResult.fills,
        request_count: added.requestCount + followed.requestCount,
        notes,
    };
    return ok(lines(describeTableRange(name, range, gridRangeToA1(range)), `Columns: ${listOf(columns.map((c, i) => `${columnLetterOf(range, i)} ${c.name}${c.type && c.type !== "TEXT" ? ` (${c.type.toLowerCase()})` : ""}`))}.`, `Painted with the ${preset.name} preset: header fill, two band colours, no footer.`, args.filter !== false && tableId ? "A filter is attached to the Table, so it follows the Table as rows are added." : undefined, args.protect_header !== false ? "The header row carries a warning only protection." : undefined, statusResult.fills.length
        ? `Status colours painted as ${count(statusResult.fills.length, "conditional format rule")}, because the API cannot colour dropdown chips.`
        : undefined, `Contract metadata written for ${count(columns.length, "column")}.`, ...notes.map((n) => `- ${n}`), "Add rows with sheets_write append, which is the only path that both writes the values and extends the Table."), structured);
}
// ---------------------------------------------------------------------------
// adopt
// ---------------------------------------------------------------------------
async function adoptTable(ctx, args, state, snapshot) {
    const existing = findTable(args, state);
    const range = existing?.range
        ? requireBoundedRange({ ...existing.range, sheetId: state.sheetId }, args.range ?? "the Table's range")
        : args.range
            ? requireBoundedRange(a1ToGridRange(args.range, state.sheetId), args.range)
            : undefined;
    if (!range) {
        throw err.invalid("Nothing to adopt.", "Pass range to adopt a block, or name to adopt an existing Table. Adopting records what the columns mean and changes nothing else.");
    }
    const width = range.endColumnIndex - range.startColumnIndex;
    const headers = headerRowFrom(state, range);
    const columns = resolveColumns(args, headers, width, existing);
    const requests = [];
    requests.push(...headerNoteRequests(columns, range, state.sheetId));
    const record = {
        ...(sheetRecord(snapshot, state.sheetId) ?? {}),
        origin: "adopted",
        headerRow: range.startRowIndex + 1,
    };
    if (existing) {
        record.table = {
            name: existing.name ?? args.name ?? "the adopted Table",
            range: gridRangeToA1(range),
            ...(existing.tableId ? { tableId: existing.tableId } : {}),
        };
    }
    const keyColumn = columns.findIndex((c) => c.role === "key");
    if (keyColumn >= 0)
        record.keyColumn = columnLetterOf(range, keyColumn);
    requests.push(...contractRequests({
        snapshot,
        sheetId: state.sheetId,
        range,
        columns,
        columnProperties: existing?.columnProperties,
        record,
    }));
    const result = await runBatchUpdate(ctx.sheets, args.spreadsheet_id, requests, {
        dryRun: args.dry_run === true,
    });
    recordTableRange(args, state, range);
    // Spike 3: a cell a person filled by hand keeps that fill and overrides the
    // Table's band colour, so an adopted range can look patchy. Say so rather
    // than clearing somebody's highlighting.
    const handFilled = handFilledCells(state, range);
    const uiValidation = uiOwnedColumns(state, range, snapshot);
    const warnings = [];
    if (handFilled.length) {
        warnings.push(`${count(handFilled.length, "cell")} inside the range carries a fill somebody set by hand (${listOf(handFilled.slice(0, 6))}${handFilled.length > 6 ? ", and more" : ""}). Those fills sit on top of any banding, so the block will look patchy until somebody clears them. Nothing was changed.`);
    }
    if (uiValidation.length) {
        warnings.push(`${listOf(uiValidation.map((c) => `column ${c}`))} carries a dropdown set outside this plugin. Its chip colours cannot be read through the API, so it was recorded and left alone.`);
    }
    return ok(lines(`Adopted ${existing ? `the Table "${existing.name ?? existing.tableId}"` : gridRangeToA1(range)} on ${state.title}.`, `Recorded what ${count(columns.length, "column")} means, plus ${count(columns.filter((c) => c.note).length, "header note")}. Nothing was repainted.`, ...warnings.map((w) => `- ${w}`), "Adopting is deliberately quiet: it writes contract metadata and notes only, so somebody else's formatting survives untouched."), {
        spreadsheet_id: args.spreadsheet_id,
        sheet: state.title,
        action: "adopt",
        applied: args.dry_run !== true,
        dry_run: args.dry_run === true,
        name: existing?.name ?? args.name ?? null,
        table_id: existing?.tableId ?? null,
        range: gridRangeToA1(range),
        is_native_table: !!existing,
        columns: columns.map((c, i) => ({
            name: c.name,
            letter: columnLetterOf(range, i),
            type: c.type ?? null,
            role: c.role ?? null,
            owner: c.owner ?? null,
        })),
        hand_filled_cells: handFilled,
        ui_owned_columns: uiValidation,
        request_count: result.requestCount,
        warnings,
    });
}
// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------
async function updateTable(ctx, args, state, snapshot, preset) {
    const existing = findTable(args, state);
    if (!existing) {
        throw new GsheetsError("not_found", args.name ? `No Table named "${args.name}" on ${state.title}.` : `No Table found on ${state.title}.`, state.tables.length
            ? `The Tables on this tab are: ${state.tables.map((t) => t.name ?? t.tableId).join(", ")}.`
            : "This tab has no native Table. Use action create to make one, or action adopt to record what an ordinary block means.");
    }
    const range = requireBoundedRange({ ...(existing.range ?? {}), sheetId: state.sheetId }, existing.name ?? existing.tableId);
    const table = { tableId: existing.tableId };
    const fields = [];
    const changes = [];
    if (args.name?.trim() && args.name.trim() !== existing.name) {
        table["name"] = args.name.trim();
        fields.push("name");
        changes.push(`renamed to ${args.name.trim()}`);
    }
    let newRange = range;
    if (args.range?.trim()) {
        newRange = requireBoundedRange(a1ToGridRange(args.range, state.sheetId), args.range);
        if (gridRangeToA1(newRange) !== gridRangeToA1(range)) {
            table["range"] = newRange;
            fields.push("range");
            changes.push(`range moved to ${gridRangeToA1(newRange)}`);
        }
    }
    let columns = [];
    let columnProperties = [];
    if (args.columns?.length) {
        const width = newRange.endColumnIndex - newRange.startColumnIndex;
        columns = resolveColumns(args, headerRowFrom(state, newRange), width, existing);
        columnProperties = buildColumnProperties(columns);
        const flagged = guardDropdownRewrites(columns, existing, snapshot, state.sheetId, newRange);
        if (flagged.length && !args.force) {
            throw new GsheetsError("ui_owned", `${listOf(flagged)} already carries a dropdown this plugin did not create.`, "Rewriting it would discard the chip colours somebody set in the Sheets interface. The API cannot read those colours back, so nothing can save them first. That is measured, not a precaution: an identical rewrite wiped them in testing. Leave the rule alone, or pass force if losing the colours is acceptable.", { columns: flagged });
        }
        if (flagged.length) {
            changes.push(`rewrote the dropdown on ${listOf(flagged)}, losing any chip colours set in the UI`);
        }
        table["columnProperties"] = columnProperties;
        fields.push("columnProperties");
        changes.push(`${count(columns.length, "column")} redefined`);
    }
    if (fields.length === 0) {
        throw err.invalid("Nothing to change.", "Pass columns to retype or re-option them, name to rename the Table, or range to move it.");
    }
    const requests = [{ updateTable: { table, fields: fields.join(",") } }];
    if (columns.length) {
        requests.push(...headerNoteRequests(columns, newRange, state.sheetId));
        const record = {
            ...(sheetRecord(snapshot, state.sheetId) ?? {}),
            table: {
                name: table["name"] ?? existing.name ?? "",
                range: gridRangeToA1(newRange),
                tableId: existing.tableId,
            },
        };
        requests.push(...contractRequests({
            snapshot,
            sheetId: state.sheetId,
            range: newRange,
            columns,
            columnProperties,
            record,
            preset,
        }));
    }
    const result = await runBatchUpdate(ctx.sheets, args.spreadsheet_id, requests, {
        dryRun: args.dry_run === true,
    });
    recordTableRange(args, state, range);
    return ok(lines(`${args.dry_run ? "Would update" : "Updated"} the Table "${existing.name ?? existing.tableId}" on ${state.title}: ${listOf(changes)}.`, columns.length
        ? "A Table column's dropdown lives on the Table rather than on its cells, so this is the only place it can be changed."
        : undefined), {
        spreadsheet_id: args.spreadsheet_id,
        sheet: state.title,
        action: "update",
        applied: args.dry_run !== true,
        dry_run: args.dry_run === true,
        table_id: existing.tableId,
        name: table["name"] ?? existing.name ?? null,
        range: gridRangeToA1(newRange),
        fields: fields.join(","),
        changes,
        columns: columns.map((c, i) => ({
            name: c.name,
            letter: columnLetterOf(newRange, i),
            type: c.type ?? "TEXT",
            options: c.options ?? null,
        })),
        request_count: result.requestCount,
    });
}
// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------
async function deleteTable(ctx, args, state) {
    const existing = findTable(args, state);
    if (!existing) {
        throw new GsheetsError("not_found", args.name ? `No Table named "${args.name}" on ${state.title}.` : `No Table found on ${state.title}.`, state.tables.length
            ? `The Tables on this tab are: ${state.tables.map((t) => t.name ?? t.tableId).join(", ")}.`
            : "This tab has no native Table, so there is nothing to delete.");
    }
    const label = existing.name ?? existing.tableId;
    if ((args.confirm ?? "").trim().toLowerCase() !== label.toLowerCase()) {
        throw new GsheetsError("needs_confirmation", `Deleting the Table "${label}" needs confirmation.`, `Pass confirm: "${label}". The rows and their values stay where they are; what goes is the Table itself, its typed columns, its dropdowns, its banding and its filter.`, { table: label });
    }
    const result = await runBatchUpdate(ctx.sheets, args.spreadsheet_id, [{ deleteTable: { tableId: existing.tableId } }], { dryRun: args.dry_run === true });
    recordTableRange(args, state, existing.range ? { ...existing.range, sheetId: state.sheetId } : undefined);
    return ok(lines(`${args.dry_run ? "Would delete" : "Deleted"} the Table "${label}" on ${state.title}.`, "The values stay. What went is the Table: its typed columns, the dropdowns that lived on them, its banding and its filter.", "The contract metadata on those columns was left in place, so a later adopt picks up where this left off."), {
        spreadsheet_id: args.spreadsheet_id,
        sheet: state.title,
        action: "delete",
        applied: args.dry_run !== true,
        dry_run: args.dry_run === true,
        table_id: existing.tableId,
        name: existing.name ?? null,
        request_count: result.requestCount,
    });
}
// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------
async function readState(ctx, spreadsheetId, sheetId, reference) {
    const res = await withRetry(() => ctx.sheets.spreadsheets.get({
        spreadsheetId,
        ranges: [reference],
        includeGridData: true,
        fields: STATE_MASK,
    }));
    const sheets = res.data.sheets ?? [];
    const sheet = sheets.find((s) => s.properties?.sheetId === sheetId) ?? sheets[0];
    const block = sheet?.data?.[0];
    return {
        sheetId,
        title: sheet?.properties?.title ?? "",
        frozenRowCount: sheet?.properties?.gridProperties?.frozenRowCount ?? 0,
        tables: sheet?.tables ?? [],
        protectedRanges: sheet?.protectedRanges ?? [],
        conditionalFormats: sheet?.conditionalFormats ?? [],
        basicFilter: sheet?.basicFilter,
        grid: {
            startRow: block?.startRow ?? 0,
            startColumn: block?.startColumn ?? 0,
            rows: (block?.rowData ?? []).map((row) => (row.values ?? []).map((cell) => ({
                value: cell["formattedValue"],
                note: cell["note"],
                fill: cell["userEnteredFormat"]?.backgroundColorStyle,
                validation: cell["dataValidation"],
            }))),
        },
    };
}
function requireName(args, action) {
    const name = String(args.name ?? "").trim();
    if (!name) {
        throw err.invalid(`name is required to ${action} a Table.`, 'Give it the name a person would use in a formula, for example name: "Instructors".');
    }
    return name;
}
function findTable(args, state) {
    const wanted = args.name?.trim().toLowerCase();
    if (wanted) {
        const byName = state.tables.find((t) => (t.name ?? "").toLowerCase() === wanted);
        if (byName)
            return byName;
    }
    if (args.range?.trim()) {
        const range = a1ToGridRange(args.range, state.sheetId);
        const byRange = state.tables.find((t) => overlapsRange(t.range, range));
        if (byRange)
            return byRange;
    }
    if (!wanted && !args.range && state.tables.length === 1)
        return state.tables[0];
    return undefined;
}
function overlapsRange(a, b) {
    if (!a)
        return false;
    const rowsOverlap = (a.startRowIndex ?? 0) < (b.endRowIndex ?? Number.MAX_SAFE_INTEGER) &&
        (b.startRowIndex ?? 0) < (a.endRowIndex ?? Number.MAX_SAFE_INTEGER);
    const colsOverlap = (a.startColumnIndex ?? 0) < (b.endColumnIndex ?? Number.MAX_SAFE_INTEGER) &&
        (b.startColumnIndex ?? 0) < (a.endColumnIndex ?? Number.MAX_SAFE_INTEGER);
    return rowsOverlap && colsOverlap;
}
/** The header row as it currently reads, so columns need not be retyped. */
function headerRowFrom(state, range) {
    const rowIndex = range.startRowIndex - state.grid.startRow;
    const row = state.grid.rows[rowIndex] ?? state.grid.rows[0] ?? [];
    const offset = range.startColumnIndex - state.grid.startColumn;
    const width = range.endColumnIndex - range.startColumnIndex;
    const out = [];
    for (let i = 0; i < width; i += 1) {
        out.push(String(row[offset + i]?.value ?? "").trim());
    }
    return out;
}
/**
 * The columns to work with: what the caller passed, or the header row read off
 * the sheet. Reading the header is what makes `create` over an existing block a
 * one line call rather than a transcription exercise.
 */
function resolveColumns(args, headers, width, existing) {
    if (args.columns?.length) {
        if (args.columns.length !== width) {
            throw err.invalid(`The range is ${width} columns wide but ${args.columns.length} column${args.columns.length === 1 ? " was" : "s were"} given.`, "One entry per column, left to right, including the ones that need no type. Or leave columns out and let the header row name them.");
        }
        return args.columns;
    }
    const fromTable = new Map((existing?.columnProperties ?? []).map((c) => [c.columnIndex ?? 0, c]));
    const columns = [];
    for (let i = 0; i < width; i += 1) {
        const header = headers[i] || fromTable.get(i)?.columnName || `Column ${columnIndexToLetter(i)}`;
        const spec = { name: header };
        const type = fromTable.get(i)?.columnType;
        if (type && type !== "COLUMN_TYPE_UNSPECIFIED")
            spec.type = type;
        columns.push(spec);
    }
    if (columns.every((c) => /^Column [A-Z]+$/.test(c.name))) {
        throw err.invalid("That range has no header row to read column names from.", "Pass columns explicitly, or point range at a block whose first row holds the headers.");
    }
    return columns;
}
/**
 * Write the column names into the header cells, before the Table exists.
 *
 * `columns[].name` is described as the header text, and until this it was only
 * ever the Table's internal `columnName`. A column whose header cell is empty
 * when `addTable` runs gets a display name Sheets invents for it, and then the
 * whole header row renders bracketed: `Student [1]` through `Check [10]`. The
 * golden build seeded the six columns a person fills in, left the four computed
 * ones to the tool, and every header in four renders carried an index.
 *
 * It rides in the same batch as `addTable`, ahead of it, because requests in a
 * batchUpdate apply in order. So the headers are in place by the time the Table
 * is created, at no extra round trip.
 *
 * Names go in as `stringValue` rather than through USER_ENTERED parsing. A
 * header is a label: one reading `10/1` should stay those three characters
 * rather than becoming a date, and one reading `2026` should stay text.
 *
 * `adopt` does not call this. Adopting is explicitly not repainting, so it
 * keeps reading the row as it finds it.
 */
function headerCellRequests(columns, range, sheetId) {
    return [
        {
            updateCells: {
                start: { sheetId, rowIndex: range.startRowIndex, columnIndex: range.startColumnIndex },
                rows: [
                    {
                        values: columns.map((column) => ({
                            userEnteredValue: { stringValue: column.name },
                        })),
                    },
                ],
                fields: "userEnteredValue",
            },
        },
    ];
}
/** Notes on the header cells, which is where a column explains itself. */
function headerNoteRequests(columns, range, sheetId) {
    const withNotes = columns.filter((c) => c.note?.trim());
    if (!withNotes.length)
        return [];
    return [
        {
            updateCells: {
                start: { sheetId, rowIndex: range.startRowIndex, columnIndex: range.startColumnIndex },
                rows: [{ values: columns.map((c) => (c.note?.trim() ? { note: c.note.trim() } : {})) }],
                fields: "note",
            },
        },
    ];
}
/**
 * What a typed column will and will not let the preset decide.
 *
 * A Table column's type governs how its cells display, and it wins. Writing
 * `{ type: CURRENCY, pattern: "\"$\"#,##0" }` into a CURRENCY column comes back
 * as `{ type: CURRENCY }` with the pattern stripped, so the cell renders in the
 * locale default ($1,234.50) rather than in the preset's pattern ($1,235). The
 * identical write to a cell outside the Table keeps its pattern. Verified live
 * on 2026-09-07.
 *
 * So the tool does not send number formats for typed columns at all: they would
 * be discarded, and reporting them as applied would be a lie. This returns the
 * note that says so instead.
 */
function numberFormatNote(columns, preset) {
    const typed = columns.filter((c) => numberFormatForColumnType(preset, c.type));
    if (!typed.length)
        return undefined;
    return `${listOf(typed.map((c) => `${c.name} (${c.type?.toLowerCase()})`))} display in the format their Table column type dictates, which overrides the ${preset.name} preset's number patterns. That is the Table's doing, not a setting: a pattern written into a typed column is discarded.`;
}
/** The developer metadata that makes this block's contract readable later. */
function contractRequests(input) {
    const requests = [];
    const types = new Map((input.columnProperties ?? []).map((c) => [c.columnIndex ?? 0, c.columnType]));
    input.columns.forEach((column, index) => {
        const columnIndex = input.range.startColumnIndex + index;
        requests.push(metadataRequest(columnMetadataWrite({
            sheetId: input.sheetId,
            columnIndex,
            column,
            type: types.get(index) ?? column.type,
            exists: hasColumnRecord(input.snapshot, input.sheetId, columnIndex),
        })));
    });
    requests.push(metadataRequest({
        key: METADATA_KEYS.sheet,
        value: input.record,
        location: { sheetId: input.sheetId },
        exists: hasSheetRecord(input.snapshot, input.sheetId),
    }));
    if (!hasManifest(input.snapshot)) {
        requests.push(metadataRequest({
            key: METADATA_KEYS.manifest,
            value: {
                version: 1,
                preset: input.preset?.name ?? input.snapshot.manifest?.preset,
                archetype: input.preset?.archetype_default ?? "tracker",
                createdBy: "gsheets-pro",
                createdAt: new Date().toISOString().slice(0, 10),
            },
            location: { spreadsheet: true },
            exists: false,
        }));
    }
    return requests;
}
/**
 * The conditional format rules that stand in for chip colours.
 *
 * The API has no colour field on a validation rule, so a dropdown cannot be
 * given coloured chips through it at all. One boolean rule per option, drawn
 * from the preset's status roles, produces the same reading at a glance. They
 * are only painted on a sheet the plugin created, because on somebody else's
 * sheet a set of rules the plugin will later rewrite is a set of rules that
 * will one day overwrite theirs.
 */
function statusFillRequests(args, columns, range, preset, state, gateInput) {
    if (args.status_fill_rules !== true)
        return { requests: [], fills: [] };
    const wanted = args.status_column?.trim().toLowerCase();
    const index = wanted
        ? columns.findIndex((c) => c.name.trim().toLowerCase() === wanted)
        : columns.findIndex((c) => c.type === "DROPDOWN");
    if (index < 0) {
        return {
            requests: [],
            fills: [],
            note: wanted
                ? `No column called "${args.status_column}", so no status colours were painted.`
                : "No DROPDOWN column, so there was nothing to colour. Status fills stand in for dropdown chips.",
        };
    }
    const column = columns[index];
    if (!column.options?.length) {
        return {
            requests: [],
            fills: [],
            note: `The column "${column.name}" takes its options from a range rather than a fixed list, so its options are not known here and no status colours were painted.`,
        };
    }
    const gate = statusFillGate({
        creatingNow: gateInput.creatingNow,
        registryOwner: gateInput.registryOwner,
        existingRuleCount: state.conditionalFormats.length,
    });
    if (!gate.allowed)
        return { requests: [], fills: [], note: gate.reason };
    const letter = columnLetterOf(range, index);
    const rangeA1 = `${letter}${range.startRowIndex + 2}:${letter}${range.endRowIndex}`;
    const specs = statusFillSpecs(column.options, args.status_colors ?? {});
    const requests = [];
    const fills = [];
    specs.forEach((spec, order) => {
        const rule = statusRuleFor(range.sheetId, rangeA1, spec.option, spec.role, preset);
        requests.push({ addConditionalFormatRule: { rule, index: order } });
        fills.push({ column: letter, option: spec.option, role: spec.role, fingerprint: fingerprintRule(rule) });
    });
    return { requests, fills };
}
/** Columns whose dropdown would be rewritten but is not the plugin's to touch. */
function guardDropdownRewrites(columns, existing, snapshot, sheetId, range) {
    const records = columnRecords(snapshot, sheetId);
    const current = new Map((existing.columnProperties ?? []).map((c) => [c.columnIndex ?? 0, c]));
    const flagged = [];
    columns.forEach((column, index) => {
        const before = current.get(index);
        if (!before?.dataValidationRule)
            return;
        const wantsChange = column.type === "DROPDOWN" && (column.options?.length !== undefined || column.options_range !== undefined);
        if (!wantsChange)
            return;
        const absolute = range.startColumnIndex + index;
        if (records.has(absolute))
            return;
        flagged.push(`${columnIndexToLetter(absolute)} (${before.columnName ?? column.name})`);
    });
    return flagged;
}
/** Cells inside a range carrying a fill somebody set on the cell itself. */
function handFilledCells(state, range) {
    const out = [];
    state.grid.rows.forEach((row, r) => {
        const rowIndex = state.grid.startRow + r;
        if (rowIndex < range.startRowIndex + 1 || rowIndex >= range.endRowIndex)
            return;
        row.forEach((cell, c) => {
            const columnIndex = state.grid.startColumn + c;
            if (columnIndex < range.startColumnIndex || columnIndex >= range.endColumnIndex)
                return;
            if (!cell.fill)
                return;
            out.push(`${columnIndexToLetter(columnIndex)}${rowIndex + 1}`);
        });
    });
    return out;
}
/** Columns with a validation rule that the plugin has no record of writing. */
function uiOwnedColumns(state, range, snapshot) {
    const records = columnRecords(snapshot, state.sheetId);
    const seen = new Set();
    state.grid.rows.forEach((row) => {
        row.forEach((cell, c) => {
            if (!cell.validation)
                return;
            seen.add(state.grid.startColumn + c);
        });
    });
    return [...seen]
        .filter((columnIndex) => columnIndex >= range.startColumnIndex && columnIndex < range.endColumnIndex)
        .filter((columnIndex) => !records.has(columnIndex))
        .sort((a, b) => a - b)
        .map((columnIndex) => columnIndexToLetter(columnIndex));
}
function registryOwner(ctx, spreadsheetId, sheet) {
    return ctx.registry?.policyFor(spreadsheetId, sheet)?.owner;
}
/** The tableId out of an addTable reply. */
function tableIdFrom(response) {
    const replies = response?.replies ?? [];
    for (const reply of replies) {
        const id = reply.addTable?.table?.tableId;
        if (id)
            return id;
    }
    return undefined;
}
//# sourceMappingURL=table.js.map