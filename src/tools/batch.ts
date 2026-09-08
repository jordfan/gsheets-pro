/**
 * `sheets_batch`: the escape hatch.
 *
 * The named tools cover what people do most days. The Sheets API has sixty-nine
 * request types, and the ones left over (charts, slicers, pivot tables, filter
 * views, cut and paste, text to columns) are real work that somebody will need
 * on a Tuesday. A plugin without an escape hatch turns that Tuesday into a
 * feature request.
 *
 * Two things make the hatch worth using rather than reaching for a raw HTTP
 * call. First, it speaks the same language as everything else: sheet names and
 * A1 anywhere a numeric sheet id or a half open GridRange belongs, resolved
 * server side, because nobody types `endColumnIndex` correctly by hand. Second,
 * `dry_run` shows the resolved plan before anything is sent, which is the only
 * cheap way to find out that a field wanted a DimensionRange and got a
 * GridRange.
 *
 * What it does not do is the point of the reminder in its response. The named
 * tools refuse to overwrite a formula, refuse to write outside the columns the
 * registry reserves, refuse to rewrite a dropdown a person coloured by hand,
 * and refuse to reorder rows on a sheet whose row numbers are written down
 * elsewhere. None of that runs here. On a spreadsheet the registry marks as
 * belonging to a human or shared with one, the response says so plainly.
 */

import { z } from "zod";

import { runBatchUpdate } from "../lib/batch.js";
import { describeCheck, runErrorGate, type GateCheck } from "../lib/errorgate.js";
import { recordWrite } from "../lib/writelog.js";
import { err } from "../lib/errors.js";
import {
  resolveRequests,
  VALUE_CHANGING_REQUESTS,
  type PlanEntry,
} from "../lib/rangeresolve.js";
import { describeSheet } from "../lib/registry.js";
import { count, guarded, lines, listOf, ok, type ToolResponse } from "../lib/result.js";
import type { ToolDefinition, ToolDeps } from "./types.js";

/** One batchUpdate is atomic, and a very long one is hard to read back. */
export const MAX_REQUESTS = 100;

export const batchInputSchema = {
  spreadsheet_id: z.string().describe("The spreadsheet id, the long id in the middle of the sheet's URL."),
  requests: z
    .array(z.record(z.string(), z.unknown()))
    .min(1)
    .max(MAX_REQUESTS)
    .describe(
      'Raw spreadsheets.batchUpdate requests, one request type per entry, for example { "sortRange": { "range": "\'Roster\'!A2:F80", "sortSpecs": [{ "column": 0 }] } }. Write sheet names where a sheetId belongs and A1 where a GridRange belongs; the server resolves both. Fields that want whole rows or columns take "5:9" or "B:D".',
    ),
  sheet: z
    .string()
    .optional()
    .describe("The tab an unqualified A1 range belongs to. Ranges that name their own tab ignore it."),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "Resolve the requests and return the plan without sending anything. Worth doing once for any batch you have not run before.",
    ),
  check: z
    .boolean()
    .optional()
    .describe(
      "Re-read the touched ranges afterwards and report formula errors. Default true. Turn it off only for a batch that touches no values.",
    ),
};

type BatchArgs = {
  spreadsheet_id: string;
  requests: Array<Record<string, unknown>>;
  sheet?: string;
  dry_run?: boolean;
  check?: boolean;
};

const DESCRIPTION = [
  "Send raw spreadsheets.batchUpdate requests. The escape hatch to every request type the named tools do not cover: charts, slicers, pivot tables, filter views, cut and paste, text to columns.",
  "",
  "Write tab names where a sheetId belongs and A1 where a GridRange belongs, and the server resolves them. Fields that take whole rows or columns, such as insertDimension.range, want \"5:9\" or \"B:D\".",
  "",
  "Pass dry_run to see the resolved plan without sending it. Everything goes in one batchUpdate, so it either all applies or none of it does.",
  "",
  "This tool skips the checks the named tools run: no formula guard, no writable column limits, no protection for a dropdown someone coloured by hand, no refusal to reorder rows that are numbered elsewhere. Prefer sheets_write, sheets_style, sheets_structure and sheets_table when they cover the job.",
].join("\n");

export function createBatchTool(deps: ToolDeps): ToolDefinition<typeof batchInputSchema> {
  return {
    name: "sheets_batch",
    config: {
      title: "Raw batchUpdate",
      description: DESCRIPTION,
      inputSchema: batchInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handler: guarded(async (raw: Record<string, unknown>): Promise<ToolResponse> => {
      const args = raw as BatchArgs;
      const ctx = await deps.getContext();
      const spreadsheetId = args.spreadsheet_id;

      if (!Array.isArray(args.requests) || args.requests.length === 0) {
        throw err.invalid(
          "requests is empty.",
          'Pass at least one batchUpdate request, for example [{ "addChart": { "chart": { ... } } }].',
        );
      }

      const resolved = await resolveRequests(args.requests, {
        resolveSheet: (name) => ctx.cache.resolve(spreadsheetId, name),
        resolveSheetId: (sheetId) => ctx.cache.resolveId(spreadsheetId, sheetId),
        ...(args.sheet ? { defaultSheet: args.sheet } : {}),
      });

      const types = resolved.plan.map((p) => p.type);
      const changesValues = types.some((t) => VALUE_CHANGING_REQUESTS.includes(t));
      const reminders = buildReminders(ctx, spreadsheetId, resolved.sheets, types);

      if (args.dry_run) {
        const structured: Record<string, unknown> = {
          spreadsheet_id: spreadsheetId,
          dry_run: true,
          request_count: resolved.requests.length,
          plan: resolved.plan,
          resolved_requests: resolved.requests,
          touched: resolved.touched,
          sheets: resolved.sheets,
          changes_values: changesValues,
          reminders,
        };
        return ok(
          lines(
            `Dry run. ${count(resolved.requests.length, "request")} resolved, nothing sent.`,
            ...resolved.plan.map(planLine),
            resolved.touched.length
              ? `\nTouches ${listOf(resolved.touched)}.`
              : "\nNo request names a range, so the check would have nothing to re-read.",
            reminders.length ? `\nWorth knowing:\n${reminders.map((r) => `- ${r}`).join("\n")}` : undefined,
          ),
          structured,
          { maxResultSizeChars: 120_000 },
        );
      }

      const result = await runBatchUpdate(ctx.sheets as never, spreadsheetId, resolved.requests);

      // Any of these can add, remove or rename a tab, so the name map is stale.
      ctx.cache.invalidate(spreadsheetId);

      // The escape hatch skips the named tools' checks, which is exactly why
      // what it touched has to reach the ledger: L14 is the last thing left
      // that would notice a raw request landing in a colleague's column.
      for (const range of resolved.touched) {
        recordWrite({ spreadsheetId, range, tool: "sheets_batch" });
      }

      let check: GateCheck | undefined;
      if (args.check !== false && changesValues && resolved.touched.length > 0) {
        check = await runErrorGate(ctx.sheets as never, spreadsheetId, resolved.touched);
      }

      const replies = ((result.response as { replies?: unknown[] } | undefined)?.replies ?? []) as unknown[];
      const warnings = [...reminders];
      if (resolved.unlocatable.length > 0 && changesValues) {
        warnings.push(
          `${listOf([...new Set(resolved.unlocatable)])} name no range, so the check below does not cover ${
            resolved.unlocatable.length === 1 ? "it" : "them"
          }.`,
        );
      }

      const structured: Record<string, unknown> = {
        spreadsheet_id: spreadsheetId,
        dry_run: false,
        request_count: resolved.requests.length,
        plan: resolved.plan,
        touched: resolved.touched,
        sheets: resolved.sheets,
        replies: compactReplies(replies),
        check: check ?? null,
        warnings,
      };

      return ok(
        lines(
          `Applied ${count(resolved.requests.length, "request")} in one batchUpdate.`,
          ...resolved.plan.map(planLine),
          check ? `\n${describeCheck(check)}` : undefined,
          warnings.length ? `\nWorth knowing:\n${warnings.map((w) => `- ${w}`).join("\n")}` : undefined,
        ),
        structured,
        { maxResultSizeChars: 120_000 },
      );
    }),
  };
}

function planLine(entry: PlanEntry): string {
  const where = entry.targets.length ? ` on ${listOf(entry.targets)}` : "";
  return `  ${entry.index + 1}. ${entry.summary}${where} (${entry.type})`;
}

/**
 * The reminder that this tool skipped the named tools' checks, said once and
 * specifically. A generic "be careful" is noise; naming the sheet and who owns
 * it is not.
 */
function buildReminders(
  ctx: Awaited<ReturnType<ToolDeps["getContext"]>>,
  spreadsheetId: string,
  sheets: string[],
  types: string[],
): string[] {
  const out: string[] = [];
  const registry = ctx.registry;
  if (!registry) return out;

  const seen = new Set<string>();
  for (const sheet of sheets.length ? sheets : [undefined as unknown as string]) {
    const policy = registry.policyFor(spreadsheetId, sheet);
    if (!policy || policy.owner === "agent") continue;
    const key = `${policy.owner}:${policy.sheet ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const specifics: string[] = [];
    if (policy.writableColumns?.length) {
      specifics.push(`only ${policy.writableColumns.join(", ")} are ours to write`);
    }
    if (policy.positionalRows) specifics.push("rows here are referred to by position elsewhere");
    if (policy.colleagueSafeText) specifics.push("text here is read by colleagues");

    out.push(
      `${describeSheet(policy)} marks this spreadsheet as ${policy.owner}${
        specifics.length ? ` and says ${listOf(specifics)}` : ""
      }. sheets_batch enforces none of that: it skips the formula guard, the writable column limits, the protection for dropdowns set by hand, and the refusal to reorder positional rows. Use sheets_write, sheets_style or sheets_structure unless the request type genuinely has no tool.`,
    );
  }

  const rowMovers = types.filter((t) =>
    ["deleteDimension", "insertDimension", "moveDimension", "sortRange", "deleteDuplicates", "randomizeRange"].includes(
      t,
    ),
  );
  if (rowMovers.length && out.length) {
    out.push(
      `This batch includes ${listOf([...new Set(rowMovers)])}, which moves rows. sheets_structure would have refused that on a sheet marked positional_rows.`,
    );
  }
  return out;
}

/** Replies, trimmed to the ids and counts worth carrying back. */
function compactReplies(replies: unknown[]): Array<Record<string, unknown>> {
  return replies.flatMap((reply, index) => {
    if (!reply || typeof reply !== "object" || Object.keys(reply).length === 0) return [];
    const type = Object.keys(reply)[0];
    const body = (reply as Record<string, unknown>)[type];
    const entry: Record<string, unknown> = { index, type };
    if (body && typeof body === "object") {
      const flat = body as Record<string, unknown>;
      for (const key of Object.keys(flat)) {
        const value = flat[key];
        if (typeof value === "number" || typeof value === "string") entry[key] = value;
      }
      const properties = flat["properties"] as { sheetId?: number; title?: string } | undefined;
      if (properties) entry["sheet"] = { sheet_id: properties.sheetId, title: properties.title };
    }
    return [entry];
  });
}
