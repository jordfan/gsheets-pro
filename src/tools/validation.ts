/**
 * `sheets_validation`: dropdowns, checkboxes, and the rest of the rules that
 * decide what a cell will accept.
 *
 * The whole tool turns on one restraint. The Sheets API has no color field on
 * any validation rule, so the chip colors a person picked in the UI cannot be
 * read and cannot be written back, and rewriting a rule with a condition
 * identical to the one already there still discards them. A dropdown the plugin
 * did not create is therefore treated as the human's: reported, not touched,
 * and changed only when the caller passes `force` and accepts losing the
 * colors.
 *
 * The second restraint comes from spike 3. On a native Table, a DROPDOWN
 * column's rule lives on the Table's column properties and not on its cells, so
 * setting cell validation there fights the Table rather than editing it. That
 * case is sent to `sheets_table update`.
 */

import { z } from "zod";

import {
  a1ToGridRange,
  columnIndexToLetter,
  gridRangeToA1,
  parseA1,
  quoteSheetName,
} from "../lib/a1.js";
import { withRetry, runBatchUpdate } from "../lib/batch.js";
import { buildCondition, CONDITION_KINDS, CONDITION_OPERATORS, describeCondition } from "../lib/conditions.js";
import { err, GsheetsError } from "../lib/errors.js";
import { columnRecords, readMetadata } from "../lib/metaread.js";
import { isColumnWritable } from "../lib/registry.js";
import { count, guarded, lines, listOf, ok, type ToolResponse } from "../lib/result.js";
import type { ToolDefinition, ToolDeps } from "./types.js";

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
] as const;

export const validationInputSchema = {
  spreadsheet_id: z.string().describe("The spreadsheet id, the long id in the middle of the sheet's URL."),
  sheet: z.string().describe("The tab name, as it reads on the tab strip."),
  range: z
    .string()
    .describe(
      "A1 range the rule covers, for example E2:E200 or E:E. Give the data rows only, not the header.",
    ),
  type: z
    .enum(VALIDATION_TYPES)
    .describe(
      "list is a dropdown of fixed options. source_range is a dropdown fed by a range elsewhere. checkbox, date, number and text constrain what may be typed. custom takes a formula. clear removes the rule.",
    ),
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
    .describe(
      "Help text shown when somebody selects the cell. Say what belongs there in a sentence, the way a colleague would explain it.",
    ),
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
    .describe(
      "Overwrite a rule this plugin did not create. Its chip colours cannot be read through the API and will be lost.",
    ),
  dry_run: z.boolean().optional().describe("Report what would be sent, and send nothing."),
};

type ValidationArgs = {
  spreadsheet_id: string;
  sheet: string;
  range: string;
  type: (typeof VALIDATION_TYPES)[number];
  values?: Array<string | number | boolean>;
  source_range?: string;
  operator?: (typeof CONDITION_OPERATORS)[number];
  kind?: "number" | "text" | "date";
  value?: string | number | boolean;
  value2?: string | number | boolean;
  formula?: string;
  help?: string;
  strict?: boolean;
  show_dropdown?: boolean;
  force?: boolean;
  dry_run?: boolean;
};

interface ExistingRule {
  column: number;
  conditionType?: string;
  values: string[];
}

export function createValidationTool(deps: ToolDeps): ToolDefinition<typeof validationInputSchema> {
  return {
    name: "sheets_validation",
    config: {
      title: "Set data validation",
      description:
        "Put a rule on a range: a dropdown from a list or from a source range, a checkbox, a date, number or text constraint, a custom formula, or clear. Refuses to overwrite a dropdown somebody set in the Sheets UI, because its chip colours cannot be read back and would be lost.",
      inputSchema: validationInputSchema,
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    handler: guarded(async (raw: Record<string, unknown>): Promise<ToolResponse> => {
      const args = raw as ValidationArgs;
      const ctx = await deps.getContext();
      const info = await ctx.cache.resolve(args.spreadsheet_id, args.sheet);

      const rangeA1 = String(args.range ?? "").trim();
      if (!rangeA1) {
        throw err.invalid(
          "range is required.",
          "Give the data rows the rule covers, for example E2:E200. A whole column such as E:E works too.",
        );
      }
      parseA1(rangeA1);
      const grid = a1ToGridRange(rangeA1, info.sheetId);
      const reference = `${quoteSheetName(info.title)}!${rangeA1}`;

      // The registry has the final word on which columns are ours to write.
      const policy = ctx.registry?.policyFor(args.spreadsheet_id, info.title);
      const refusals: string[] = [];
      const firstColumn = grid.startColumnIndex ?? 0;
      const lastColumn = (grid.endColumnIndex ?? firstColumn + 1) - 1;
      for (let c = firstColumn; c <= lastColumn && c - firstColumn < 50; c += 1) {
        const writable = isColumnWritable(policy, { letter: columnIndexToLetter(c) });
        if (!writable.writable && writable.reason) refusals.push(writable.reason);
      }
      if (refusals.length) {
        throw new GsheetsError(
          "contract_violation",
          refusals[0],
          "Validation changes what a colleague may type into their own column, so it follows the same rule as a write. Change the registry entry if the column really is ours.",
          { refusals },
        );
      }

      const state = await withRetry(() =>
        ctx.sheets.spreadsheets.get({
          spreadsheetId: args.spreadsheet_id,
          ranges: [reference],
          includeGridData: true,
          fields: STATE_MASK,
        }),
      );
      const sheet = (state.data.sheets ?? [])[0];

      // A Table's typed column carries its rule on the Table, not on the cells.
      const table = (sheet?.tables ?? []).find((t) =>
        overlaps(t.range, grid.startColumnIndex, grid.endColumnIndex),
      );
      if (table && !args.force) {
        const columnNames = (table.columnProperties ?? [])
          .filter((c) => {
            const absolute = (table.range?.startColumnIndex ?? 0) + (c.columnIndex ?? 0);
            return absolute >= firstColumn && absolute <= lastColumn;
          })
          .map((c) => `${c.columnName ?? "?"}${c.columnType ? ` (${c.columnType})` : ""}`);
        throw new GsheetsError(
          "invalid_argument",
          `${rangeA1} sits inside the Table "${table.name ?? table.tableId}", and a Table column's rule lives on the Table rather than on its cells.`,
          `Use sheets_table with action update to change ${columnNames.length ? listOf(columnNames) : "that column"}. Pass force to write cell level validation anyway, which will fight the Table's own typing.`,
          { tableId: table.tableId, tableName: table.name },
        );
      }

      const existing = collectExisting(sheet as unknown as GridBlocks, grid.startColumnIndex ?? 0);
      let uiOwnedColumns: string[] = [];
      if (existing.length > 0) {
        // Only worth a read when there is a rule that could be somebody's.
        const pluginColumns = await pluginOwnedColumns(ctx, args.spreadsheet_id, info.sheetId);
        uiOwnedColumns = existing
          .filter((e) => !pluginColumns.has(e.column))
          .map((e) => columnIndexToLetter(e.column));
      }
      if (uiOwnedColumns.length && !args.force) {
        throw new GsheetsError(
          "ui_owned",
          `${listOf(uiOwnedColumns.map((c) => `column ${c}`))} already carries a validation rule this plugin did not create.`,
          "Its chip colours were set in the Sheets UI, cannot be read through the API, and would be lost on a rewrite. Report it instead, or pass force if losing the colours is acceptable.",
          { columns: uiOwnedColumns, existing },
        );
      }

      const rule = args.type === "clear" ? undefined : buildRule(args);
      const request =
        rule === undefined
          ? { setDataValidation: { range: grid } }
          : { setDataValidation: { range: grid, rule } };

      const result = await runBatchUpdate(ctx.sheets as never, args.spreadsheet_id, [request], {
        dryRun: args.dry_run === true,
      });

      const description =
        rule === undefined
          ? `Cleared the validation on ${reference}.`
          : `${reference} now accepts ${describeCondition(rule.condition)}.`;

      const structured: Record<string, unknown> = {
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
        request_count: result.requestCount,
      };

      const notes: string[] = [];
      if (args.dry_run) notes.push("Dry run: nothing was sent.");
      if (uiOwnedColumns.length && args.force) {
        notes.push(
          `Overwrote a rule set outside this plugin on ${listOf(uiOwnedColumns)}. Any chip colours a person had chosen there are gone and cannot be restored through the API.`,
        );
      }
      if (existing.length && !uiOwnedColumns.length) {
        notes.push(`Replaced ${count(existing.length, "rule")} the plugin had set earlier.`);
      }
      if (rule && args.type === "list") {
        notes.push(
          "A rendered picture of the sheet will not show this dropdown as a chip, so use sheets_read or the lint to confirm it, not a render.",
        );
      }
      if (rule?.inputMessage) notes.push(`Help text: "${rule.inputMessage}"`);

      return ok(lines(description, ...notes.map((n) => `- ${n}`)), structured);
    }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DataValidationRule {
  condition: { type: string; values?: Array<{ userEnteredValue?: string; relativeDate?: string }> };
  strict?: boolean;
  showCustomUi?: boolean;
  inputMessage?: string;
}

function buildRule(args: ValidationArgs): DataValidationRule {
  const condition = buildCondition(conditionSpecFor(args));
  const rule: DataValidationRule = { condition };
  rule.strict = args.strict !== false;
  if (args.type === "list" || args.type === "source_range") {
    rule.showCustomUi = args.show_dropdown !== false;
  }
  if (args.help?.trim()) rule.inputMessage = args.help.trim();
  return rule;
}

function conditionSpecFor(args: ValidationArgs) {
  switch (args.type) {
    case "list":
      return { operator: "one_of_list" as const, values: args.values ?? [] };
    case "source_range":
      return { operator: "one_of_range" as const, source_range: args.source_range };
    case "checkbox":
      return { operator: "checkbox" as const, values: args.values };
    case "custom":
      return { operator: "custom_formula" as const, formula: args.formula, value: args.value };
    case "number":
    case "text":
    case "date": {
      if (!args.operator) {
        throw err.invalid(
          `A ${args.type} rule needs an operator.`,
          `For example operator: ${args.type === "text" ? "contains" : args.type === "date" ? "after" : "greater_than"}, with the value to compare against.`,
        );
      }
      const spec: {
        operator: (typeof CONDITION_OPERATORS)[number];
        kind: "number" | "text" | "date";
        value?: string | number | boolean;
        value2?: string | number | boolean;
      } = { operator: args.operator, kind: args.kind ?? args.type };
      if (args.value !== undefined) spec.value = args.value;
      if (args.value2 !== undefined) spec.value2 = args.value2;
      return spec;
    }
    default:
      throw err.invalid(`Unsupported validation type "${args.type}".`);
  }
}

function overlaps(
  range: { startColumnIndex?: number | null; endColumnIndex?: number | null } | undefined | null,
  start: number | undefined,
  end: number | undefined,
): boolean {
  if (!range) return false;
  const rs = range.startColumnIndex ?? 0;
  const re = range.endColumnIndex ?? Number.MAX_SAFE_INTEGER;
  const ts = start ?? 0;
  const te = end ?? Number.MAX_SAFE_INTEGER;
  return ts < re && rs < te;
}

/** The distinct columns inside the read range that already carry a rule. */
interface GridBlocks {
  data?: Array<{
    startColumn?: number | null;
    rowData?: Array<{ values?: Array<Record<string, unknown>> }>;
  }>;
}

function collectExisting(sheet: GridBlocks | undefined, fallbackStartColumn: number): ExistingRule[] {
  const seen = new Map<number, ExistingRule>();
  for (const block of sheet?.data ?? []) {
    const startColumn = block.startColumn ?? fallbackStartColumn;
    for (const row of block.rowData ?? []) {
      (row.values ?? []).forEach((cell, c) => {
        const rule = cell["dataValidation"] as
          | { condition?: { type?: string; values?: Array<{ userEnteredValue?: string }> } }
          | undefined;
        if (!rule?.condition) return;
        const column = startColumn + c;
        if (seen.has(column)) return;
        const entry: ExistingRule = {
          column,
          values: (rule.condition.values ?? [])
            .map((v) => v.userEnteredValue)
            .filter((v): v is string => typeof v === "string"),
        };
        if (rule.condition.type) entry.conditionType = rule.condition.type;
        seen.set(column, entry);
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.column - b.column);
}

/**
 * Columns carrying `gsheets.column` metadata, which are the plugin's own.
 * Metadata that cannot be read leaves the set empty, which is the safe reading:
 * every existing rule stays somebody else's until proven otherwise.
 */
async function pluginOwnedColumns(
  ctx: { sheets: unknown },
  spreadsheetId: string,
  sheetId: number,
): Promise<Set<number>> {
  const snapshot = await readMetadata(ctx.sheets as never, spreadsheetId);
  return new Set(columnRecords(snapshot, sheetId).keys());
}
