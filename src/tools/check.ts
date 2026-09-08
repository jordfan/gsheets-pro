/**
 * `sheets_check`: the lint.
 *
 * The per write error gate answers one question, cheaply, about the cells that
 * write touched. This answers the wider one: is the spreadsheet in a state a
 * careful person would hand to somebody. It reports formula errors the same way
 * a recalculation report does, because a model that has seen one has seen the
 * other, and alongside them the structural findings no picture can show: a
 * merge inside a table, a header that scrolls away, a key column with two
 * identical values, a write that landed in somebody else's column, text that
 * reads as machine output.
 *
 * Two reads, in this order.
 *
 * 1. `values.batchGet` with FORMULA rendering. It comes back trimmed to the
 *    cells that hold anything, which is how the tool learns each tab's real
 *    extent without guessing, and it shows formulas and values at once.
 * 2. A masked `spreadsheets.get` with grid data over exactly those extents.
 *    Errors, notes, validation, bold, merges, tables and frozen rows all live
 *    here, and bounding it to the used range is the difference between a read
 *    that costs a few hundred cells and one that walks a million empty ones.
 *
 * `LOADING` is retried before it counts, the same way the write gate does it,
 * because a volatile function that has not settled is Sheets working rather
 * than a sheet that is broken.
 */

import { z } from "zod";

import { columnIndexToLetter, toA1Reference } from "../lib/a1.js";
import { withRetry } from "../lib/batch.js";
import {
  buildContract,
  readColumnMetadata,
  readSheetMetadata,
  readManifest,
  toMetadataEntries,
  type SheetContract,
} from "../lib/contract.js";
import { ERROR_VALUE_TYPES, LOADING_BUDGET_MS } from "../lib/errorgate.js";
import { err } from "../lib/errors.js";
import {
  countBySeverity,
  runRules,
  selectRules,
  tallyFormulaErrors,
  LINT_RULE_IDS,
  type LintFinding,
  type LintSheet,
  type SheetLintContext,
} from "../lib/lint/index.js";
import { normalizeHeaders } from "../lib/records.js";
import { count, guarded, lines, listOf, ok, type ToolResponse } from "../lib/result.js";
import { writesFor } from "../lib/writelog.js";
import type { ToolDefinition, ToolDeps } from "./types.js";

/** How many tabs one call will read in full before it asks to be narrowed. */
export const MAX_TABS = 20;
/** Cells the grid read will ask for across every tab. */
export const MAX_GRID_CELLS = 60_000;
/** Locations named per error type in the summary, per the rule catalogue. */
export const MAX_ERROR_LOCATIONS = 100;

const GRID_MASK = [
  "sheets(",
  "properties(sheetId,title,hidden,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount)),",
  "merges,",
  "tables(tableId,name,range,columnProperties(columnIndex,columnName,columnType)),",
  "data(startRow,startColumn,rowData(values(",
  "formattedValue,",
  "note,",
  "userEnteredValue(stringValue,formulaValue),",
  "effectiveValue(stringValue,numberValue,boolValue,errorValue(type,message)),",
  "userEnteredFormat(textFormat(bold)),",
  "dataValidation(condition(type,values(userEnteredValue)),strict,inputMessage)",
  ")))",
  ")",
].join("");

export const checkInputSchema = {
  spreadsheet_id: z.string().describe("The spreadsheet id, the long id in the middle of the sheet's URL."),
  sheets: z
    .array(z.string().min(1))
    .optional()
    .describe("Tabs to check. Every visible tab when omitted."),
  sheet: z.string().optional().describe("One tab to check. A shorthand for sheets with a single entry."),
  range: z
    .string()
    .optional()
    .describe("A1 range within the single tab named by sheet. Narrows the check to those cells."),
  rules: z
    .array(z.string().min(1))
    .optional()
    .describe(
      `Run only these rules, by id. Everything when omitted. The v1 set is ${LINT_RULE_IDS.join(", ")}.`,
    ),
  writes: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Ranges written in this session, as A1 with the tab name, for L14. The server already remembers its own writes; pass this only to add writes it did not make.",
    ),
};

type CheckArgs = {
  spreadsheet_id: string;
  sheets?: string[];
  sheet?: string;
  range?: string;
  rules?: string[];
  writes?: string[];
};

const DESCRIPTION = [
  "Lint a spreadsheet and report what a careful person would fix. Run it before calling any build or edit done, and again after fixing anything.",
  "",
  "Returns a recalculation shaped report: status, total_formulas, total_errors, and an error_summary keyed on the Sheets error types, plus severity-tagged findings that each name the call that resolves them.",
  "",
  "status success means no error-severity finding, and warnings may still be present. errors_found is a stop. pending means cells were still calculating after a short retry, so wait and run it again.",
  "",
  "This is the authority on validation state. No dropdown paints as a pill in a render, so a bare-looking cell in an image is not evidence that a rule is missing.",
].join("\n");

export interface CheckToolOptions {
  /** How long to wait out LOADING before reporting pending. Injectable for tests. */
  loadingBudgetMs?: number;
}

export function createCheckTool(
  deps: ToolDeps,
  toolOptions: CheckToolOptions = {},
): ToolDefinition<typeof checkInputSchema> {
  const loadingBudgetMs = toolOptions.loadingBudgetMs ?? LOADING_BUDGET_MS;
  return {
    name: "sheets_check",
    config: {
      title: "Lint a spreadsheet",
      description: DESCRIPTION,
      inputSchema: checkInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler: guarded(async (raw: Record<string, unknown>): Promise<ToolResponse> => {
      const args = raw as CheckArgs;
      const ctx = await deps.getContext();
      const spreadsheetId = args.spreadsheet_id;

      if (args.range && !args.sheet && (args.sheets?.length ?? 0) !== 1) {
        throw err.invalid(
          "range needs to know which tab it belongs to.",
          'Pass sheet with the tab name alongside range, for example { "sheet": "Roster", "range": "A1:H80" }.',
        );
      }

      const { rules: selected, unknown } = selectRules(args.rules);
      if (selected.length === 0) {
        throw err.invalid(
          `None of ${listOf(args.rules ?? [])} is a rule this build runs.`,
          `The v1 rules are ${LINT_RULE_IDS.join(", ")}. Omit rules to run all of them.`,
        );
      }

      // --- which tabs -------------------------------------------------------
      const wanted = args.sheets?.length ? args.sheets : args.sheet ? [args.sheet] : undefined;
      const known = await ctx.cache.list(spreadsheetId);
      const targets = wanted
        ? await Promise.all(wanted.map((name) => ctx.cache.resolve(spreadsheetId, name)))
        : [...known.byId.values()].filter((info) => !info.hidden && info.sheetType !== "OBJECT");

      if (targets.length === 0) {
        throw err.invalid(
          "This spreadsheet has no visible tabs to check.",
          "Pass sheets with a tab name if the tab you mean is hidden.",
        );
      }

      const notes: string[] = [];
      let checking = targets;
      if (checking.length > MAX_TABS) {
        notes.push(
          `This spreadsheet has ${checking.length} tabs and one call reads at most ${MAX_TABS}, so the first ${MAX_TABS} were checked. Pass sheets to name the rest.`,
        );
        checking = checking.slice(0, MAX_TABS);
      }

      // --- read one: FORMULA values, which also give the used extent ---------
      const valueRanges = checking.map((info) =>
        args.range && checking.length === 1 ? toA1Reference(info.title, args.range) : toA1Reference(info.title),
      );
      const valuesResponse = await withRetry(() =>
        ctx.sheets.spreadsheets.values.batchGet({
          spreadsheetId,
          ranges: valueRanges,
          valueRenderOption: "FORMULA",
          dateTimeRenderOption: "FORMATTED_STRING",
        }),
      );
      const formulaGrids = new Map<string, Array<Array<string | number | boolean | null>>>();
      const valueList = valuesResponse.data.valueRanges ?? [];
      checking.forEach((info, index) => {
        const values = (valueList[index]?.values ?? []) as Array<Array<string | number | boolean | null>>;
        formulaGrids.set(info.title, values);
      });

      // --- read two: masked grid data over exactly those extents -------------
      const gridRanges: string[] = [];
      let budget = MAX_GRID_CELLS;
      let trimmed = 0;
      for (const info of checking) {
        const grid = formulaGrids.get(info.title) ?? [];
        const rows = grid.length;
        const columns = grid.reduce((max, row) => Math.max(max, (row ?? []).length), 0);
        if (rows === 0 || columns === 0) {
          // An empty tab still has merges, tables and frozen rows worth reading.
          gridRanges.push(toA1Reference(info.title, "A1"));
          continue;
        }
        const cells = rows * columns;
        if (cells > budget) {
          const affordableRows = Math.max(1, Math.floor(budget / Math.max(1, columns)));
          if (affordableRows < rows) trimmed += 1;
          gridRanges.push(
            toA1Reference(info.title, `A1:${columnIndexToLetter(columns - 1)}${Math.max(1, affordableRows)}`),
          );
          budget = 0;
        } else {
          budget -= cells;
          gridRanges.push(toA1Reference(info.title, `A1:${columnIndexToLetter(columns - 1)}${rows}`));
        }
      }
      if (trimmed > 0) {
        notes.push(
          `The grid read was capped at ${MAX_GRID_CELLS.toLocaleString("en-US")} cells, so ${count(trimmed, "tab")} was read only as far as that. Check the rest with range.`,
        );
      }

      const readGrid = async (): Promise<LintSheet[]> => {
        const response = await withRetry(() =>
          ctx.sheets.spreadsheets.get({
            spreadsheetId,
            ranges: gridRanges,
            includeGridData: true,
            fields: GRID_MASK,
          }),
        );
        return (response.data.sheets ?? []) as LintSheet[];
      };

      let gridSheets = await readGrid();
      let loading = countLoading(gridSheets);
      const startedAt = Date.now();
      while (loading > 0 && Date.now() - startedAt < loadingBudgetMs) {
        await sleep(Math.min(500 + (Date.now() - startedAt), 1500));
        gridSheets = await readGrid();
        loading = countLoading(gridSheets);
      }

      // --- contracts, so the rules that need one have one --------------------
      const contracts = await loadContracts(ctx, spreadsheetId, checking, formulaGrids);

      // --- run the rules ----------------------------------------------------
      const findings: LintFinding[] = [];
      const errorLocations = new Map<string, string[]>();
      const errorCounts = new Map<string, number>();
      let totalFormulas = 0;
      let totalErrors = 0;
      const ranRules = new Set<string>();
      const extraWrites = parseWrites(args.writes);

      for (const info of checking) {
        const sheet = gridSheets.find((s) => (s.properties?.title ?? "") === info.title);
        if (!sheet) continue;

        const policy = ctx.registry?.policyFor(spreadsheetId, info.title);
        const lintContext: SheetLintContext = {
          spreadsheetId,
          title: info.title,
          sheet,
          formulas: formulaGrids.get(info.title) ?? [],
          writes: [...writesFor(spreadsheetId, { sheet: info.title }), ...extraWrites.filter((w) => sameSheet(w.sheet, info.title))],
        };
        if (policy) lintContext.policy = policy;
        const contract = contracts.get(info.title);
        if (contract) lintContext.contract = contract;

        const tally = tallyFormulaErrors(lintContext);
        totalFormulas += tally.totalFormulas;
        totalErrors += tally.errors.length;
        for (const cell of tally.errors) {
          errorCounts.set(cell.type, (errorCounts.get(cell.type) ?? 0) + 1);
          const bucket = errorLocations.get(cell.type) ?? [];
          bucket.push(cell.location);
          errorLocations.set(cell.type, bucket);
        }

        const result = runRules(lintContext, args.rules ? { rules: args.rules } : {});
        for (const id of result.ran) ranRules.add(id);
        findings.push(...result.findings);
      }

      if (unknown.length > 0) {
        notes.push(
          `${listOf(unknown)} ${unknown.length === 1 ? "is not a rule" : "are not rules"} this build runs, so ${unknown.length === 1 ? "it was" : "they were"} skipped. The v1 rules are ${LINT_RULE_IDS.join(", ")}.`,
        );
      }

      const errorSummary: Record<string, { count: number; locations: string[]; truncated: number }> = {};
      for (const type of ERROR_VALUE_TYPES) {
        const n = errorCounts.get(type);
        if (!n) continue;
        const all = errorLocations.get(type) ?? [];
        errorSummary[type] = {
          count: n,
          locations: all.slice(0, MAX_ERROR_LOCATIONS),
          truncated: Math.max(0, all.length - MAX_ERROR_LOCATIONS),
        };
      }

      const counts = countBySeverity(findings);
      const status = counts.error > 0 ? "errors_found" : loading > 0 ? "pending" : "success";
      if (status === "pending") {
        notes.push(
          `${count(loading, "cell")} were still calculating after ${Math.round(loadingBudgetMs / 1000)} seconds. That is Sheets working, not a failure. Run this again in a moment.`,
        );
      }

      const structured: Record<string, unknown> = {
        spreadsheet_id: spreadsheetId,
        status,
        total_formulas: totalFormulas,
        total_errors: totalErrors,
        error_summary: errorSummary,
        findings,
        counts,
        sheets_checked: checking.map((info) => info.title),
        rules_run: [...ranRules],
        notes,
      };

      return ok(
        lines(
          headline(status, findings.length, counts, totalFormulas, totalErrors, checking.length),
          findings.length ? "" : undefined,
          ...findings.map(findingLine),
          notes.length ? `\n${notes.map((note) => `- ${note}`).join("\n")}` : undefined,
          "\nNo dropdown paints as a pill in a render, so this is the authority on validation state. A clean check means the formulas evaluate. It does not mean they point where you think they do, so spot-check a number by hand.",
        ),
        structured,
        { maxResultSizeChars: 120_000 },
      );
    }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function headline(
  status: string,
  findingCount: number,
  counts: Record<string, number>,
  formulas: number,
  errors: number,
  tabs: number,
): string {
  const scope = `${count(tabs, "tab")}, ${count(formulas, "formula")}`;
  if (status === "errors_found") {
    return `Check: errors_found. ${count(errors, "cell")} evaluating to an error across ${scope}. ${describeCounts(counts)}`;
  }
  if (status === "pending") {
    return `Check: pending. Nothing is broken so far across ${scope}, but some cells were still calculating. ${describeCounts(counts)}`;
  }
  if (findingCount === 0) {
    return `Check: success. ${scope}, no errors and nothing to fix.`;
  }
  return `Check: success, with ${count(findingCount, "finding")} worth reading. ${scope}, no formula errors. ${describeCounts(counts)}`;
}

function describeCounts(counts: Record<string, number>): string {
  const parts: string[] = [];
  if (counts.error) parts.push(count(counts.error, "error"));
  if (counts.warning) parts.push(count(counts.warning, "warning"));
  if (counts.info) parts.push(count(counts.info, "info item"));
  return parts.length ? `${listOf(parts)}.` : "";
}

function findingLine(finding: LintFinding): string {
  return `  [${finding.severity}] ${finding.rule} ${finding.location}: ${finding.message}\n      Fix: ${finding.fix}`;
}

function countLoading(sheets: LintSheet[]): number {
  let loading = 0;
  for (const sheet of sheets) {
    for (const block of sheet.data ?? []) {
      for (const row of block?.rowData ?? []) {
        for (const cell of row?.values ?? []) {
          if (cell?.effectiveValue?.errorValue?.type === "LOADING") loading += 1;
        }
      }
    }
  }
  return loading;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sameSheet(a: string | undefined, b: string): boolean {
  return (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();
}

function parseWrites(ranges: string[] | undefined): Array<{ range: string; sheet?: string; at: number }> {
  if (!ranges?.length) return [];
  const now = Date.now();
  return ranges.map((range) => {
    const match = /^'?([^'!]+)'?!/.exec(range.trim());
    const entry: { range: string; sheet?: string; at: number } = { range: range.trim(), at: now };
    if (match) entry.sheet = match[1];
    return entry;
  });
}

/**
 * Contracts for the tabs being checked. The metadata search is one call for all
 * three location types (spike 5), and a spreadsheet with no metadata answers it
 * with an empty list rather than an error, so a failure here is a real one and
 * is reported as "no contract" rather than retried.
 */
async function loadContracts(
  ctx: Awaited<ReturnType<ToolDeps["getContext"]>>,
  spreadsheetId: string,
  targets: Array<{ title: string; sheetId: number }>,
  formulaGrids: Map<string, Array<Array<string | number | boolean | null>>>,
): Promise<Map<string, SheetContract>> {
  const out = new Map<string, SheetContract>();

  let entries: ReturnType<typeof toMetadataEntries> = [];
  try {
    const response = await withRetry(() =>
      ctx.sheets.spreadsheets.developerMetadata.search({
        spreadsheetId,
        requestBody: { dataFilters: [{ developerMetadataLookup: {} }] },
      }),
    );
    const matched = (response.data.matchedDeveloperMetadata ?? [])
      .map((m: { developerMetadata?: unknown }) => m.developerMetadata)
      .filter(Boolean) as Parameters<typeof toMetadataEntries>[0];
    entries = toMetadataEntries(matched);
  } catch {
    entries = [];
  }

  const manifest = readManifest(entries);

  for (const target of targets) {
    const policy = ctx.registry?.policyFor(spreadsheetId, target.title);
    const sheetMetadata = readSheetMetadata(entries, target.sheetId);
    const columnMetadata = readColumnMetadata(entries, target.sheetId);
    const grid = formulaGrids.get(target.title) ?? [];
    const headerRowIndex = (sheetMetadata?.headerRow ?? 1) - 1;
    const headers = normalizeHeaders((grid[headerRowIndex] ?? []).map((v) => (v == null ? "" : String(v))));

    const input: Parameters<typeof buildContract>[0] = { sheet: target.title, headers };
    if (policy) input.policy = policy;
    if (columnMetadata.size > 0) input.columnMetadata = columnMetadata;
    if (sheetMetadata) input.sheetMetadata = sheetMetadata;
    if (manifest) input.manifest = manifest;

    const contract = buildContract(input);
    if (contract.source !== "none") out.set(target.title, contract);
  }

  return out;
}
