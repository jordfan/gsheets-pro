/**
 * `sheets_settings`: the assumptions block, and named ranges.
 *
 * A number typed into the middle of a formula is invisible. The convention a
 * careful person follows is to lift every assumption into a block near the top,
 * one row each, with the value in its own cell and a note saying where the
 * number came from, and then to name that cell so the formulas downstream read
 * `Fee_per_session * Sessions` rather than `$B$4 * D2`.
 *
 * That is the whole tool: write the block, name every value cell, mark the
 * value column as the place a human types, and put a warning only protection
 * over the structure so nobody rearranges it by accident. Named ranges can also
 * be added, repointed and deleted on their own, because they are useful
 * everywhere and not only inside a settings block.
 */

import { z } from "zod";

import {
  a1ToGridRange,
  columnIndexToLetter,
  gridRangeToA1,
  parseA1,
  quoteSheetName,
  toA1Reference,
  type GridRange,
} from "../lib/a1.js";
import { runBatchUpdate, withRetry } from "../lib/batch.js";
import type { Context } from "../lib/client.js";
import { checkRanges, describeCheck } from "../lib/gate.js";
import { err, GsheetsError } from "../lib/errors.js";
import { METADATA_KEYS } from "../lib/contract.js";
import { hasSheetRecord, presetFor, readMetadata, sheetRecord } from "../lib/metaread.js";
import { isColumnWritable } from "../lib/registry.js";
import { count, guarded, lines, listOf, ok, type ToolResponse } from "../lib/result.js";
import {
  isFormula,
  layoutSettingsBlock,
  SETTINGS_HEADERS,
  sanitizeNamedRange,
  type SettingsItem,
  type SettingsLayout,
} from "../lib/settings.js";
import {
  numberFormatForSettings,
  resolveFill,
  resolveHeaderText,
  resolveInputText,
  resolveMutedText,
  SETTINGS_FORMATS,
  type Preset,
} from "../lib/tablecolors.js";
import { metadataRequest, type PluginSheetRecord } from "../lib/tables.js";
import type { ToolDefinition, ToolDeps } from "./types.js";

const NAMED_RANGE_MASK = "namedRanges(namedRangeId,name,range),sheets.properties(sheetId,title)";

export const settingsInputSchema = {
  spreadsheet_id: z.string().describe("The spreadsheet id, the long id in the middle of the sheet's URL."),
  action: z
    .enum(["block", "add_named_range", "update_named_range", "delete_named_range", "list_named_ranges"])
    .optional()
    .describe("block (default) writes a settings block and names every value cell. The rest manage one named range."),
  sheet: z.string().optional().describe("The tab name. Required for everything except list_named_ranges."),
  at: z
    .string()
    .optional()
    .describe("Top left cell of the block, for example A1 or B2. Default A1."),
  title: z.string().optional().describe("A heading above the block, for example Assumptions."),
  items: z
    .array(
      z.object({
        label: z.string().min(1).describe("What the assumption is called, in plain words."),
        value: z
          .union([z.string(), z.number(), z.boolean()])
          .optional()
          .describe('The value. A string starting with "=" is written as a formula.'),
        unit: z.string().optional().describe("What the number is counted in: dollars, sessions, percent."),
        source: z
          .string()
          .optional()
          .describe("Where the number came from. This is the column everybody forgets and later needs."),
        format: z.enum(SETTINGS_FORMATS).optional().describe("How the value should read. Default text."),
        name: z.string().optional().describe("The named range to create. Derived from the label when omitted."),
        named: z.boolean().optional().describe("Pass false for a row that should carry no named range."),
        note: z.string().optional().describe("A note on the label cell, for anything that needs a sentence."),
      }),
    )
    .optional()
    .describe("The rows of the block, in order. Required for action block."),
  name: z.string().optional().describe("The named range's name, for the named range actions."),
  new_name: z.string().optional().describe("Rename a named range, for update_named_range."),
  range: z.string().optional().describe("A1 range the named range covers, for example B4 or C2:C20."),
  preset: z.string().optional().describe("Which preset to paint with. Defaults to the preset the sheet records."),
  protect: z
    .boolean()
    .optional()
    .describe("Put a warning only protection over the block, so an edit asks first. Default true."),
  tab_color: z
    .boolean()
    .optional()
    .describe("Colour the tab with the preset's inputs colour, so it reads as an inputs tab. Default true."),
  dry_run: z.boolean().optional().describe("Report what would be sent, and send nothing."),
};

type SettingsArgs = {
  spreadsheet_id: string;
  action?: "block" | "add_named_range" | "update_named_range" | "delete_named_range" | "list_named_ranges";
  sheet?: string;
  at?: string;
  title?: string;
  items?: Array<SettingsItem & { note?: string }>;
  name?: string;
  new_name?: string;
  range?: string;
  preset?: string;
  protect?: boolean;
  tab_color?: boolean;
  dry_run?: boolean;
};

interface ExistingNamedRange {
  namedRangeId: string;
  name: string;
  range?: GridRange;
}

export function createSettingsTool(deps: ToolDeps): ToolDefinition<typeof settingsInputSchema> {
  return {
    name: "sheets_settings",
    config: {
      title: "Settings block and named ranges",
      description:
        "Write a settings or assumptions block: one row per assumption with its label, value, unit and source, a named range on every value cell, the input colour on the value column, and a warning only protection over the structure. Also adds, repoints, renames and deletes named ranges on their own.",
      inputSchema: settingsInputSchema,
      annotations: { openWorldHint: true },
    },
    handler: guarded(async (raw: Record<string, unknown>): Promise<ToolResponse> => {
      const args = raw as SettingsArgs;
      const ctx = await deps.getContext();
      const action = args.action ?? "block";

      const state = await withRetry(() =>
        ctx.sheets.spreadsheets.get({ spreadsheetId: args.spreadsheet_id, fields: NAMED_RANGE_MASK }),
      );
      const named: ExistingNamedRange[] = (state.data.namedRanges ?? []).flatMap((n) =>
        n.namedRangeId && n.name
          ? [{ namedRangeId: n.namedRangeId, name: n.name, range: (n.range ?? undefined) as GridRange | undefined }]
          : [],
      );
      const titleBySheetId = new Map<number, string>(
        (state.data.sheets ?? []).flatMap((s) =>
          s.properties?.sheetId !== undefined && s.properties?.sheetId !== null && s.properties.title
            ? [[s.properties.sheetId, s.properties.title] as [number, string]]
            : [],
        ),
      );

      if (action === "list_named_ranges") return listNamedRanges(args, named, titleBySheetId);
      if (action !== "block") return manageNamedRange(ctx, args, action, named, titleBySheetId);

      return writeBlock(ctx, args, named);
    }),
  };
}

// ---------------------------------------------------------------------------
// Named ranges on their own
// ---------------------------------------------------------------------------

function listNamedRanges(
  args: SettingsArgs,
  named: ExistingNamedRange[],
  titles: Map<number, string>,
): ToolResponse {
  const rows = named
    .map((n) => ({
      name: n.name,
      range: n.range ? toA1Reference(titles.get(n.range.sheetId ?? -1) ?? "?", gridRangeToA1(n.range)) : "",
      id: n.namedRangeId,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return ok(
    rows.length
      ? lines(
          `${count(rows.length, "named range")} in this spreadsheet.`,
          ...rows.map((r) => `  ${r.name} -> ${r.range}`),
        )
      : "This spreadsheet has no named ranges. A formula that reads Fee_per_session instead of $B$4 is worth the two seconds it takes to make one.",
    { spreadsheet_id: args.spreadsheet_id, named_ranges: rows },
  );
}

async function manageNamedRange(
  ctx: Context,
  args: SettingsArgs,
  action: "add_named_range" | "update_named_range" | "delete_named_range",
  named: ExistingNamedRange[],
  titles: Map<number, string>,
): Promise<ToolResponse> {
  const wanted = String(args.name ?? "").trim();
  if (!wanted) {
    throw err.invalid(
      "name is required.",
      "Say which named range, for example name: Fee_per_session. Call action list_named_ranges to see them.",
    );
  }
  const existing = named.find((n) => n.name.toLowerCase() === wanted.toLowerCase());

  if (action === "delete_named_range") {
    if (!existing) {
      throw new GsheetsError(
        "not_found",
        `No named range called "${wanted}".`,
        named.length
          ? `The named ranges are: ${named.map((n) => n.name).join(", ")}.`
          : "This spreadsheet has no named ranges.",
      );
    }
    const result = await runBatchUpdate(
      ctx.sheets as never,
      args.spreadsheet_id,
      [{ deleteNamedRange: { namedRangeId: existing.namedRangeId } }],
      { dryRun: args.dry_run === true },
    );
    return ok(
      lines(
        `${args.dry_run ? "Would delete" : "Deleted"} the named range ${existing.name}.`,
        "Any formula that referred to it now reads #NAME?, so check the ones that did.",
      ),
      {
        spreadsheet_id: args.spreadsheet_id,
        action,
        applied: args.dry_run !== true,
        dry_run: args.dry_run === true,
        name: existing.name,
        request_count: result.requestCount,
      },
    );
  }

  if (!args.sheet) {
    throw err.invalid("sheet is required.", "A named range points at a range on one tab, so say which tab.");
  }
  const info = await ctx.cache.resolve(args.spreadsheet_id, args.sheet);
  const rangeA1 = String(args.range ?? "").trim();

  if (action === "add_named_range") {
    if (existing) {
      throw new GsheetsError(
        "invalid_argument",
        `A named range called "${existing.name}" already exists.`,
        `It points at ${existing.range ? toA1Reference(titles.get(existing.range.sheetId ?? -1) ?? "?", gridRangeToA1(existing.range)) : "an unknown range"}. Use action update_named_range to repoint it, or pick another name.`,
      );
    }
    if (!rangeA1) {
      throw err.invalid("range is required.", "Give the A1 range the name should cover, for example B4 or C2:C20.");
    }
    parseA1(rangeA1);
    const name = sanitizeNamedRange(wanted, new Set(named.map((n) => n.name)));
    const result = await runBatchUpdate(
      ctx.sheets as never,
      args.spreadsheet_id,
      [{ addNamedRange: { namedRange: { name, range: a1ToGridRange(rangeA1, info.sheetId) } } }],
      { dryRun: args.dry_run === true },
    );
    return ok(
      lines(
        `${args.dry_run ? "Would name" : "Named"} ${toA1Reference(info.title, rangeA1)} as ${name}.`,
        name === wanted ? undefined : `"${wanted}" is not a name Sheets accepts, so it became ${name}.`,
      ),
      {
        spreadsheet_id: args.spreadsheet_id,
        action,
        applied: args.dry_run !== true,
        dry_run: args.dry_run === true,
        name,
        sheet: info.title,
        range: rangeA1,
        request_count: result.requestCount,
      },
    );
  }

  if (!existing) {
    throw new GsheetsError(
      "not_found",
      `No named range called "${wanted}".`,
      "Use action add_named_range to make one, or list_named_ranges to see what exists.",
    );
  }
  const namedRange: Record<string, unknown> = { namedRangeId: existing.namedRangeId };
  const fields: string[] = [];
  if (rangeA1) {
    parseA1(rangeA1);
    namedRange["range"] = a1ToGridRange(rangeA1, info.sheetId);
    fields.push("range");
  }
  if (args.new_name?.trim()) {
    namedRange["name"] = sanitizeNamedRange(
      args.new_name,
      new Set(named.filter((n) => n.namedRangeId !== existing.namedRangeId).map((n) => n.name)),
    );
    fields.push("name");
  }
  if (fields.length === 0) {
    throw err.invalid(
      "Nothing to change.",
      "Pass range to repoint the named range, new_name to rename it, or both.",
    );
  }
  const result = await runBatchUpdate(
    ctx.sheets as never,
    args.spreadsheet_id,
    [{ updateNamedRange: { namedRange, fields: fields.join(",") } }],
    { dryRun: args.dry_run === true },
  );
  return ok(
    `${args.dry_run ? "Would update" : "Updated"} the named range ${existing.name}${
      namedRange["name"] ? ` (now ${namedRange["name"] as string})` : ""
    }${rangeA1 ? ` to cover ${toA1Reference(info.title, rangeA1)}` : ""}.`,
    {
      spreadsheet_id: args.spreadsheet_id,
      action,
      applied: args.dry_run !== true,
      dry_run: args.dry_run === true,
      name: (namedRange["name"] as string) ?? existing.name,
      previous_name: existing.name,
      sheet: info.title,
      range: rangeA1 || undefined,
      request_count: result.requestCount,
    },
  );
}

// ---------------------------------------------------------------------------
// The block
// ---------------------------------------------------------------------------

async function writeBlock(
  ctx: Context,
  args: SettingsArgs,
  named: ExistingNamedRange[],
): Promise<ToolResponse> {
  if (!args.sheet) {
    throw err.invalid("sheet is required.", "Say which tab the settings block goes on.");
  }
  const items = args.items ?? [];
  if (!items.length) {
    throw err.invalid(
      "items is required for a settings block.",
      'Each item is one assumption: { label: "Fee per session", value: 55, unit: "dollars", source: "2026-27 vendor agreement" }.',
    );
  }
  const info = await ctx.cache.resolve(args.spreadsheet_id, args.sheet);

  const anchor = String(args.at ?? "A1").trim() || "A1";
  const anchorBounds = a1ToGridRange(anchor, info.sheetId);
  const startRow = (anchorBounds.startRowIndex ?? 0) + 1;
  const startColumn = anchorBounds.startColumnIndex ?? 0;

  // The registry decides whether these columns are ours before anything else.
  const policy = ctx.registry?.policyFor(args.spreadsheet_id, info.title);
  for (let c = startColumn; c < startColumn + SETTINGS_HEADERS.length; c += 1) {
    const writable = isColumnWritable(policy, { letter: columnIndexToLetter(c) });
    if (!writable.writable && writable.reason) {
      throw new GsheetsError("contract_violation", writable.reason, "Move the block to columns that are ours, or change the registry entry.");
    }
  }

  // Two passes: the first fixes where the block lands, the second names its
  // rows against the named ranges that sit outside it.
  const provisional = layoutSettingsBlock(items, { startRow, startColumn, title: args.title });
  const blockRange: GridRange = {
    sheetId: info.sheetId,
    startRowIndex: startRow - 1,
    endRowIndex: provisional.lastDataRow,
    startColumnIndex: startColumn,
    endColumnIndex: startColumn + SETTINGS_HEADERS.length,
  };
  const insideBlock = (range: GridRange | undefined) =>
    !!range &&
    range.sheetId === info.sheetId &&
    (range.startRowIndex ?? 0) >= (blockRange.startRowIndex ?? 0) &&
    (range.endRowIndex ?? 0) <= (blockRange.endRowIndex ?? 0) &&
    (range.startColumnIndex ?? 0) >= (blockRange.startColumnIndex ?? 0) &&
    (range.endColumnIndex ?? 0) <= (blockRange.endColumnIndex ?? 0);

  const reusable = new Map<string, ExistingNamedRange>();
  const taken: string[] = [];
  for (const entry of named) {
    if (insideBlock(entry.range)) reusable.set(entry.name.toLowerCase(), entry);
    else taken.push(entry.name);
  }
  const layout = layoutSettingsBlock(items, { startRow, startColumn, title: args.title, taken });

  const snapshot = await readMetadata(ctx.sheets as never, args.spreadsheet_id);
  const preset = presetFor(snapshot, info.sheetId, args.preset);

  const requests: unknown[] = [];
  requests.push(...cellRequests(layout, args, preset, info.sheetId, startColumn));

  const namedRangeReport: Array<{ name: string; cell: string; created: boolean }> = [];
  for (const row of layout.rows) {
    if (!row.namedRange) continue;
    const range = a1ToGridRange(row.valueA1, info.sheetId);
    const hit = reusable.get(row.namedRange.toLowerCase());
    if (hit) {
      requests.push({
        updateNamedRange: { namedRange: { namedRangeId: hit.namedRangeId, range }, fields: "range" },
      });
      namedRangeReport.push({ name: row.namedRange, cell: row.valueA1, created: false });
    } else {
      requests.push({ addNamedRange: { namedRange: { name: row.namedRange, range } } });
      namedRangeReport.push({ name: row.namedRange, cell: row.valueA1, created: true });
    }
  }

  if (args.protect !== false) {
    requests.push({
      addProtectedRange: {
        protectedRange: {
          range: blockRange,
          warningOnly: true,
          description:
            "Settings block. Change the values; leave the labels, units and sources where they are, because formulas and named ranges point at these cells.",
        },
      },
    });
  }

  if (args.tab_color !== false && preset.tabs?.inputs) {
    requests.push({
      updateSheetProperties: {
        properties: { sheetId: info.sheetId, tabColorStyle: resolveFill(preset, preset.tabs.inputs) },
        fields: "tabColorStyle",
      },
    });
  }

  requests.push({
    autoResizeDimensions: {
      dimensions: {
        sheetId: info.sheetId,
        dimension: "COLUMNS",
        startIndex: startColumn,
        endIndex: startColumn + SETTINGS_HEADERS.length,
      },
    },
  });

  const record: PluginSheetRecord = {
    ...((sheetRecord(snapshot, info.sheetId) ?? {}) as PluginSheetRecord),
    preset: preset.name,
    settings: { range: layout.blockA1 },
  };
  requests.push(
    metadataRequest({
      key: METADATA_KEYS.sheet,
      value: record,
      location: { sheetId: info.sheetId },
      exists: hasSheetRecord(snapshot, info.sheetId),
    }),
  );

  const result = await runBatchUpdate(ctx.sheets as never, args.spreadsheet_id, requests, {
    dryRun: args.dry_run === true,
  });

  // Values went in, so read them back: a settings block often holds formulas.
  const reference = `${quoteSheetName(info.title)}!${layout.valueColumnA1}`;
  const check =
    args.dry_run === true
      ? undefined
      : await checkRanges(ctx.sheets as never, args.spreadsheet_id, [reference]);

  const structured: Record<string, unknown> = {
    spreadsheet_id: args.spreadsheet_id,
    sheet: info.title,
    action: "block",
    applied: args.dry_run !== true,
    dry_run: args.dry_run === true,
    block: layout.blockA1,
    value_column: layout.valueColumnA1,
    rows: layout.rows.map((r) => ({
      label: r.item.label,
      cell: r.valueA1,
      named_range: r.namedRange ?? null,
      format: r.item.format ?? "text",
    })),
    named_ranges: namedRangeReport,
    preset: preset.name,
    protected: args.protect !== false,
    request_count: result.requestCount,
    check: check ?? null,
  };

  const created = namedRangeReport.filter((n) => n.created).length;
  return ok(
    lines(
      `${args.dry_run ? "Would write" : "Wrote"} a settings block on ${info.title} at ${layout.blockA1}: ${count(items.length, "assumption")}.`,
      namedRangeReport.length
        ? `Named ${listOf(namedRangeReport.map((n) => `${n.name} (${n.cell})`))}.${created < namedRangeReport.length ? " Existing names were repointed rather than duplicated." : ""}`
        : undefined,
      `Values are the ${preset.name} preset's input colour, so it is visible which cells a person is meant to type in.`,
      args.protect !== false
        ? "The block carries a warning only protection: an edit asks first, and nobody is locked out."
        : undefined,
      check ? describeCheck(check) : "Dry run: nothing was sent.",
    ),
    structured,
  );
}

/** The updateCells requests that paint and fill the block. */
function cellRequests(
  layout: SettingsLayout,
  args: SettingsArgs,
  preset: Preset,
  sheetId: number,
  startColumn: number,
): unknown[] {
  const requests: unknown[] = [];
  const muted = resolveMutedText(preset);
  const input = resolveInputText(preset);

  if (layout.titleRow && args.title) {
    const title = preset.roles.title;
    requests.push({
      updateCells: {
        start: { sheetId, rowIndex: layout.titleRow - 1, columnIndex: startColumn },
        rows: [
          {
            values: [
              {
                userEnteredValue: { stringValue: args.title },
                userEnteredFormat: {
                  textFormat: {
                    bold: title?.bold !== false,
                    fontSize: title?.size ?? 14,
                    fontFamily:
                      title?.font === "display" ? (preset.fonts.display ?? preset.fonts.primary) : preset.fonts.primary,
                    foregroundColorStyle: resolveFill(preset, title?.text ?? "header"),
                  },
                },
              },
            ],
          },
        ],
        fields: "userEnteredValue,userEnteredFormat.textFormat",
      },
    });
  }

  requests.push({
    updateCells: {
      start: { sheetId, rowIndex: layout.headerRow - 1, columnIndex: startColumn },
      rows: [
        {
          values: SETTINGS_HEADERS.map((header) => ({
            userEnteredValue: { stringValue: header },
            userEnteredFormat: {
              backgroundColorStyle: resolveFill(preset, "header"),
              textFormat: {
                bold: preset.roles.header.bold !== false,
                foregroundColorStyle: resolveHeaderText(preset),
              },
            },
          })),
        },
      ],
      fields: "userEnteredValue,userEnteredFormat(backgroundColorStyle,textFormat)",
    },
  });

  const rows = layout.rows.map((row) => {
    const item = row.item;
    const numberFormat = numberFormatForSettings(preset, item.format);
    const valueCell: Record<string, unknown> = {
      userEnteredValue: extendedValue(item.value, item.format),
      userEnteredFormat: {
        textFormat: input ? { foregroundColorStyle: input } : {},
        horizontalAlignment: numberFormat ? "RIGHT" : "LEFT",
        ...(numberFormat ? { numberFormat } : {}),
      },
    };
    const labelCell: Record<string, unknown> = {
      userEnteredValue: { stringValue: item.label },
      userEnteredFormat: { textFormat: {} },
    };
    const withNote = item as SettingsItem & { note?: string };
    if (withNote.note) labelCell["note"] = withNote.note;

    return {
      values: [
        labelCell,
        valueCell,
        {
          userEnteredValue: item.unit ? { stringValue: item.unit } : {},
          userEnteredFormat: { textFormat: { foregroundColorStyle: muted } },
        },
        {
          userEnteredValue: item.source ? { stringValue: item.source } : {},
          userEnteredFormat: { textFormat: { italic: true, foregroundColorStyle: muted } },
        },
      ],
    };
  });

  requests.push({
    updateCells: {
      start: { sheetId, rowIndex: layout.firstDataRow - 1, columnIndex: startColumn },
      rows,
      fields: "userEnteredValue,userEnteredFormat(textFormat,horizontalAlignment,numberFormat),note",
    },
  });

  return requests;
}

/** The ExtendedValue for a settings value, formulas and dates included. */
function extendedValue(
  value: string | number | boolean | undefined,
  format: SettingsItem["format"],
): Record<string, unknown> {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "number") return { numberValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  const text = String(value);
  if (isFormula(text)) return { formulaValue: text };
  if (format === "date") {
    const serial = dateSerial(text);
    if (serial !== undefined) return { numberValue: serial };
  }
  if (format && format !== "text") {
    const n = Number(text.replace(/[$,%\s]/g, ""));
    if (Number.isFinite(n)) return { numberValue: format === "percent" && text.includes("%") ? n / 100 : n };
  }
  return { stringValue: text };
}

/**
 * A date as Sheets stores it: days since 1899-12-30. Written as a number so a
 * date formatted cell really is a date and can be compared and sorted, rather
 * than a string that merely looks like one.
 */
export function dateSerial(text: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!m) return undefined;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(utc)) return undefined;
  return Math.round((utc - Date.UTC(1899, 11, 30)) / 86_400_000);
}
