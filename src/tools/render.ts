/**
 * `sheets_render`: look at the sheet.
 *
 * The lint can tell you a formula is broken. It cannot tell you the guardian
 * email column is forty pixels too narrow, that a status fill is unreadable
 * against its own text, or that a row wrapped to three lines and made the table
 * look like a mistake. Those are the things a person notices in half a second
 * and a model never notices at all, unless it is handed the picture.
 *
 * The response is a file path locally and a short lived signed URL when hosted.
 * Never image bytes: MCP image content blocks are mishandled by Claude Code, so
 * a render that returned them would be a render nobody could see.
 *
 * Every response says the same thing about what a picture cannot show. No
 * dropdown paints as a pill, and one the API created is plain black text that
 * looks exactly like a cell with no rule at all, so a bare-looking cell is not
 * evidence that a validation rule is missing and `sheets_check` is the
 * authority on that. The near miss is worth knowing and is in the caveat too: a
 * rule somebody coloured by hand does paint as coloured text, which makes a
 * render the only way to see that those colours are still there.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { parseA1 } from "../lib/a1.js";
import { withRetry } from "../lib/batch.js";
import { err, GsheetsError } from "../lib/errors.js";
import {
  DEFAULT_DPI,
  exportUrl,
  fetchExportPdf,
  pdfToPng,
  renderFileName,
  serializeRender,
  type ExportUrlOptions,
} from "../lib/render.js";
import { renderDir, renderMode, renderPublicUrl } from "../lib/rendermode.js";
import { RENDER_URL_TTL_MS, signRenderPath } from "../lib/rendersign.js";
import { count, guarded, lines, ok, type ToolResponse } from "../lib/result.js";
import type { ToolDefinition, ToolDeps } from "./types.js";

/** What a render can never show, said the same way every time. */
export const RENDER_CAVEAT =
  "No dropdown paints as a pill. A rule the API created shows as plain black text, indistinguishable from a cell carrying no rule at all, so a bare-looking cell here is not evidence that a rule is missing and sheets_check is authoritative for validation state. The one thing the image does show is colour: a rule somebody coloured by hand in the Sheets UI paints as coloured text, so a column of dropdowns that has gone plain black has lost those colours, which no API call can put back. Everything else in the image is trustworthy: fills, fonts, borders, banding, merges, column widths, and conditional formats all paint, and the frozen header repeats on every page.";

export const renderInputSchema = {
  spreadsheet_id: z.string().describe("The spreadsheet id, the long id in the middle of the sheet's URL."),
  sheet: z.string().describe("The tab to render. One tab per call."),
  range: z
    .string()
    .optional()
    .describe("A1 range within the tab, for example A1:H40. The whole tab when omitted."),
  dpi: z
    .number()
    .int()
    .min(72)
    .max(200)
    .optional()
    .describe(`Resolution. Default ${DEFAULT_DPI}, which reads comfortably. Higher costs size for little gain.`),
  gridlines: z.boolean().optional().describe("Draw the sheet's gridlines. Default false, as in a printed copy."),
  portrait: z.boolean().optional().describe("Portrait rather than landscape. Default false."),
  max_pages: z
    .number()
    .int()
    .min(1)
    .max(8)
    .optional()
    .describe("How many pages of a long tab to convert. Default 8. Page 1 is usually all you need."),
};

type RenderArgs = {
  spreadsheet_id: string;
  sheet: string;
  range?: string;
  dpi?: number;
  gridlines?: boolean;
  portrait?: boolean;
  max_pages?: number;
};

const DESCRIPTION = [
  "Render one tab, or a range of it, to a PNG. Read the image and look at it.",
  "",
  "The files come back in structuredContent.pages, one entry per page of a long tab. Locally each entry has a path: read pages[0].path. When this server is hosted each entry has a url instead, valid for five minutes: fetch pages[0].url. There is no other key; a render that seems to have produced no file is a caller reading the wrong one.",
  "",
  "Read every page, not just the first. A tab whose cells carry notes renders one extra page holding those notes as a numbered list, with bracketed markers in the grid pointing at it, so keeping only pages[0] silently throws away the sheet's documentation.",
  "",
  "Use it once after a build and again after fixing what you saw. It is the only way to catch a column too narrow to read, a cell showing ###, an unreadable colour, or a row that wrapped to three lines.",
  "",
  "No dropdown paints as a pill in a render, so a bare-looking cell is not evidence that a rule is missing. sheets_check is authoritative for validation state.",
].join("\n");

export interface RenderToolOptions {
  /** Injectable for tests, so the pipeline can be exercised without Google. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests, so the pipeline can be exercised without poppler. */
  runPdftoppm?: (file: string, args: string[]) => Promise<void>;
}

export function createRenderTool(
  deps: ToolDeps,
  toolOptions: RenderToolOptions = {},
): ToolDefinition<typeof renderInputSchema> {
  return {
    name: "sheets_render",
    config: {
      title: "Render a tab to PNG",
      description: DESCRIPTION,
      inputSchema: renderInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler: guarded(async (raw: Record<string, unknown>): Promise<ToolResponse> => {
      const args = raw as RenderArgs;
      const ctx = await deps.getContext();
      const spreadsheetId = args.spreadsheet_id;
      const info = await ctx.cache.resolve(spreadsheetId, args.sheet);

      const options: ExportUrlOptions = { gid: info.sheetId };
      if (args.gridlines !== undefined) options.gridlines = args.gridlines;
      if (args.portrait !== undefined) options.portrait = args.portrait;
      if (args.range) Object.assign(options, rangeParams(args.range));

      const dir = renderDir();
      const base = renderFileName(info.title);
      const prefix = path.join(dir, base);
      const pdfPath = `${prefix}.pdf`;

      return serializeRender(async () => {
        const warnings: string[] = [];
        let bytes: Buffer;
        let wholeWorkbook = false;

        try {
          const token = await accessToken(ctx);
          bytes = (
            await fetchExportPdf(
              exportUrl(spreadsheetId, options),
              token,
              toolOptions.fetchImpl ?? fetch,
            )
          ).bytes;
        } catch (error) {
          // The export endpoint is undocumented. Drive's export is documented,
          // works with the same credential, and renders the whole workbook with
          // gridlines and no range control, which is worth saying out loud.
          const why = error instanceof GsheetsError ? error.message : String(error);
          const fallback = await driveExport(ctx, spreadsheetId).catch(() => undefined);
          if (!fallback) throw error;
          bytes = fallback;
          wholeWorkbook = true;
          warnings.push(
            `The export endpoint did not answer (${why}), so this is Drive's own export: the whole workbook, every tab, with gridlines, and no way to honour ${args.range ? "the range or " : ""}the page settings. Page 1 is whichever tab comes first, not necessarily ${info.title}.`,
          );
        }

        fs.writeFileSync(pdfPath, bytes);

        const conversion = await pdfToPng(pdfPath, prefix, {
          dpi: args.dpi ?? DEFAULT_DPI,
          maxPages: args.max_pages ?? 8,
          ...(toolOptions.runPdftoppm ? { run: toolOptions.runPdftoppm } : {}),
        });
        fs.rmSync(pdfPath, { force: true });

        if (conversion.scaledTo) {
          warnings.push(
            `The page was wider than ${conversion.scaledTo} pixels, so it was scaled down to fit. Small text may be soft. Render a range instead of the whole tab to read it at full size.`,
          );
        }
        if (conversion.paths.length > 1) {
          warnings.push(
            `This render is ${count(conversion.paths.length, "page")}. The frozen header repeats on each page of grid.`,
          );
          // Spike 7: the export renders a cell note the way a printed document
          // renders a footnote. The tool cannot tell whether this tab has notes
          // without spending another read, so the sentence is conditional
          // rather than asserted. Getting it wrong in the confident direction
          // would be worse: a long tab with no notes really does end in more
          // grid, and telling a caller otherwise sends them looking for a page
          // that is not there.
          warnings.push(
            `If this tab has cell notes, the last page is not more grid. Notes render as endnotes: the note bodies are printed there as a numbered list, and the bracketed markers in the grid, "Instructor [1]", are references to that list rather than text anybody typed into the cell. Keep that page. It is the sheet's own documentation, and dropping it is how a well-documented sheet comes back looking undocumented.`,
          );
        }

        const hosted = renderMode() === "hosted";
        const outputs = conversion.paths.map((file, index) => {
          const name = path.basename(file);
          const entry: Record<string, unknown> = { page: index + 1, file: name };
          if (hosted) {
            const signed = signRenderPath(name);
            const origin = renderPublicUrl();
            entry.url = origin ? `${origin}${signed.path}` : signed.path;
            entry.expires_at = new Date(signed.expiresAt).toISOString();
          } else {
            entry.path = file;
          }
          return entry;
        });

        if (hosted && !renderPublicUrl()) {
          warnings.push(
            "This server does not know its own public address, so the URLs are paths rather than absolute. Set GSHEETS_PRO_PUBLIC_URL on the host to fix it.",
          );
        }

        const structured: Record<string, unknown> = {
          spreadsheet_id: spreadsheetId,
          sheet: info.title,
          range: args.range ?? null,
          mode: hosted ? "hosted" : "local",
          dpi: args.dpi ?? DEFAULT_DPI,
          pages: outputs,
          whole_workbook: wholeWorkbook,
          size: conversion.size ?? null,
          expires_in_seconds: hosted ? Math.round(RENDER_URL_TTL_MS / 1000) : null,
          warnings,
          caveat: RENDER_CAVEAT,
        };

        // The prose names the key as well as printing the value. A caller that
        // reads the text still has to reach into structuredContent to act, and
        // guessing which field holds the file is what produced a run of renders
        // that all "succeeded" and handed back nothing anybody could open.
        const where = hosted
          ? outputs.map((o) => `  pages[${o.page as number - 1}].url: ${o.url}`).join("\n")
          : outputs.map((o) => `  pages[${o.page as number - 1}].path: ${o.path}`).join("\n");

        return ok(
          lines(
            `Rendered ${info.title}${args.range ? `!${args.range}` : ""} at ${args.dpi ?? DEFAULT_DPI} dpi, ${count(outputs.length, "page")}.`,
            where,
            hosted
              ? `\nThe links are valid for ${Math.round(RENDER_URL_TTL_MS / 60000)} minutes. Fetch them now rather than later.`
              : "\nRead the file at that path to look at it.",
            warnings.length ? `\nWorth knowing:\n${warnings.map((w) => `- ${w}`).join("\n")}` : undefined,
            `\n${RENDER_CAVEAT}`,
          ),
          structured,
        );
      });
    }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A1 to the export URL's zero based, end exclusive range parameters. */
export function rangeParams(range: string): Pick<ExportUrlOptions, "r1" | "c1" | "r2" | "c2"> {
  let bounds;
  try {
    bounds = parseA1(range);
  } catch (error) {
    throw err.badRange(range, (error as Error).message);
  }
  const out: Pick<ExportUrlOptions, "r1" | "c1" | "r2" | "c2"> = {};
  if (bounds.startRowIndex !== undefined) out.r1 = bounds.startRowIndex;
  if (bounds.startColumnIndex !== undefined) out.c1 = bounds.startColumnIndex;
  if (bounds.endRowIndex !== undefined) out.r2 = bounds.endRowIndex;
  if (bounds.endColumnIndex !== undefined) out.c2 = bounds.endColumnIndex;
  return out;
}

/** A raw bearer, which the export endpoint needs and the API clients hide. */
async function accessToken(ctx: Awaited<ReturnType<ToolDeps["getContext"]>>): Promise<string> {
  const client = ctx.auth.client as {
    getAccessToken?: () => Promise<string | null | { token?: string | null }>;
  };
  if (typeof client.getAccessToken !== "function") {
    throw err.authMissing("This credential cannot mint an access token for the export endpoint.");
  }
  const result = await client.getAccessToken();
  const token = typeof result === "string" ? result : (result?.token ?? undefined);
  if (!token) {
    throw err.authMissing(
      "The credential did not return an access token.",
      "Run `gsheets-pro doctor` to see which credential is in use, then `gsheets-pro auth` to sign in again.",
    );
  }
  return token;
}

/** Drive's documented export. The whole workbook, and nothing to tune. */
async function driveExport(
  ctx: Awaited<ReturnType<ToolDeps["getContext"]>>,
  spreadsheetId: string,
): Promise<Buffer> {
  const response = await withRetry(() =>
    ctx.drive.files.export(
      { fileId: spreadsheetId, mimeType: "application/pdf" },
      { responseType: "arraybuffer" },
    ),
  );
  return Buffer.from(response.data as ArrayBuffer);
}
