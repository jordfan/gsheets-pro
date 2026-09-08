/**
 * `sheets_open`: the first call of every session.
 *
 * Opening a spreadsheet blind is how agents wreck them. This tool answers, in
 * one round trip, the questions that should be settled before anything is
 * written: what the tabs are, which ones are native Tables, where the named
 * ranges and protections sit, what contract governs writes, which dropdowns
 * belong to the UI, and what conventions the sheet already follows.
 *
 * It is deliberately loud about not knowing. A spreadsheet with no registry
 * entry and no plugin metadata gets "no contract" rather than a guess, because
 * a confident guess about who owns a column is worse than an admission.
 */

import { z } from "zod";

import { gridRangeToA1, columnIndexToLetter, columnLetterToIndex, quoteSheetName } from "../lib/a1.js";
import { colorStyleToText } from "../lib/colors.js";
import {
  buildContract,
  inferConventions,
  markUiOwned,
  readColumnMetadata,
  readManifest,
  readSheetMetadata,
  toMetadataEntries,
  type MetadataEntry,
  type SheetContract,
  type ValidationSummary,
} from "../lib/contract.js";
import { err } from "../lib/errors.js";
import { normalizeHeaders } from "../lib/records.js";
import { describePolicy } from "../lib/registry.js";
import { count, guarded, lines, listOf, ok, type ToolResponse } from "../lib/result.js";
import { withRetry } from "../lib/batch.js";
import type { ToolDefinition, ToolDeps } from "./types.js";

/** How many leading rows of each tab feed the convention inference. */
const SAMPLE_ROWS = 12;
/** Past this many tabs the response lists names only unless one is named. */
const DETAIL_TAB_LIMIT = 12;

const SPREADSHEET_MASK = [
  "spreadsheetId",
  "properties(title,locale,timeZone,spreadsheetTheme(primaryFontFamily,themeColors(colorType,color(rgbColor))))",
  "namedRanges(namedRangeId,name,range)",
  "sheets.properties(sheetId,title,index,sheetType,hidden,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount))",
  "sheets.tables(tableId,name,range,columnProperties(columnIndex,columnName,columnType))",
  "sheets.protectedRanges(protectedRangeId,range,description,warningOnly,requestingUserCanEdit)",
  "sheets.bandedRanges(bandedRangeId,range)",
  "sheets.basicFilter(range)",
  "sheets.merges",
].join(",");

const VALIDATION_MASK =
  "sheets.properties(sheetId,title),sheets.data.rowData.values(dataValidation(condition(type,values(userEnteredValue)),strict,inputMessage))";

export const openInputSchema = {
  spreadsheet_id: z
    .string()
    .optional()
    .describe(
      "The spreadsheet id, the long id in the middle of the sheet's URL. Omit only when creating a new spreadsheet.",
    ),
  sheet: z
    .string()
    .optional()
    .describe("Restrict the detailed report to one tab. Everything else is still listed by name."),
  create: z
    .object({
      title: z.string().min(1).describe("The new spreadsheet's title."),
      tabs: z
        .array(z.string().min(1))
        .optional()
        .describe("Tab names to create, in order. Defaults to a single tab named Sheet1."),
    })
    .optional()
    .describe("Create a new spreadsheet instead of opening one."),
  include_validation: z
    .boolean()
    .optional()
    .describe(
      "Read the data validation rules on the first data row of each tab, so dropdowns set in the UI are reported rather than overwritten later. Default true.",
    ),
  sample_rows: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe(`How many leading rows of each tab to read for convention inference. Default ${SAMPLE_ROWS}.`),
};

type OpenArgs = {
  spreadsheet_id?: string;
  sheet?: string;
  create?: { title: string; tabs?: string[] };
  include_validation?: boolean;
  sample_rows?: number;
};

interface TabReport {
  name: string;
  sheetId: number;
  index: number;
  hidden: boolean;
  rows?: number;
  columns?: number;
  frozenRows: number;
  frozenColumns: number;
  isTable: boolean;
  tables: Array<{ tableId: string; name?: string; range: string; columns: Array<{ name: string; type?: string }> }>;
  protections: Array<{ range: string; description?: string; warningOnly: boolean; editable: boolean }>;
  banded: boolean;
  filtered: boolean;
  merges: number;
  headers: string[];
  conventions?: ReturnType<typeof inferConventions>;
  contract?: SheetContract;
  validation: ValidationSummary[];
}

export function createOpenTool(deps: ToolDeps): ToolDefinition<typeof openInputSchema> {
  return {
    name: "sheets_open",
    config: {
      title: "Open a spreadsheet",
      description:
        "Call this first, before reading or writing anything. Returns the map of a spreadsheet: tabs and their sizes, native Tables, named ranges, protected ranges, the contract that says which columns are ours to write, dropdowns that belong to the Sheets UI, and the conventions the sheet already follows. Can also create a new spreadsheet.",
      inputSchema: openInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler: guarded(async (raw: Record<string, unknown>): Promise<ToolResponse> => {
      const args = raw as OpenArgs;
      const ctx = await deps.getContext();

      let spreadsheetId = args.spreadsheet_id;
      let created = false;

      if (args.create) {
        const tabs = args.create.tabs?.length ? args.create.tabs : ["Sheet1"];
        const res = await withRetry(() =>
          ctx.sheets.spreadsheets.create({
            requestBody: {
              properties: { title: args.create!.title },
              sheets: tabs.map((title, index) => ({ properties: { title, index } })),
            },
            fields: "spreadsheetId",
          }),
        );
        spreadsheetId = res.data.spreadsheetId ?? undefined;
        created = true;
        if (!spreadsheetId) {
          throw err.invalid("The API created a spreadsheet but returned no id.");
        }
        ctx.cache.invalidate(spreadsheetId);
      }

      if (!spreadsheetId) {
        throw err.invalid(
          "spreadsheet_id is required.",
          "Pass the long id from the middle of the sheet's URL, or pass create to make a new spreadsheet.",
        );
      }

      const meta = await withRetry(() =>
        ctx.sheets.spreadsheets.get({ spreadsheetId, fields: SPREADSHEET_MASK }),
      );
      const data = meta.data;
      const allSheets = data.sheets ?? [];

      // Feed the shared cache from the response we already have, so the next
      // tool call does not spend another read resolving a tab name.
      ctx.cache.prime(
        spreadsheetId,
        allSheets.flatMap((s) => {
          const p = s.properties;
          if (!p || p.sheetId === undefined || p.sheetId === null || !p.title) return [];
          const grid = p.gridProperties ?? {};
          return [
            {
              sheetId: p.sheetId,
              title: p.title,
              index: p.index ?? 0,
              sheetType: p.sheetType ?? "GRID",
              hidden: p.hidden === true,
              rowCount: grid.rowCount ?? undefined,
              columnCount: grid.columnCount ?? undefined,
              frozenRowCount: grid.frozenRowCount ?? undefined,
              frozenColumnCount: grid.frozenColumnCount ?? undefined,
            },
          ];
        }),
      );

      const titles = allSheets.map((s) => s.properties?.title).filter((t): t is string => !!t);
      if (args.sheet && !titles.some((t) => t.toLowerCase() === args.sheet!.trim().toLowerCase())) {
        throw err.sheetNotFound(args.sheet, titles);
      }

      const detailed = args.sheet
        ? allSheets.filter((s) => s.properties?.title?.toLowerCase() === args.sheet!.trim().toLowerCase())
        : allSheets.slice(0, DETAIL_TAB_LIMIT);
      const detailedTitles = detailed
        .map((s) => s.properties?.title)
        .filter((t): t is string => !!t);

      // Developer metadata: absent on any sheet a person built, which is the
      // common case, so a failure here is information rather than an error.
      let metadataEntries: MetadataEntry[] = [];
      let metadataNote: string | undefined;
      try {
        const search = await withRetry(() =>
          ctx.sheets.spreadsheets.developerMetadata.search({
            spreadsheetId,
            requestBody: { dataFilters: [{ developerMetadataLookup: {} }] },
          }),
        );
        metadataEntries = toMetadataEntries(
          (search.data.matchedDeveloperMetadata ?? []).flatMap((m) =>
            m.developerMetadata ? [m.developerMetadata] : [],
          ),
        );
      } catch (error) {
        metadataNote = `Developer metadata could not be read (${(error as Error).message}). Treating this spreadsheet as having none.`;
      }
      const manifest = readManifest(metadataEntries);

      const sampleRows = args.sample_rows ?? SAMPLE_ROWS;
      const sampleByTab = new Map<string, string[][]>();
      if (sampleRows > 0 && detailedTitles.length > 0) {
        const ranges = detailedTitles.map((t) => `${quoteSheetName(t)}!A1:Z${sampleRows}`);
        const values = await withRetry(() =>
          ctx.sheets.spreadsheets.values.batchGet({
            spreadsheetId,
            ranges,
            valueRenderOption: "FORMATTED_VALUE",
            majorDimension: "ROWS",
          }),
        );
        (values.data.valueRanges ?? []).forEach((vr, i) => {
          const title = detailedTitles[i];
          if (title) sampleByTab.set(title, (vr.values ?? []) as string[][]);
        });
      }

      const wantValidation = args.include_validation !== false && detailedTitles.length > 0;
      const validationByTab = new Map<number, Array<{ column: number; rule: unknown }>>();
      if (wantValidation) {
        try {
          // One row per tab is enough: a dropdown is set on a whole column, so
          // the first data row is representative and costs almost nothing.
          const ranges = detailedTitles.map((t) => `${quoteSheetName(t)}!A2:Z2`);
          const grid = await withRetry(() =>
            ctx.sheets.spreadsheets.get({
              spreadsheetId,
              ranges,
              includeGridData: true,
              fields: VALIDATION_MASK,
            }),
          );
          for (const sheet of grid.data.sheets ?? []) {
            const sheetId = sheet.properties?.sheetId;
            if (sheetId === undefined || sheetId === null) continue;
            const row = sheet.data?.[0]?.rowData?.[0]?.values ?? [];
            const found: Array<{ column: number; rule: unknown }> = [];
            row.forEach((cell, columnIndex) => {
              if (cell?.dataValidation) found.push({ column: columnIndex, rule: cell.dataValidation });
            });
            if (found.length) validationByTab.set(sheetId, found);
          }
        } catch (error) {
          metadataNote = lines(
            metadataNote,
            `Data validation could not be read (${(error as Error).message}).`,
          );
        }
      }

      const warnings: string[] = [];
      if (metadataNote) warnings.push(metadataNote);

      const tabs: TabReport[] = [];
      for (const sheet of detailed) {
        const properties = sheet.properties;
        if (!properties?.title || properties.sheetId === undefined || properties.sheetId === null) continue;
        const title = properties.title;
        const sheetId = properties.sheetId;
        const grid = properties.gridProperties ?? {};
        const sample = sampleByTab.get(title) ?? [];

        const conventions = inferConventions({
          rows: sample,
          frozenRowCount: grid.frozenRowCount ?? 0,
          frozenColumnCount: grid.frozenColumnCount ?? 0,
          hasBanding: (sheet.bandedRanges ?? []).length > 0,
          hasFilter: !!sheet.basicFilter,
        });
        const headers = normalizeHeaders(conventions.headers);

        const policy = ctx.registry?.policyFor(spreadsheetId, title);
        const columnMetadata = readColumnMetadata(metadataEntries, sheetId);
        const contract = buildContract({
          sheet: title,
          headers: conventions.headers,
          policy,
          columnMetadata,
          sheetMetadata: readSheetMetadata(metadataEntries, sheetId),
          manifest,
        });

        const pluginColumns = new Set(columnMetadata.keys());
        const validation = markUiOwned(
          (validationByTab.get(sheetId) ?? []).map(({ column, rule }) => {
            const r = rule as {
              condition?: { type?: string | null; values?: Array<{ userEnteredValue?: string | null }> };
              strict?: boolean | null;
            };
            const letter = columnIndexToLetter(column);
            const summary: Omit<ValidationSummary, "uiOwned" | "note"> = {
              column: letter,
              range: `${letter}:${letter}`,
              values: (r.condition?.values ?? [])
                .map((v) => v.userEnteredValue)
                .filter((v): v is string => typeof v === "string"),
              strict: r.strict === true,
            };
            if (r.condition?.type) summary.conditionType = r.condition.type;
            return summary;
          }),
          pluginColumns,
          columnLetterToIndex,
        );

        const report: TabReport = {
          name: title,
          sheetId,
          index: properties.index ?? 0,
          hidden: properties.hidden === true,
          rows: grid.rowCount ?? undefined,
          columns: grid.columnCount ?? undefined,
          frozenRows: grid.frozenRowCount ?? 0,
          frozenColumns: grid.frozenColumnCount ?? 0,
          isTable: (sheet.tables ?? []).length > 0,
          tables: (sheet.tables ?? []).map((t) => {
            const entry: TabReport["tables"][number] = {
              tableId: t.tableId ?? "",
              range: t.range ? gridRangeToA1(t.range) : "the whole sheet",
              columns: (t.columnProperties ?? []).map((c) => {
                const col: { name: string; type?: string } = { name: c.columnName ?? "" };
                if (c.columnType) col.type = c.columnType;
                return col;
              }),
            };
            if (t.name) entry.name = t.name;
            return entry;
          }),
          protections: (sheet.protectedRanges ?? []).map((p) => {
            const entry: TabReport["protections"][number] = {
              range: p.range ? gridRangeToA1(p.range) : "the whole tab",
              warningOnly: p.warningOnly === true,
              editable: p.requestingUserCanEdit !== false,
            };
            if (p.description) entry.description = p.description;
            return entry;
          }),
          banded: (sheet.bandedRanges ?? []).length > 0,
          filtered: !!sheet.basicFilter,
          merges: (sheet.merges ?? []).length,
          headers,
          conventions,
          contract,
          validation,
        };
        tabs.push(report);

        for (const note of conventions.notes) warnings.push(`${title}: ${note}`);
        for (const d of contract.drift) warnings.push(`${title}: ${d}`);
        const uiOwned = validation.filter((v) => v.uiOwned).map((v) => v.column ?? v.range);
        if (uiOwned.length) {
          warnings.push(
            `${title}: dropdowns on ${listOf(uiOwned)} were set outside this plugin. Their chip colours cannot be read through the API and a rewrite would lose them, so they are left alone unless you pass force.`,
          );
        }
        if (report.protections.some((p) => !p.editable)) {
          warnings.push(`${title}: has a protected range this account cannot edit.`);
        }
      }

      const spreadsheetPolicy = ctx.registry?.policyFor(spreadsheetId);
      const structured: Record<string, unknown> = {
        spreadsheet: {
          id: spreadsheetId,
          title: data.properties?.title ?? "",
          url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
          locale: data.properties?.locale ?? undefined,
          timeZone: data.properties?.timeZone ?? undefined,
          created,
          tabCount: allSheets.length,
        },
        theme: describeTheme(data.properties?.spreadsheetTheme),
        registry: spreadsheetPolicy
          ? {
              path: spreadsheetPolicy.path,
              owner: spreadsheetPolicy.owner,
              summary: describePolicy(spreadsheetPolicy),
            }
          : null,
        manifest: manifest ?? null,
        tabs,
        allTabs: titles,
        namedRanges: (data.namedRanges ?? []).map((n) => ({
          name: n.name ?? "",
          range: n.range ? gridRangeToA1(n.range) : "",
          sheetId: n.range?.sheetId ?? null,
        })),
        warnings,
      };

      return ok(proseFor(structured, tabs, titles, created, warnings), structured, {
        maxResultSizeChars: 120_000,
      });
    }),
  };
}

function describeTheme(
  theme:
    | {
        primaryFontFamily?: string | null;
        themeColors?: Array<{ colorType?: string | null; color?: { rgbColor?: unknown } | null }>;
      }
    | null
    | undefined,
): Record<string, unknown> | null {
  if (!theme) return null;
  const colors: Record<string, string> = {};
  for (const entry of theme.themeColors ?? []) {
    const slot = entry.colorType;
    const hex = colorStyleToText(entry.color as never);
    if (slot && hex) colors[slot] = hex;
  }
  return {
    font: theme.primaryFontFamily ?? null,
    colors: Object.keys(colors).length ? colors : null,
  };
}

function proseFor(
  structured: Record<string, unknown>,
  tabs: TabReport[],
  titles: string[],
  created: boolean,
  warnings: string[],
): string {
  const spreadsheet = structured["spreadsheet"] as { title: string; tabCount: number };
  const registry = structured["registry"] as { summary: string } | null;
  const namedRanges = structured["namedRanges"] as Array<{ name: string; range: string }>;

  const head = created
    ? `Created "${spreadsheet.title}" with ${count(spreadsheet.tabCount, "tab")}.`
    : `"${spreadsheet.title}", ${count(spreadsheet.tabCount, "tab")}: ${listOf(titles)}.`;

  const body = tabs.map((tab) => {
    const bits: string[] = [];
    bits.push(
      `${tab.rows ?? "?"} rows by ${tab.columns ?? "?"} columns`,
    );
    if (tab.frozenRows) bits.push(`${count(tab.frozenRows, "frozen row")}`);
    if (tab.isTable) bits.push(`${count(tab.tables.length, "native Table")}`);
    if (tab.banded) bits.push("banded");
    if (tab.filtered) bits.push("has a filter");
    if (tab.merges) bits.push(`${count(tab.merges, "merged range")}`);
    if (tab.protections.length) bits.push(`${count(tab.protections.length, "protected range")}`);

    const headerLine = tab.headers.length
      ? `  Headers (row ${tab.conventions?.headerRow ?? "?"}): ${tab.headers.join(" | ")}`
      : "  No header row found.";
    const keyLine = tab.conventions?.keyColumn
      ? `  Key column looks like ${tab.conventions.keyColumn}.`
      : undefined;
    const contractLine = tab.contract ? `  Contract: ${tab.contract.summary}` : undefined;
    const validationLine = tab.validation.length
      ? `  Dropdowns on ${listOf(tab.validation.map((v) => v.column ?? v.range))}${
          tab.validation.some((v) => v.uiOwned) ? ", set outside this plugin" : ""
        }.`
      : undefined;

    return lines(`\n${tab.name}: ${bits.join(", ")}.`, headerLine, keyLine, contractLine, validationLine);
  });

  const extras: string[] = [];
  if (registry) extras.push(`\nRegistry: ${registry.summary}`);
  if (namedRanges.length) {
    extras.push(`\nNamed ranges: ${namedRanges.map((n) => `${n.name} (${n.range})`).join(", ")}`);
  }
  if (titles.length > tabs.length) {
    extras.push(
      `\nDetail shown for the first ${count(tabs.length, "tab")}. Pass sheet to inspect any of the others.`,
    );
  }
  if (warnings.length) {
    extras.push(`\nWorth knowing:\n${warnings.map((w) => `- ${w}`).join("\n")}`);
  }

  return lines(head, ...body, ...extras);
}
