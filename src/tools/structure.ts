/**
 * `sheets_structure`: the shape of the workbook, as opposed to what is in it.
 *
 * Tabs, rows, columns, sort order, grouping, and protection are one tool
 * because they are one job. A person reorganising a spreadsheet renames a tab,
 * moves a column, sorts the data and freezes the header in one sitting, and
 * splitting that across nine tools makes the model pick between nine
 * near-identical descriptions every time.
 *
 * Three rules make a single wide tool safe.
 *
 * Destructive actions need `confirm` set to the tab's own name. Typing the name
 * is a small tax on a deliberate delete and an effective stop on an accidental
 * one, and unlike a boolean it cannot be satisfied by pattern matching.
 *
 * On a sheet the registry marks `positional_rows`, every action that moves rows
 * is a refusal with a reason, not a warning. Those are the sheets where a row
 * number is written down somewhere else: in an email, in a script, in a
 * colleague's notes. Sorting one silently invalidates all of it.
 *
 * Anything that shifts rows or columns says so in its response. References
 * inside the spreadsheet follow a move on their own; text references,
 * IMPORTRANGE from another file, and anything outside Sheets that keys on a row
 * number do not, and nobody remembers that at the moment they run the call.
 */

import { z } from "zod";

import {
  columnIndexToLetter,
  columnLetterToIndex,
  gridRangeToA1,
  parseA1,
  parseColumnSpan,
  parseRowSpan,
  quoteSheetName,
  type GridRange,
  type Span,
} from "../lib/a1.js";
import { runBatchUpdate, withRetry } from "../lib/batch.js";
import { describeCheck, runErrorGate, type GateCheck } from "../lib/errorgate.js";
import { recordWrite } from "../lib/writelog.js";
import { GsheetsError, err } from "../lib/errors.js";
import { describeSheet, type Policy } from "../lib/registry.js";
import { count, guarded, lines, listOf, ok, type ToolResponse } from "../lib/result.js";
import type { SheetInfo } from "../lib/sheetcache.js";
import type { ToolDefinition, ToolDeps } from "./types.js";

export const STRUCTURE_ACTIONS = [
  "add_tab",
  "rename_tab",
  "duplicate_tab",
  "move_tab",
  "hide_tab",
  "show_tab",
  "delete_tab",
  "copy_tab_to",
  "insert_rows",
  "insert_columns",
  "delete_rows",
  "delete_columns",
  "move_rows",
  "move_columns",
  "sort",
  "find_replace",
  "dedupe",
  "trim",
  "group",
  "ungroup",
  "protect",
  "unprotect",
] as const;

export type StructureAction = (typeof STRUCTURE_ACTIONS)[number];

/** Actions that destroy something a person cannot get back with undo from here. */
export const DESTRUCTIVE_ACTIONS: readonly StructureAction[] = [
  "delete_tab",
  "delete_rows",
  "delete_columns",
  "dedupe",
  "find_replace",
];

/** Actions refused outright on a registry sheet marked `positional_rows`. */
export const ROW_ORDER_ACTIONS: readonly StructureAction[] = [
  "insert_rows",
  "delete_rows",
  "move_rows",
  "sort",
  "dedupe",
];

/** Actions that can change what a cell holds, so the error gate runs after. */
const GATED_ACTIONS: readonly StructureAction[] = [
  "insert_rows",
  "insert_columns",
  "delete_rows",
  "delete_columns",
  "move_rows",
  "move_columns",
  "sort",
  "find_replace",
  "dedupe",
  "trim",
  "delete_tab",
];

/** Actions that shift the grid, so the response explains what follows and what does not. */
const SHIFTING_ACTIONS: readonly StructureAction[] = [
  "insert_rows",
  "insert_columns",
  "delete_rows",
  "delete_columns",
  "move_rows",
  "move_columns",
];

export const structureInputSchema = {
  spreadsheet_id: z
    .string()
    .describe("The spreadsheet id, the long id in the middle of the sheet's URL."),
  action: z.enum(STRUCTURE_ACTIONS).describe("What to do. Each action uses only a few of the arguments below."),
  sheet: z
    .string()
    .optional()
    .describe(
      "The tab to act on. Required by every action except add_tab, which creates one.",
    ),
  title: z
    .string()
    .optional()
    .describe("add_tab: the new tab's name. rename_tab: the new name. duplicate_tab: the copy's name."),
  index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("add_tab, duplicate_tab, move_tab: where the tab sits in the tab strip, counting from 0."),
  range: z
    .string()
    .optional()
    .describe(
      "A1 range within the tab. sort, dedupe, trim, find_replace, protect, unprotect. Sort and dedupe default to everything below the frozen header.",
    ),
  rows: z
    .string()
    .optional()
    .describe(
      'A band of rows, written as "5:9" or "12". insert_rows inserts that many rows starting there; delete_rows, move_rows, group and ungroup act on them.',
    ),
  columns: z
    .string()
    .optional()
    .describe(
      'A band of columns, written as "B:D" or "C". insert_columns inserts that many starting there; delete_columns, move_columns, group and ungroup act on them.',
    ),
  to: z
    .string()
    .optional()
    .describe(
      'move_rows: the row number to put them before, for example "12". move_columns: the column letter to put them before, for example "B".',
    ),
  sort_by: z
    .array(
      z.object({
        column: z.string().min(1).describe("Column letter or header name."),
        order: z.enum(["asc", "desc"]).optional().describe("Default asc."),
      }),
    )
    .optional()
    .describe("sort: the columns to sort on, most significant first."),
  find: z.string().optional().describe("find_replace: the text to look for."),
  replace: z.string().optional().describe("find_replace: what to put in its place. Omit to delete the text."),
  match_case: z.boolean().optional().describe("find_replace: match upper and lower case exactly. Default false."),
  whole_cell: z
    .boolean()
    .optional()
    .describe("find_replace: only match when the whole cell equals the text. Default false."),
  regex: z.boolean().optional().describe("find_replace: read find as a regular expression. Default false."),
  include_formulas: z
    .boolean()
    .optional()
    .describe(
      "find_replace: also rewrite text inside formulas. Default false, because rewriting a colleague's formula is how a sheet breaks quietly.",
    ),
  key_columns: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "dedupe: the columns that decide whether two rows are duplicates, by letter or header name. Defaults to every column in the range.",
    ),
  description: z
    .string()
    .optional()
    .describe(
      "protect: what the protection is for, in words a colleague will read when Sheets warns them. Required.",
    ),
  warning_only: z
    .boolean()
    .optional()
    .describe(
      "protect: true (the default) warns a person before they edit and lets them continue. false locks everyone but this account out and needs confirm.",
    ),
  collapsed: z.boolean().optional().describe("group: start the group collapsed. Default false."),
  destination_spreadsheet_id: z
    .string()
    .optional()
    .describe("copy_tab_to: the spreadsheet id to copy this tab into. The original is untouched."),
  confirm: z
    .string()
    .optional()
    .describe(
      "Required by delete_tab, delete_rows, delete_columns, dedupe and find_replace, and by protect when warning_only is false. Set it to the tab's own name.",
    ),
};

type StructureArgs = {
  spreadsheet_id: string;
  action: StructureAction;
  sheet?: string;
  title?: string;
  index?: number;
  range?: string;
  rows?: string;
  columns?: string;
  to?: string;
  sort_by?: Array<{ column: string; order?: "asc" | "desc" }>;
  find?: string;
  replace?: string;
  match_case?: boolean;
  whole_cell?: boolean;
  regex?: boolean;
  include_formulas?: boolean;
  key_columns?: string[];
  description?: string;
  warning_only?: boolean;
  collapsed?: boolean;
  destination_spreadsheet_id?: string;
  confirm?: string;
};

const DESCRIPTION = [
  "Reshape a spreadsheet: tabs, rows, columns, sort order, grouping and protection. One action per call.",
  "",
  "Tabs: add_tab (title, index), rename_tab (sheet, title), duplicate_tab (sheet, title, index), move_tab (sheet, index), hide_tab (sheet), show_tab (sheet), delete_tab (sheet, confirm), copy_tab_to (sheet, destination_spreadsheet_id).",
  "Rows and columns: insert_rows (sheet, rows), insert_columns (sheet, columns), delete_rows (sheet, rows, confirm), delete_columns (sheet, columns, confirm), move_rows (sheet, rows, to), move_columns (sheet, columns, to).",
  "Data: sort (sheet, sort_by, range), find_replace (sheet, find, replace, confirm), dedupe (sheet, key_columns, confirm), trim (sheet, range).",
  "Outline and protection: group (sheet, rows or columns), ungroup (sheet, rows or columns), protect (sheet, range, description), unprotect (sheet, range or description).",
  "",
  "Deleting anything needs confirm set to the tab's own name. On a sheet the registry marks positional_rows, sorting, inserting, deleting and moving rows are refused, because a row number there is written down somewhere else.",
].join("\n");

export function createStructureTool(deps: ToolDeps): ToolDefinition<typeof structureInputSchema> {
  return {
    name: "sheets_structure",
    config: {
      title: "Reshape a spreadsheet",
      description: DESCRIPTION,
      inputSchema: structureInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handler: guarded(async (raw: Record<string, unknown>): Promise<ToolResponse> => {
      const args = raw as StructureArgs;
      const ctx = await deps.getContext();
      const spreadsheetId = args.spreadsheet_id;
      const action = args.action;

      // The tab, and the policy that governs it, before anything is decided.
      const info =
        action === "add_tab" ? undefined : await ctx.cache.resolve(spreadsheetId, requireSheet(args));
      const policy = ctx.registry?.policyFor(spreadsheetId, info?.title);

      guardPositionalRows(action, policy, info?.title);
      guardConfirmation(action, args, info?.title);

      if (action === "copy_tab_to") return copyTabTo(ctx, args, info!);

      const built = await buildRequests(ctx, args, info, policy);
      const result = await runBatchUpdate(ctx.sheets as never, spreadsheetId, built.requests);

      // Any tab added, removed, renamed or reordered invalidates the name map.
      ctx.cache.invalidate(spreadsheetId);

      const replies = ((result.response as { replies?: unknown[] } | undefined)?.replies ?? []) as Array<
        Record<string, unknown>
      >;

      // A sort or a find_replace rewrites cells this session did not choose
      // one by one, so the ranges it touched are exactly what L14 needs.
      for (const range of built.gateRanges) {
        recordWrite({ spreadsheetId, range, tool: "sheets_structure" });
      }

      let check: GateCheck | undefined;
      if (GATED_ACTIONS.includes(action) && built.gateRanges.length > 0) {
        check = await runErrorGate(ctx.sheets as never, spreadsheetId, built.gateRanges);
      }

      const warnings = [...built.warnings];
      if (SHIFTING_ACTIONS.includes(action)) warnings.push(shiftWarning(action));
      if (policy && policy.owner !== "agent") {
        warnings.push(
          `${describeSheet(policy)} lists this spreadsheet as ${policy.owner}, so a colleague will see this change.`,
        );
      }

      const structured: Record<string, unknown> = {
        spreadsheet_id: spreadsheetId,
        action,
        sheet: info?.title ?? args.title ?? null,
        applied: built.summary,
        requests: built.requests.length,
        result: describeReplies(replies, built.requests),
        check: check ?? null,
        warnings,
      };

      const text = lines(
        built.summary,
        check ? describeCheck(check) : undefined,
        warnings.length ? `\nWorth knowing:\n${warnings.map((w) => `- ${w}`).join("\n")}` : undefined,
      );
      return ok(text, structured);
    }),
  };
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function requireSheet(args: StructureArgs): string {
  if (!args.sheet?.trim()) {
    throw err.invalid(
      `${args.action} needs a sheet.`,
      "Pass the tab name as it reads on the tab strip. Only add_tab works without one.",
    );
  }
  return args.sheet;
}

function guardPositionalRows(
  action: StructureAction,
  policy: Policy | undefined,
  sheet: string | undefined,
): void {
  if (!policy?.positionalRows) return;
  if (!ROW_ORDER_ACTIONS.includes(action)) return;
  throw new GsheetsError(
    "contract_violation",
    `${action} is refused on ${sheet ? `"${sheet}"` : "this sheet"}: the registry marks its rows as positional.`,
    `${describeSheet(policy)} says rows here are referred to by position somewhere else, so sorting, inserting, deleting or moving them would silently invalidate that. Change the values in place instead, or take the row numbering out of the registry entry if it is no longer true.`,
    { policy: policy.path, action },
  );
}

function guardConfirmation(action: StructureAction, args: StructureArgs, sheet?: string): void {
  const hardProtect = action === "protect" && args.warning_only === false;
  if (!DESTRUCTIVE_ACTIONS.includes(action) && !hardProtect) return;

  const expected = (sheet ?? args.title ?? "").trim();
  const given = (args.confirm ?? "").trim();
  if (given && expected && given.toLowerCase() === expected.toLowerCase()) return;

  const what = hardProtect
    ? "Locking a range so only this account can edit it"
    : `${action.replace(/_/g, " ")}`;
  throw new GsheetsError(
    "needs_confirmation",
    given
      ? `confirm was "${given}" and this action needs "${expected}".`
      : `${what} needs confirm.`,
    `Pass confirm: "${expected}", the tab's own name, to say this is deliberate. Nothing has been changed.`,
    { action, expected },
  );
}

// ---------------------------------------------------------------------------
// Building the one batchUpdate
// ---------------------------------------------------------------------------

interface BuiltRequests {
  requests: unknown[];
  /** Fully qualified A1 the error gate should re-read. */
  gateRanges: string[];
  summary: string;
  warnings: string[];
}

async function buildRequests(
  ctx: Awaited<ReturnType<ToolDeps["getContext"]>>,
  args: StructureArgs,
  info: SheetInfo | undefined,
  policy: Policy | undefined,
): Promise<BuiltRequests> {
  const warnings: string[] = [];
  const wholeTab = info ? quoteSheetName(info.title) : "";

  switch (args.action) {
    case "add_tab": {
      const title = requireString(args.title, "add_tab needs a title.", "Pass the new tab's name.");
      const properties: Record<string, unknown> = { title };
      if (args.index !== undefined) properties["index"] = args.index;
      return {
        requests: [{ addSheet: { properties } }],
        gateRanges: [],
        summary: `Added the tab "${title}".`,
        warnings,
      };
    }

    case "rename_tab": {
      const title = requireString(
        args.title,
        "rename_tab needs a title.",
        "Pass the new name for the tab.",
      );
      return {
        requests: [
          { updateSheetProperties: { properties: { sheetId: info!.sheetId, title }, fields: "title" } },
        ],
        gateRanges: [],
        summary: `Renamed "${info!.title}" to "${title}".`,
        warnings: [
          "A formula that names this tab follows the rename on its own. A tab name written as text, in a note or in another spreadsheet's IMPORTRANGE, does not.",
        ],
      };
    }

    case "duplicate_tab": {
      const request: Record<string, unknown> = { sourceSheetId: info!.sheetId };
      if (args.title) request["newSheetName"] = args.title;
      if (args.index !== undefined) request["insertSheetIndex"] = args.index;
      return {
        requests: [{ duplicateSheet: request }],
        gateRanges: [],
        summary: `Duplicated "${info!.title}"${args.title ? ` as "${args.title}"` : ""}.`,
        warnings: [
          "The copy carries this tab's formatting, validation and developer metadata, so a duplicated tracker keeps its contract. It is not in the registry, so no writable column policy applies to it yet.",
        ],
      };
    }

    case "move_tab": {
      if (args.index === undefined) {
        throw err.invalid("move_tab needs an index.", "Pass index: 0 to put the tab first.");
      }
      return {
        requests: [
          {
            updateSheetProperties: {
              properties: { sheetId: info!.sheetId, index: args.index },
              fields: "index",
            },
          },
        ],
        gateRanges: [],
        summary: `Moved "${info!.title}" to position ${args.index}.`,
        warnings,
      };
    }

    case "hide_tab":
    case "show_tab": {
      const hidden = args.action === "hide_tab";
      return {
        requests: [
          {
            updateSheetProperties: {
              properties: { sheetId: info!.sheetId, hidden },
              fields: "hidden",
            },
          },
        ],
        gateRanges: [],
        summary: `${hidden ? "Hid" : "Unhid"} "${info!.title}".`,
        warnings: hidden
          ? ["Hiding a tab does not protect it. Its cells stay readable by formulas and by anyone who unhides it."]
          : warnings,
      };
    }

    case "delete_tab": {
      const others = (await ctx.cache.list(args.spreadsheet_id)).titles.filter(
        (t) => t.toLowerCase() !== info!.title.toLowerCase(),
      );
      return {
        requests: [{ deleteSheet: { sheetId: info!.sheetId } }],
        gateRanges: others.map((t) => quoteSheetName(t)),
        summary: `Deleted the tab "${info!.title}".`,
        warnings: [
          `Every formula elsewhere that referenced "${info!.title}" now reads #REF!. The check below re-read the remaining tabs to see.`,
        ],
      };
    }

    case "insert_rows":
    case "delete_rows": {
      const span = spanFrom(args.rows, "rows", 'Write it as "5:9" to mean rows 5 through 9, or "7" for one row.');
      const inserting = args.action === "insert_rows";
      const request = inserting
        ? {
            insertDimension: {
              range: dimensionRange(info!.sheetId, "ROWS", span),
              inheritFromBefore: span.startIndex > 0,
            },
          }
        : { deleteDimension: { range: dimensionRange(info!.sheetId, "ROWS", span) } };
      const n = span.endIndex - span.startIndex;
      return {
        requests: [request],
        gateRanges: [wholeTab],
        summary: inserting
          ? `Inserted ${count(n, "row")} at row ${span.startIndex + 1} of "${info!.title}".`
          : `Deleted ${count(n, "row")} (${span.startIndex + 1} to ${span.endIndex}) from "${info!.title}".`,
        warnings,
      };
    }

    case "insert_columns":
    case "delete_columns": {
      const span = spanFrom(
        args.columns,
        "columns",
        'Write it as "B:D" to mean columns B through D, or "C" for one column.',
      );
      guardWritableColumns(policy, span, args.action);
      const inserting = args.action === "insert_columns";
      const request = inserting
        ? {
            insertDimension: {
              range: dimensionRange(info!.sheetId, "COLUMNS", span),
              inheritFromBefore: span.startIndex > 0,
            },
          }
        : { deleteDimension: { range: dimensionRange(info!.sheetId, "COLUMNS", span) } };
      const n = span.endIndex - span.startIndex;
      const label = `${columnIndexToLetter(span.startIndex)}${n > 1 ? `:${columnIndexToLetter(span.endIndex - 1)}` : ""}`;
      // The registry names columns by letter, and an insert to their left
      // renumbers them. The file cannot notice that on its own, so the person
      // who reads this response is the only one who can fix it.
      if (inserting && policy?.writableColumns?.length) {
        const shifted = policy.writableColumns.filter(
          (entry) => /^[A-Za-z]{1,3}(:[A-Za-z]{1,3})?$/.test(entry.trim()) && shiftsPast(entry, span),
        );
        if (shifted.length) {
          warnings.push(
            `${describeSheet(policy)} names ${shifted.join(", ")} as writable by column letter, and this insert moves ${
              shifted.length === 1 ? "that column" : "those columns"
            } one letter to the right. Update ${policy.path} to match, or the reservation now covers a colleague's column.`,
          );
        }
      }
      return {
        requests: [request],
        gateRanges: [wholeTab],
        summary: inserting
          ? `Inserted ${count(n, "column")} at ${label} of "${info!.title}".`
          : `Deleted ${count(n, "column")} (${label}) from "${info!.title}".`,
        warnings,
      };
    }

    case "move_rows": {
      const span = spanFrom(args.rows, "rows", 'Write it as "5:9".');
      const to = requireString(args.to, "move_rows needs to.", 'Pass the row number to put them before, for example "12".');
      const destination = parseRowSpan(to).startIndex;
      return {
        requests: [
          {
            moveDimension: {
              source: dimensionRange(info!.sheetId, "ROWS", span),
              destinationIndex: destination,
            },
          },
        ],
        gateRanges: [wholeTab],
        summary: `Moved rows ${span.startIndex + 1} to ${span.endIndex} of "${info!.title}" before row ${destination + 1}.`,
        warnings,
      };
    }

    case "move_columns": {
      const span = spanFrom(args.columns, "columns", 'Write it as "B:D".');
      const to = requireString(
        args.to,
        "move_columns needs to.",
        'Pass the column letter to put them before, for example "B".',
      );
      const destination = parseColumnSpan(to).startIndex;
      return {
        requests: [
          {
            moveDimension: {
              source: dimensionRange(info!.sheetId, "COLUMNS", span),
              destinationIndex: destination,
            },
          },
        ],
        gateRanges: [wholeTab],
        summary: `Moved columns ${columnIndexToLetter(span.startIndex)} to ${columnIndexToLetter(span.endIndex - 1)} of "${info!.title}" before ${columnIndexToLetter(destination)}.`,
        warnings,
      };
    }

    case "sort": {
      if (!args.sort_by?.length) {
        throw err.invalid(
          "sort needs sort_by.",
          'Pass the columns to sort on, for example [{ "column": "Student" }, { "column": "Grade", "order": "desc" }].',
        );
      }
      const range = dataRange(args, info!, "sort");
      const headers = await headerRow(ctx, args.spreadsheet_id, info!);
      const specs = args.sort_by.map((spec) => ({
        dimensionIndex: resolveColumn(spec.column, headers, info!),
        sortOrder: spec.order === "desc" ? "DESCENDING" : "ASCENDING",
      }));
      return {
        requests: [{ sortRange: { range, sortSpecs: specs } }],
        gateRanges: [`${wholeTab}!${gridRangeToA1(range)}`],
        summary: `Sorted ${gridRangeToA1(range)} on "${info!.title}" by ${listOf(
          args.sort_by.map((s) => `${s.column}${s.order === "desc" ? " descending" : ""}`),
        )}.`,
        warnings: [
          "Sorting moves whole rows, so anything that recorded a row number for this tab now points at a different row.",
        ],
      };
    }

    case "find_replace": {
      const find = requireString(args.find, "find_replace needs find.", "Pass the text to look for.");
      const request: Record<string, unknown> = {
        find,
        replacement: args.replace ?? "",
        matchCase: args.match_case === true,
        matchEntireCell: args.whole_cell === true,
        searchByRegex: args.regex === true,
        includeFormulas: args.include_formulas === true,
      };
      if (args.range?.trim()) {
        request["range"] = gridRange(info!, args.range);
      } else {
        request["sheetId"] = info!.sheetId;
      }
      const scope = args.range?.trim() ? `${wholeTab}!${args.range.trim()}` : wholeTab;
      return {
        requests: [{ findReplace: request }],
        gateRanges: [scope],
        summary: `Replaced "${find}" with "${args.replace ?? ""}" across ${scope}.`,
        warnings: args.include_formulas
          ? [
              "include_formulas was set, so text inside formulas was rewritten too. Read the check below closely: this is the fastest way to break a formula a colleague wrote.",
            ]
          : ["Formulas were left alone. Pass include_formulas to rewrite text inside them as well."],
      };
    }

    case "dedupe": {
      const range = dataRange(args, info!, "dedupe");
      const request: Record<string, unknown> = { range };
      if (args.key_columns?.length) {
        const headers = await headerRow(ctx, args.spreadsheet_id, info!);
        request["comparisonColumns"] = args.key_columns.map((column) => {
          const index = resolveColumn(column, headers, info!);
          return dimensionRange(info!.sheetId, "COLUMNS", { startIndex: index, endIndex: index + 1 });
        });
      }
      return {
        requests: [{ deleteDuplicates: request }],
        gateRanges: [`${wholeTab}!${gridRangeToA1(range)}`],
        summary: `Removed duplicate rows from ${gridRangeToA1(range)} on "${info!.title}"${
          args.key_columns?.length ? `, comparing ${listOf(args.key_columns)}` : ""
        }.`,
        warnings: [
          "The first row of each duplicate group is kept and the rest are deleted. Rows below shift up.",
        ],
      };
    }

    case "trim": {
      const range = args.range?.trim()
        ? gridRange(info!, args.range)
        : ({ sheetId: info!.sheetId } as GridRange);
      return {
        requests: [{ trimWhitespace: { range } }],
        gateRanges: [args.range?.trim() ? `${wholeTab}!${args.range.trim()}` : wholeTab],
        summary: `Trimmed leading and trailing whitespace in ${
          args.range?.trim() ?? "every cell"
        } on "${info!.title}".`,
        warnings,
      };
    }

    case "group":
    case "ungroup": {
      const range = outlineRange(args, info!);
      const grouping = args.action === "group";
      const requests: unknown[] = [
        grouping ? { addDimensionGroup: { range } } : { deleteDimensionGroup: { range } },
      ];
      if (grouping && args.collapsed) {
        requests.push({
          updateDimensionGroup: {
            dimensionGroup: { range, depth: 1, collapsed: true },
            fields: "collapsed",
          },
        });
      }
      const what = range.dimension === "ROWS"
        ? `rows ${range.startIndex + 1} to ${range.endIndex}`
        : `columns ${columnIndexToLetter(range.startIndex)} to ${columnIndexToLetter(range.endIndex - 1)}`;
      return {
        requests,
        gateRanges: [],
        summary: `${grouping ? "Grouped" : "Ungrouped"} ${what} on "${info!.title}".`,
        warnings,
      };
    }

    case "protect": {
      const description = requireString(
        args.description,
        "protect needs a description.",
        "Say what the protection is for, in the words a colleague will read when Sheets warns them, for example \"Hadeer keeps the background check dates in K to P.\"",
      );
      const warningOnly = args.warning_only !== false;
      const protectedRange: Record<string, unknown> = {
        range: args.range?.trim() ? gridRange(info!, args.range) : { sheetId: info!.sheetId },
        description,
        warningOnly,
      };
      return {
        requests: [{ addProtectedRange: { protectedRange } }],
        gateRanges: [],
        summary: `Protected ${args.range?.trim() ?? "the whole tab"} on "${info!.title}"${
          warningOnly ? " with a warning" : " so only this account can edit it"
        }.`,
        warnings: warningOnly
          ? []
          : [
              "A hard protection locks colleagues out. Everyone but this account now sees a refusal rather than a warning when they try to edit.",
            ],
      };
    }

    case "unprotect": {
      const id = await findProtection(ctx, args, info!);
      return {
        requests: [{ deleteProtectedRange: { protectedRangeId: id } }],
        gateRanges: [],
        summary: `Removed the protection on "${info!.title}".`,
        warnings,
      };
    }

    default: {
      throw err.invalid(`Unknown action "${String(args.action)}".`, `The actions are: ${STRUCTURE_ACTIONS.join(", ")}.`);
    }
  }
}

// ---------------------------------------------------------------------------
// copyTo lives outside batchUpdate
// ---------------------------------------------------------------------------

async function copyTabTo(
  ctx: Awaited<ReturnType<ToolDeps["getContext"]>>,
  args: StructureArgs,
  info: SheetInfo,
): Promise<ToolResponse> {
  const destination = requireString(
    args.destination_spreadsheet_id,
    "copy_tab_to needs destination_spreadsheet_id.",
    "Pass the id of the spreadsheet to copy this tab into. It is the long id in the middle of that sheet's URL.",
  );
  if (destination === args.spreadsheet_id) {
    throw err.invalid(
      "destination_spreadsheet_id is this same spreadsheet.",
      "To copy a tab inside one spreadsheet use action duplicate_tab.",
    );
  }

  const response = await withRetry(() =>
    (
      ctx.sheets.spreadsheets as unknown as {
        sheets: {
          copyTo(params: {
            spreadsheetId: string;
            sheetId: number;
            requestBody: { destinationSpreadsheetId: string };
          }): Promise<{ data: { sheetId?: number | null; title?: string | null } }>;
        };
      }
    ).sheets.copyTo({
      spreadsheetId: args.spreadsheet_id,
      sheetId: info.sheetId,
      requestBody: { destinationSpreadsheetId: destination },
    }),
  );

  ctx.cache.invalidate(destination);
  const newTitle = response.data.title ?? `Copy of ${info.title}`;

  const warnings = [
    `Sheets names the copy "${newTitle}" in the destination, not "${info.title}". Rename it there with rename_tab if that matters.`,
    "The copy carries formatting, validation and developer metadata. Formulas that pointed at other tabs in the source spreadsheet now point at tabs of the same name in the destination, or read #REF! if there are none.",
  ];

  const structured: Record<string, unknown> = {
    spreadsheet_id: args.spreadsheet_id,
    action: "copy_tab_to",
    sheet: info.title,
    destination_spreadsheet_id: destination,
    new_sheet: { title: newTitle, sheet_id: response.data.sheetId ?? null },
    applied: `Copied "${info.title}" into ${destination} as "${newTitle}".`,
    check: null,
    warnings,
  };

  return ok(
    lines(
      `Copied "${info.title}" into spreadsheet ${destination} as "${newTitle}". The original is untouched.`,
      `\nWorth knowing:\n${warnings.map((w) => `- ${w}`).join("\n")}`,
    ),
    structured,
  );
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function requireString(value: string | undefined, message: string, hint: string): string {
  const v = value?.trim();
  if (!v) throw err.invalid(message, hint);
  return v;
}

function spanFrom(spec: string | undefined, what: "rows" | "columns", hint: string): Span {
  if (!spec?.trim()) throw err.invalid(`This action needs ${what}.`, hint);
  return what === "rows" ? parseRowSpan(spec) : parseColumnSpan(spec);
}

function dimensionRange(
  sheetId: number,
  dimension: "ROWS" | "COLUMNS",
  span: Span,
): { sheetId: number; dimension: string; startIndex: number; endIndex: number } {
  return { sheetId, dimension, startIndex: span.startIndex, endIndex: span.endIndex };
}

function outlineRange(
  args: StructureArgs,
  info: SheetInfo,
): { sheetId: number; dimension: "ROWS" | "COLUMNS"; startIndex: number; endIndex: number } {
  if (args.rows?.trim() && args.columns?.trim()) {
    throw err.invalid(
      `${args.action} takes rows or columns, not both.`,
      "A group covers one axis. Run the action twice to group both.",
    );
  }
  if (args.rows?.trim()) {
    const span = parseRowSpan(args.rows);
    return { sheetId: info.sheetId, dimension: "ROWS", startIndex: span.startIndex, endIndex: span.endIndex };
  }
  if (args.columns?.trim()) {
    const span = parseColumnSpan(args.columns);
    return {
      sheetId: info.sheetId,
      dimension: "COLUMNS",
      startIndex: span.startIndex,
      endIndex: span.endIndex,
    };
  }
  throw err.invalid(`${args.action} needs rows or columns.`, 'For example rows: "5:20" or columns: "C:F".');
}

function gridRange(info: SheetInfo, range: string): GridRange {
  return { sheetId: info.sheetId, ...parseA1(range) };
}

/**
 * Where the data lives for sort and dedupe: everything below the frozen header.
 * A tab with no frozen rows has no reliable header signal, and sorting the
 * header into the middle of the data is the single most common way this goes
 * wrong, so that case asks for an explicit range instead of guessing.
 */
function dataRange(args: StructureArgs, info: SheetInfo, action: string): GridRange {
  if (args.range?.trim()) return gridRange(info, args.range);
  const frozen = info.frozenRowCount ?? 0;
  if (frozen < 1) {
    throw err.invalid(
      `"${info.title}" has no frozen header row, so ${action} cannot tell where the data starts.`,
      `Pass range, for example A2:${columnIndexToLetter((info.columnCount ?? 26) - 1)}${info.rowCount ?? 1000}, or freeze the header first with sheets_style.`,
    );
  }
  return {
    sheetId: info.sheetId,
    startRowIndex: frozen,
    endRowIndex: info.rowCount ?? undefined,
    startColumnIndex: 0,
    endColumnIndex: info.columnCount ?? undefined,
  };
}

/** The header row as text, read only when a column was named rather than lettered. */
async function headerRow(
  ctx: Awaited<ReturnType<ToolDeps["getContext"]>>,
  spreadsheetId: string,
  info: SheetInfo,
): Promise<string[]> {
  const row = Math.max(1, info.frozenRowCount ?? 1);
  const response = await withRetry(() =>
    ctx.sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: [`${quoteSheetName(info.title)}!${row}:${row}`],
      valueRenderOption: "FORMATTED_VALUE",
      majorDimension: "ROWS",
    }),
  );
  const values = (response.data.valueRanges?.[0]?.values?.[0] ?? []) as unknown[];
  return values.map((v) => String(v ?? "").trim());
}

/** A column letter or a header name to its absolute index in the sheet. */
function resolveColumn(column: string, headers: string[], info: SheetInfo): number {
  const wanted = column.trim();
  const byHeader = headers.findIndex((h) => h.toLowerCase() === wanted.toLowerCase());
  if (byHeader >= 0) return byHeader;
  if (/^[A-Za-z]{1,3}$/.test(wanted)) return columnLetterToIndex(wanted);
  throw err.invalid(
    `No column named "${column}" on "${info.title}".`,
    headers.filter(Boolean).length
      ? `The headers are: ${headers.filter(Boolean).join(", ")}. A column letter such as C works too.`
      : "This tab has no header row to match against, so pass a column letter such as C.",
  );
}

/** Find the protection to remove, by range or by description. */
async function findProtection(
  ctx: Awaited<ReturnType<ToolDeps["getContext"]>>,
  args: StructureArgs,
  info: SheetInfo,
): Promise<number> {
  const response = await withRetry(() =>
    ctx.sheets.spreadsheets.get({
      spreadsheetId: args.spreadsheet_id,
      fields: "sheets(properties(sheetId,title),protectedRanges(protectedRangeId,range,description,warningOnly))",
    }),
  );
  const sheet = (response.data.sheets ?? []).find((s) => s.properties?.sheetId === info.sheetId);
  const all = (sheet?.protectedRanges ?? []).map((p) => ({
    id: p.protectedRangeId ?? -1,
    range: p.range ? gridRangeToA1(p.range) : "the whole tab",
    description: p.description ?? "",
  }));
  if (all.length === 0) {
    throw err.invalid(`"${info.title}" has no protected ranges.`, "There is nothing to remove.");
  }

  const wantedRange = args.range?.trim();
  const wantedDescription = args.description?.trim().toLowerCase();
  const matches = all.filter((p) => {
    if (wantedRange && p.range.toLowerCase() !== wantedRange.toLowerCase()) return false;
    if (wantedDescription && !p.description.toLowerCase().includes(wantedDescription)) return false;
    return true;
  });

  if (matches.length === 1) return matches[0].id;
  if (matches.length === 0) {
    throw err.invalid(
      `No protection on "${info.title}" matches that.`,
      `The protections are: ${all.map((p) => `${p.range}${p.description ? ` (${p.description})` : ""}`).join("; ")}.`,
    );
  }
  throw err.invalid(
    `${matches.length} protections on "${info.title}" match.`,
    `Narrow it with range or description. They are: ${matches
      .map((p) => `${p.range}${p.description ? ` (${p.description})` : ""}`)
      .join("; ")}.`,
  );
}

/** Refuse a column delete that would take out a column the registry reserves. */
function guardWritableColumns(
  policy: Policy | undefined,
  span: Span,
  action: StructureAction,
): void {
  if (!policy?.writableColumns?.length) return;
  if (action !== "delete_columns" && action !== "insert_columns") return;
  const letters: string[] = [];
  for (let i = span.startIndex; i < span.endIndex; i += 1) letters.push(columnIndexToLetter(i));
  if (action === "delete_columns") {
    throw new GsheetsError(
      "contract_violation",
      `Deleting ${listOf(letters)} is refused: this spreadsheet reserves columns for a colleague.`,
      `${describeSheet(policy)} lists ${policy.writableColumns.join(", ")} as ours. Deleting columns renumbers every column to the right of them, so it moves a colleague's columns whether or not it deletes them. Clear the values instead, or take the reservation out of the registry entry.`,
      { policy: policy.path, columns: letters },
    );
  }
}

/** True when an insert at `span` renumbers the columns a registry entry names. */
function shiftsPast(entry: string, span: Span): boolean {
  try {
    return parseColumnSpan(entry).startIndex >= span.startIndex;
  } catch {
    return false;
  }
}

function shiftWarning(action: StructureAction): string {
  const inserting = action.startsWith("insert");
  const moving = action.startsWith("move");
  const what = action.endsWith("rows") ? "rows" : "columns";
  const consequence = inserting
    ? `everything below or right of the insert shifts along`
    : moving
      ? `the ${what} land in their new place and everything between shifts to fill the gap`
      : `everything after the deleted ${what} shifts back, and formulas that pointed into them now read #REF!`;
  return `Grid shift: ${consequence}. Formulas, named ranges, protections and conditional formats inside this spreadsheet follow the move on their own. What does not follow: a reference typed as text, an IMPORTRANGE or formula in another spreadsheet, and anything outside Sheets that keys on a row or column position.`;
}

function describeReplies(
  replies: Array<Record<string, unknown>>,
  requests: unknown[],
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  replies.forEach((reply, i) => {
    const add = reply["addSheet"] as { properties?: { sheetId?: number; title?: string } } | undefined;
    if (add?.properties) {
      out["new_sheet"] = { title: add.properties.title, sheet_id: add.properties.sheetId };
    }
    const duplicate = reply["duplicateSheet"] as
      | { properties?: { sheetId?: number; title?: string } }
      | undefined;
    if (duplicate?.properties) {
      out["new_sheet"] = { title: duplicate.properties.title, sheet_id: duplicate.properties.sheetId };
    }
    const findReplace = reply["findReplace"] as
      | { valuesChanged?: number; occurrencesChanged?: number; rowsChanged?: number; sheetsChanged?: number; formulasChanged?: number }
      | undefined;
    if (findReplace) {
      out["replacements"] = {
        cells_changed: findReplace.valuesChanged ?? 0,
        occurrences: findReplace.occurrencesChanged ?? 0,
        rows: findReplace.rowsChanged ?? 0,
        formulas: findReplace.formulasChanged ?? 0,
      };
    }
    const dedupe = reply["deleteDuplicates"] as { duplicatesRemovedCount?: number } | undefined;
    if (dedupe) out["duplicates_removed"] = dedupe.duplicatesRemovedCount ?? 0;
    const trim = reply["trimWhitespace"] as { cellsChangedCount?: number } | undefined;
    if (trim) out["cells_trimmed"] = trim.cellsChangedCount ?? 0;
    const protect = reply["addProtectedRange"] as
      | { protectedRange?: { protectedRangeId?: number } }
      | undefined;
    if (protect?.protectedRange) {
      out["protected_range_id"] = protect.protectedRange.protectedRangeId;
    }
    if (i >= requests.length) return;
  });
  return Object.keys(out).length ? out : null;
}
