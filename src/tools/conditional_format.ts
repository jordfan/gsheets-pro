/**
 * `sheets_conditional_format`: rules that paint a cell according to what it says.
 *
 * The API addresses these rules by their index in a per sheet list, and those
 * indexes shift whenever anything is added or deleted, including by a person
 * working in the UI at the same time. So this tool never takes an index from
 * the caller. It takes a fingerprint of the rule's meaning, resolves it against
 * a list read in the same call, and refuses with the current list in hand when
 * the fingerprint no longer matches anything.
 *
 * The other job here is standing in for chip colors. A dropdown's colors cannot
 * be set through the API at all, so a status column that a person would colour
 * with chips is coloured here with one boolean rule per option, drawn from the
 * preset's ok, warn, flag and muted roles.
 */

import { z } from "zod";

import { a1ToGridRange, gridRangeToA1, parseA1, quoteSheetName } from "../lib/a1.js";
import { runBatchUpdate, withRetry } from "../lib/batch.js";
import {
  buildCellFormat,
  describeRule,
  fingerprintRule,
  isMatch,
  resolveFingerprint,
  type CfRule,
} from "../lib/cfrules.js";
import { buildCondition, CONDITION_KINDS, CONDITION_OPERATORS } from "../lib/conditions.js";
import type { Context } from "../lib/client.js";
import { err, GsheetsError } from "../lib/errors.js";
import { presetFor, readMetadata } from "../lib/metaread.js";
import { count, guarded, lines, listOf, ok, type ToolResponse } from "../lib/result.js";
import { FILL_ROLES, resolveFill, type Preset } from "../lib/tablecolors.js";
import type { ToolDefinition, ToolDeps } from "./types.js";

const RULES_MASK =
  "sheets(properties(sheetId,title),conditionalFormats(ranges,booleanRule(condition(type,values(userEnteredValue,relativeDate)),format(backgroundColorStyle,backgroundColor,textFormat(bold,italic,strikethrough,underline,foregroundColorStyle,foregroundColor))),gradientRule(minpoint,midpoint,maxpoint)))";

const INTERPOLATION_TYPES = ["MIN", "MAX", "NUMBER", "PERCENT", "PERCENTILE"] as const;

const pointSchema = z.object({
  type: z.enum(INTERPOLATION_TYPES).describe("MIN and MAX take the range's own extremes and need no value."),
  value: z.union([z.string(), z.number()]).optional().describe("Required for NUMBER, PERCENT and PERCENTILE."),
  color: z.string().describe("A preset role, a theme slot such as theme:ACCENT3, or a hex colour."),
});

export const conditionalFormatInputSchema = {
  spreadsheet_id: z.string().describe("The spreadsheet id, the long id in the middle of the sheet's URL."),
  action: z
    .enum(["list", "add", "update", "delete"])
    .describe("list first: it returns the fingerprint that update and delete take."),
  sheet: z
    .string()
    .optional()
    .describe("The tab name. Required for add, update and delete. Omit on list to cover every tab."),
  ranges: z
    .array(z.string().min(1))
    .optional()
    .describe("A1 ranges the rule covers, for example [\"E2:E200\"]. Required for add."),
  fingerprint: z
    .string()
    .optional()
    .describe("Which rule to change, from a previous list. Required for update and delete."),
  kind: z
    .enum(["boolean", "gradient"])
    .optional()
    .describe("boolean paints when a condition holds. gradient is a colour scale. Default boolean."),
  operator: z
    .enum(CONDITION_OPERATORS)
    .optional()
    .describe("For a boolean rule: how the cell is tested, for example equal, contains, less_than, custom_formula."),
  value_kind: z
    .enum(CONDITION_KINDS)
    .optional()
    .describe("Only needed when the operator reads the same for a number, a date and a string."),
  value: z.union([z.string(), z.number(), z.boolean()]).optional().describe("The value compared against."),
  value2: z.union([z.string(), z.number(), z.boolean()]).optional().describe("The far end of a between."),
  values: z.array(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Options, for one_of_list."),
  formula: z
    .string()
    .optional()
    .describe('For custom_formula: the test, written for the range\'s first cell, for example "=$E2=\\"Overdue\\"".'),
  format: z
    .object({
      fill: z.string().optional().describe(`A preset role (${FILL_ROLES.join(", ")}), a theme slot, or a hex colour.`),
      text_color: z.string().optional(),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      strikethrough: z.boolean().optional(),
      underline: z.boolean().optional(),
    })
    .optional()
    .describe("What the rule paints. Only the properties named are set, so the cell keeps everything else."),
  gradient: z
    .object({ min: pointSchema, mid: pointSchema.optional(), max: pointSchema })
    .optional()
    .describe("For kind gradient: the two or three points of the colour scale."),
  preset: z
    .string()
    .optional()
    .describe("Which preset the role names resolve against. Defaults to the preset the sheet records."),
  index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Where to insert an added rule. Rules are evaluated in order, first match wins. Default last."),
  dry_run: z.boolean().optional().describe("Report what would be sent, and send nothing."),
};

type CfArgs = {
  spreadsheet_id: string;
  action: "list" | "add" | "update" | "delete";
  sheet?: string;
  ranges?: string[];
  fingerprint?: string;
  kind?: "boolean" | "gradient";
  operator?: (typeof CONDITION_OPERATORS)[number];
  value_kind?: "number" | "text" | "date";
  value?: string | number | boolean;
  value2?: string | number | boolean;
  values?: Array<string | number | boolean>;
  formula?: string;
  format?: {
    fill?: string;
    text_color?: string;
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
  };
  gradient?: {
    min: { type: string; value?: string | number; color: string };
    mid?: { type: string; value?: string | number; color: string };
    max: { type: string; value?: string | number; color: string };
  };
  preset?: string;
  index?: number;
  dry_run?: boolean;
};

interface SheetRules {
  sheetId: number;
  title: string;
  rules: CfRule[];
}

export function createConditionalFormatTool(
  deps: ToolDeps,
): ToolDefinition<typeof conditionalFormatInputSchema> {
  return {
    name: "sheets_conditional_format",
    config: {
      title: "Conditional formatting",
      description:
        "List, add, update and delete conditional format rules: boolean rules that paint when a condition holds, and gradient colour scales. Rules are addressed by a fingerprint of what they do rather than by index, because indexes shift under you. Fills can name a preset role such as ok, warn or flag.",
      inputSchema: conditionalFormatInputSchema,
      annotations: { openWorldHint: true },
    },
    handler: guarded(async (raw: Record<string, unknown>): Promise<ToolResponse> => {
      const args = raw as CfArgs;
      const ctx = await deps.getContext();

      const all = await readRules(ctx, args.spreadsheet_id);
      const target = args.sheet
        ? all.find((s) => s.title.toLowerCase() === args.sheet!.trim().toLowerCase())
        : undefined;
      if (args.sheet && !target) {
        throw err.sheetNotFound(
          args.sheet,
          all.map((s) => s.title),
        );
      }

      if (args.action === "list") return listRules(args, all, target);

      if (!target) {
        throw err.invalid(
          "sheet is required.",
          "Conditional format rules belong to one tab, so say which. Call action list with no sheet to see every tab's rules.",
        );
      }

      const snapshot = await readMetadata(ctx.sheets as never, args.spreadsheet_id);
      const preset = presetFor(snapshot, target.sheetId, args.preset);

      if (args.action === "add") return addRule(ctx, args, target, preset);
      if (args.action === "update") return updateRule(ctx, args, target, preset);
      return deleteRule(ctx, args, target);
    }),
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function listRules(args: CfArgs, all: SheetRules[], target: SheetRules | undefined): ToolResponse {
  const sheets = target ? [target] : all;
  const structured = {
    spreadsheet_id: args.spreadsheet_id,
    sheets: sheets.map((sheet) => ({
      sheet: sheet.title,
      rules: sheet.rules.map((rule, index) => ({
        index,
        fingerprint: fingerprintRule(rule),
        summary: describeRule(rule),
        kind: rule.gradientRule ? "gradient" : "boolean",
        ranges: (rule.ranges ?? []).map((r) => gridRangeToA1(r)),
      })),
    })),
  };

  const body = sheets.map((sheet) => {
    if (sheet.rules.length === 0) return `\n${sheet.title}: no conditional format rules.`;
    const rows = sheet.rules.map(
      (rule, index) => `  ${index}. ${describeRule(rule)}  [${fingerprintRule(rule)}]`,
    );
    return lines(`\n${sheet.title}: ${count(sheet.rules.length, "rule")}, in evaluation order.`, ...rows);
  });

  return ok(
    lines(
      "Rules are evaluated top down and the first match wins, so order matters.",
      ...body,
      "\nPass a fingerprint to update or delete one. It names what the rule does, so it still finds the rule after other rules move around it.",
    ),
    structured,
  );
}

async function addRule(
  ctx: Context,
  args: CfArgs,
  target: SheetRules,
  preset: Preset,
): Promise<ToolResponse> {
  if (!args.ranges?.length) {
    throw err.invalid(
      "ranges is required to add a rule.",
      'Pass the A1 ranges the rule covers, for example ranges: ["E2:E200"].',
    );
  }
  const rule = buildRule(args, target.sheetId, preset);
  const index = args.index ?? target.rules.length;

  const result = await runBatchUpdate(
    ctx.sheets as never,
    args.spreadsheet_id,
    [{ addConditionalFormatRule: { rule, index } }],
    { dryRun: args.dry_run === true },
  );

  const fingerprint = fingerprintRule(rule);
  return ok(
    lines(
      `${args.dry_run ? "Would add" : "Added"} a rule at position ${index} on ${target.title}: ${describeRule(rule)}.`,
      `Fingerprint: ${fingerprint}`,
      index < target.rules.length
        ? `It now runs before ${count(target.rules.length - index, "existing rule")}, and the first matching rule wins.`
        : undefined,
    ),
    {
      spreadsheet_id: args.spreadsheet_id,
      sheet: target.title,
      action: "add",
      applied: args.dry_run !== true,
      dry_run: args.dry_run === true,
      index,
      fingerprint,
      summary: describeRule(rule),
      rule,
      request_count: result.requestCount,
    },
  );
}

async function updateRule(
  ctx: Context,
  args: CfArgs,
  target: SheetRules,
  preset: Preset,
): Promise<ToolResponse> {
  const found = requireFingerprint(args, target);
  const merged = mergeRule(found.rule, args, target.sheetId, preset);

  const result = await runBatchUpdate(
    ctx.sheets as never,
    args.spreadsheet_id,
    [
      {
        updateConditionalFormatRule: {
          sheetId: target.sheetId,
          index: found.index,
          rule: merged,
        },
      },
    ],
    { dryRun: args.dry_run === true },
  );

  return ok(
    lines(
      `${args.dry_run ? "Would update" : "Updated"} rule ${found.index} on ${target.title}.`,
      `Was: ${describeRule(found.rule)}`,
      `Now: ${describeRule(merged)}`,
      found.match === "moved"
        ? "The fingerprint matched on what the rule does rather than exactly, so its ranges had shifted since you read it. The ranges above are the current ones."
        : undefined,
      `New fingerprint: ${fingerprintRule(merged)}`,
    ),
    {
      spreadsheet_id: args.spreadsheet_id,
      sheet: target.title,
      action: "update",
      applied: args.dry_run !== true,
      dry_run: args.dry_run === true,
      index: found.index,
      match: found.match,
      before: { fingerprint: found.fingerprint, summary: describeRule(found.rule) },
      after: { fingerprint: fingerprintRule(merged), summary: describeRule(merged) },
      rule: merged,
      request_count: result.requestCount,
    },
  );
}

async function deleteRule(
  ctx: Context,
  args: CfArgs,
  target: SheetRules,
): Promise<ToolResponse> {
  const found = requireFingerprint(args, target);

  const result = await runBatchUpdate(
    ctx.sheets as never,
    args.spreadsheet_id,
    [{ deleteConditionalFormatRule: { sheetId: target.sheetId, index: found.index } }],
    { dryRun: args.dry_run === true },
  );

  return ok(
    lines(
      `${args.dry_run ? "Would delete" : "Deleted"} rule ${found.index} on ${target.title}: ${describeRule(found.rule)}.`,
      target.rules.length > found.index + 1
        ? `${count(target.rules.length - found.index - 1, "rule")} below it moved up by one, so any index you were holding is now stale. Fingerprints are not.`
        : undefined,
    ),
    {
      spreadsheet_id: args.spreadsheet_id,
      sheet: target.title,
      action: "delete",
      applied: args.dry_run !== true,
      dry_run: args.dry_run === true,
      index: found.index,
      match: found.match,
      deleted: { fingerprint: found.fingerprint, summary: describeRule(found.rule) },
      request_count: result.requestCount,
    },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readRules(ctx: Context, spreadsheetId: string): Promise<SheetRules[]> {
  const res = await withRetry(() =>
    (ctx.sheets as unknown as {
      spreadsheets: { get(p: unknown): Promise<{ data: unknown }> };
    }).spreadsheets.get({ spreadsheetId, fields: RULES_MASK }),
  );
  const sheets =
    (res.data as {
      sheets?: Array<{
        properties?: { sheetId?: number; title?: string };
        conditionalFormats?: CfRule[];
      }>;
    }).sheets ?? [];
  return sheets.flatMap((sheet) => {
    const sheetId = sheet.properties?.sheetId;
    const title = sheet.properties?.title;
    if (sheetId === undefined || sheetId === null || !title) return [];
    return [{ sheetId, title, rules: sheet.conditionalFormats ?? [] }];
  });
}

function requireFingerprint(args: CfArgs, target: SheetRules) {
  if (!args.fingerprint?.trim()) {
    throw err.invalid(
      `fingerprint is required to ${args.action} a rule.`,
      "Call action list first and pass the fingerprint it printed beside the rule. Indexes are not accepted, because they shift whenever a rule is added or removed.",
    );
  }
  const found = resolveFingerprint(target.rules, args.fingerprint.trim());
  if (isMatch(found)) return found;

  const listing = found.candidates.map((c) => `  ${c.index}. ${c.summary}  [${c.fingerprint}]`).join("\n");
  throw new GsheetsError(
    "invalid_argument",
    found.reason === "ambiguous"
      ? `More than one rule on ${target.title} matches that fingerprint.`
      : `No rule on ${target.title} matches the fingerprint ${args.fingerprint}.`,
    found.candidates.length
      ? `The rules on that tab now are:\n${listing}\nPick one of those fingerprints.`
      : "That tab has no conditional format rules at all. The rule was probably deleted, in the UI or by an earlier call.",
    { candidates: found.candidates },
  );
}

function buildRule(args: CfArgs, sheetId: number, preset: Preset): CfRule {
  const ranges = (args.ranges ?? []).map((range) => {
    parseA1(range);
    return a1ToGridRange(range, sheetId);
  });
  const resolve = (token: string) => resolveFill(preset, token);

  if (args.kind === "gradient") {
    if (!args.gradient) {
      throw err.invalid(
        "A gradient rule needs its points.",
        'Pass gradient with min and max, and optionally mid, for example gradient: { min: { type: "MIN", color: "#FFFFFF" }, max: { type: "MAX", color: "ok" } }.',
      );
    }
    const point = (p: { type: string; value?: string | number; color: string }) => {
      const out: { type: string; value?: string; colorStyle: unknown } = {
        type: p.type,
        colorStyle: resolve(p.color),
      };
      if (p.value !== undefined) out.value = String(p.value);
      if ((p.type === "NUMBER" || p.type === "PERCENT" || p.type === "PERCENTILE") && out.value === undefined) {
        throw err.invalid(
          `A ${p.type} gradient point needs a value.`,
          "MIN and MAX read the range's own extremes; the other three need the number to anchor on.",
        );
      }
      return out;
    };
    const gradientRule: Record<string, unknown> = {
      minpoint: point(args.gradient.min),
      maxpoint: point(args.gradient.max),
    };
    if (args.gradient.mid) gradientRule["midpoint"] = point(args.gradient.mid);
    return { ranges, gradientRule } as CfRule;
  }

  if (!args.operator) {
    throw err.invalid(
      "A boolean rule needs an operator.",
      'For example operator: "equal" with value: "Overdue", or operator: "custom_formula" with a formula.',
    );
  }
  const condition = buildCondition({
    operator: args.operator,
    kind: args.value_kind,
    value: args.value,
    value2: args.value2,
    values: args.values,
    formula: args.formula,
  });
  const format = buildCellFormat(args.format ?? {}, resolve);
  if (!format) {
    throw err.invalid(
      "A boolean rule needs a format, or it paints nothing.",
      'Pass format, for example format: { fill: "flag" } or format: { bold: true, text_color: "#9B4A44" }.',
    );
  }
  return { ranges, booleanRule: { condition, format } };
}

/**
 * Update replaces the rule, so anything the caller did not mention is carried
 * over from the rule that is there. Changing only a colour should not silently
 * drop the condition it paints on.
 */
function mergeRule(existing: CfRule, args: CfArgs, sheetId: number, preset: Preset): CfRule {
  const merged: CfRule = {
    ranges: args.ranges?.length
      ? args.ranges.map((range) => {
          parseA1(range);
          return a1ToGridRange(range, sheetId);
        })
      : existing.ranges,
  };
  const resolve = (token: string) => resolveFill(preset, token);

  if (args.kind === "gradient" || (args.gradient && !args.operator)) {
    const built = buildRule({ ...args, kind: "gradient" }, sheetId, preset);
    merged.gradientRule = built.gradientRule;
    return merged;
  }

  const condition = args.operator
    ? buildCondition({
        operator: args.operator,
        kind: args.value_kind,
        value: args.value,
        value2: args.value2,
        values: args.values,
        formula: args.formula,
      })
    : existing.booleanRule?.condition;
  if (!condition) {
    throw err.invalid(
      "That rule is a gradient, so an update has to say what it becomes.",
      "Pass gradient to change the colour scale, or operator and format to replace it with a boolean rule.",
    );
  }
  const format = args.format
    ? (buildCellFormat(args.format, resolve) ?? existing.booleanRule?.format)
    : existing.booleanRule?.format;
  merged.booleanRule = { condition, format };
  return merged;
}

/** Exported for the Table tool, which paints status fills through this shape. */
export function statusRuleFor(
  sheetId: number,
  rangeA1: string,
  option: string,
  fill: string,
  preset: Preset,
): CfRule {
  parseA1(rangeA1);
  return {
    ranges: [a1ToGridRange(rangeA1, sheetId)],
    booleanRule: {
      condition: buildCondition({ operator: "equal", kind: "text", value: option }),
      format: buildCellFormat({ fill }, (token) => resolveFill(preset, token)),
    },
  };
}

/** The tab qualified A1 of a rule's ranges, for a readable response. */
export function ruleRangeText(sheet: string, rule: CfRule): string {
  return listOf((rule.ranges ?? []).map((r) => `${quoteSheetName(sheet)}!${gridRangeToA1(r)}`));
}
