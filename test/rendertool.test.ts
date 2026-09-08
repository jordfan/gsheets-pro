/**
 * `sheets_render` end to end, with the network and poppler stood in for.
 *
 * What matters here is what the tool hands back and what it says, because both
 * change with the mode: a path locally, a signed URL hosted, and in either case
 * a sentence about the one thing the picture cannot show.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createRenderTool } from "../src/tools/render.js";
import { resetRenderMode, setRenderMode } from "../src/lib/rendermode.js";
import { errorOf } from "../src/lib/result.js";
import type { Context } from "../src/lib/client.js";
import { SheetCache } from "../src/lib/sheetcache.js";

const SPREADSHEET_ID = "1ReNdErToOlSpReAdShEeTiDaBcDeFgHiJkLmNoPq";

const PDF = Buffer.from("%PDF-1.4\n% a fixture, not a real document\n");

function pngBytes(width = 1600, height = 1100): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

let dir: string;
let requested: string[];

function makeContext(options: { driveExport?: () => Promise<unknown> } = {}): Context {
  return {
    auth: {
      client: { getAccessToken: async () => ({ token: "an-access-token" }) },
      source: "oauth_token_file",
      location: "test",
      scopes: [],
      hasRefreshToken: true,
    },
    sheets: {} as never,
    drive: {
      files: {
        export: options.driveExport ?? (async () => ({ data: PDF.buffer })),
      },
    } as never,
    cache: new SheetCache(async () => [
      {
        sheetId: 704,
        title: "Roster",
        index: 0,
        sheetType: "GRID",
        hidden: false,
        rowCount: 100,
        columnCount: 12,
        frozenRowCount: 1,
        frozenColumnCount: 0,
      },
    ]),
  } as unknown as Context;
}

function toolFor(context: Context, pages = 1) {
  requested = [];
  return createRenderTool(
    { getContext: async () => context },
    {
      fetchImpl: (async (url: string) => {
        requested.push(String(url));
        return new Response(PDF, { status: 200, headers: { "content-type": "application/pdf" } });
      }) as unknown as typeof fetch,
      runPdftoppm: async (_file, args) => {
        const prefix = args[args.length - 1];
        for (let page = 1; page <= pages; page += 1) {
          fs.writeFileSync(`${prefix}-${page}.png`, pngBytes());
        }
      },
    },
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsheets-render-tool-"));
  process.env.GSHEETS_PRO_RENDER_DIR = dir;
  resetRenderMode();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.GSHEETS_PRO_RENDER_DIR;
  delete process.env.GSHEETS_PRO_PUBLIC_URL;
  resetRenderMode();
});

describe("local mode", () => {
  test("returns a path that exists, and no URL", async () => {
    const tool = toolFor(makeContext());
    const response = await tool.handler({ spreadsheet_id: SPREADSHEET_ID, sheet: "Roster" });
    const body = response.structuredContent as Record<string, unknown>;

    expect(body.mode).toBe("local");
    const pages = body.pages as Array<Record<string, string>>;
    expect(pages).toHaveLength(1);
    expect(fs.existsSync(pages[0].path)).toBe(true);
    expect(pages[0].url).toBeUndefined();
    expect(response.content[0].text).toContain("Read the file at that path to look at it.");
  });

  test("the gid is explicit and the unused range parameters are absent", async () => {
    const tool = toolFor(makeContext());
    await tool.handler({ spreadsheet_id: SPREADSHEET_ID, sheet: "Roster" });
    const url = new URL(requested[0]);
    expect(url.searchParams.get("gid")).toBe("704");
    expect(url.searchParams.has("r1")).toBe(false);
  });

  test("a range reaches the URL as zero based, end exclusive numbers", async () => {
    const tool = toolFor(makeContext());
    await tool.handler({ spreadsheet_id: SPREADSHEET_ID, sheet: "Roster", range: "A1:H40" });
    const url = new URL(requested[0]);
    expect(url.searchParams.get("r1")).toBe("0");
    expect(url.searchParams.get("r2")).toBe("40");
    expect(url.searchParams.get("c2")).toBe("8");
  });

  test("the intermediate PDF is not left behind", async () => {
    const tool = toolFor(makeContext());
    await tool.handler({ spreadsheet_id: SPREADSHEET_ID, sheet: "Roster" });
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".pdf"))).toEqual([]);
  });

  test("every response says what a render cannot show", async () => {
    const tool = toolFor(makeContext());
    const response = await tool.handler({ spreadsheet_id: SPREADSHEET_ID, sheet: "Roster" });
    expect(response.content[0].text).toContain("No dropdown paints as a pill");
    expect(response.content[0].text).toContain("sheets_check is authoritative");
    expect((response.structuredContent as Record<string, unknown>).caveat).toContain("dropdowns");
  });

  test("a multi-page tab says so, and mentions the repeating header", async () => {
    const tool = toolFor(makeContext(), 3);
    const response = await tool.handler({ spreadsheet_id: SPREADSHEET_ID, sheet: "Roster" });
    const body = response.structuredContent as Record<string, unknown>;
    expect((body.pages as unknown[]).length).toBe(3);
    expect((body.warnings as string[]).join(" ")).toContain("frozen header repeats");
  });

  test("an unknown tab is a teaching error rather than a blank picture", async () => {
    const tool = toolFor(makeContext());
    const response = await tool.handler({ spreadsheet_id: SPREADSHEET_ID, sheet: "Nope" });
    expect(response.isError).toBe(true);
    expect(errorOf(response)?.code).toBe("sheet_not_found");
  });
});

describe("hosted mode", () => {
  test("returns a signed URL with an expiry, and no local path", async () => {
    setRenderMode("hosted", { dir });
    process.env.GSHEETS_PRO_PUBLIC_URL = "https://sheets.example.com";
    const tool = toolFor(makeContext());
    const response = await tool.handler({ spreadsheet_id: SPREADSHEET_ID, sheet: "Roster" });
    const body = response.structuredContent as Record<string, unknown>;
    const pages = body.pages as Array<Record<string, string>>;

    expect(body.mode).toBe("hosted");
    expect(pages[0].path).toBeUndefined();
    expect(pages[0].url).toMatch(/^https:\/\/sheets\.example\.com\/renders\/.+\?exp=\d+&sig=[0-9a-f]{64}$/);
    expect(Date.parse(pages[0].expires_at)).toBeGreaterThan(Date.now());
    expect(response.content[0].text).toContain("valid for 5 minutes");
  });

  test("a server that does not know its own address says so rather than lying", async () => {
    setRenderMode("hosted", { dir });
    const tool = toolFor(makeContext());
    const body = (await tool.handler({ spreadsheet_id: SPREADSHEET_ID, sheet: "Roster" }))
      .structuredContent as Record<string, unknown>;
    expect((body.warnings as string[]).join(" ")).toContain("GSHEETS_PRO_PUBLIC_URL");
  });
});

describe("the Drive fallback", () => {
  test("takes over when the export endpoint fails, and warns about what changes", async () => {
    const context = makeContext();
    const tool = createRenderTool(
      { getContext: async () => context },
      {
        fetchImpl: (async () =>
          new Response("<html>sign in</html>", {
            status: 401,
            headers: { "content-type": "text/html" },
          })) as unknown as typeof fetch,
        runPdftoppm: async (_file, args) => {
          fs.writeFileSync(`${args[args.length - 1]}-1.png`, pngBytes());
        },
      },
    );

    const response = await tool.handler({ spreadsheet_id: SPREADSHEET_ID, sheet: "Roster" });
    const body = response.structuredContent as Record<string, unknown>;
    expect(body.whole_workbook).toBe(true);
    const warning = (body.warnings as string[]).join(" ");
    expect(warning).toContain("whole workbook");
    expect(warning).toContain("gridlines");
  });

  test("when both fail, the original failure is what gets reported", async () => {
    const context = makeContext({
      driveExport: async () => {
        throw new Error("drive is unhappy too");
      },
    });
    const tool = createRenderTool(
      { getContext: async () => context },
      {
        fetchImpl: (async () =>
          new Response("<html>sign in</html>", {
            status: 401,
            headers: { "content-type": "text/html" },
          })) as unknown as typeof fetch,
      },
    );
    const response = await tool.handler({ spreadsheet_id: SPREADSHEET_ID, sheet: "Roster" });
    expect(response.isError).toBe(true);
    expect(errorOf(response)?.code).toBe("permission_denied");
    // The HTML body can carry the pre-signed redirect URL, so it never appears.
    expect(response.content[0].text).not.toContain("<html>");
  });
});

/**
 * The key the docs name has to be the key the tool emits.
 *
 * This is the defect the golden build hit: a caller looked for the files under
 * a key the tool does not use, read a successful render as an empty one, and
 * re-rendered five times. Nothing failed, so nothing caught it. These cases tie
 * the three places that can drift, the tool description, the prose, and
 * structuredContent, to one name.
 */
describe("the documented key is the emitted key", () => {
  const description = () =>
    createRenderTool({ getContext: async () => makeContext() }).config.description;

  test("structuredContent carries the files under pages, and nowhere else", async () => {
    const tool = toolFor(makeContext());
    const body = (await tool.handler({ spreadsheet_id: SPREADSHEET_ID, sheet: "Roster" }))
      .structuredContent as Record<string, unknown>;

    expect(Array.isArray(body.pages)).toBe(true);
    expect(body.outputs).toBeUndefined();
    expect(body.files).toBeUndefined();
    expect(body.images).toBeUndefined();
    expect(body.paths).toBeUndefined();
  });

  test("the description names pages, and names the field to read in each mode", () => {
    const text = description();
    expect(text).toContain("structuredContent.pages");
    expect(text).toContain("pages[0].path");
    expect(text).toContain("pages[0].url");
  });

  test("every key the description names is a key an entry actually has", async () => {
    const local = (await toolFor(makeContext()).handler({
      spreadsheet_id: SPREADSHEET_ID,
      sheet: "Roster",
    })).structuredContent as { pages: Array<Record<string, unknown>> };
    expect(local.pages[0]).toHaveProperty("path");

    setRenderMode("hosted", { dir });
    const hosted = (await toolFor(makeContext()).handler({
      spreadsheet_id: SPREADSHEET_ID,
      sheet: "Roster",
    })).structuredContent as { pages: Array<Record<string, unknown>> };
    expect(hosted.pages[0]).toHaveProperty("url");
  });

  test("the prose names the key beside the value, in both modes", async () => {
    const local = await toolFor(makeContext()).handler({
      spreadsheet_id: SPREADSHEET_ID,
      sheet: "Roster",
    });
    expect(local.content[0].text).toContain("pages[0].path:");

    setRenderMode("hosted", { dir });
    const hosted = await toolFor(makeContext()).handler({
      spreadsheet_id: SPREADSHEET_ID,
      sheet: "Roster",
    });
    expect(hosted.content[0].text).toContain("pages[0].url:");
  });

  test("a second page is named by its own index, not all as page zero", async () => {
    const body = (await toolFor(makeContext(), 2).handler({
      spreadsheet_id: SPREADSHEET_ID,
      sheet: "Roster",
    })) as { content: Array<{ text: string }> };
    expect(body.content[0].text).toContain("pages[0].path:");
    expect(body.content[0].text).toContain("pages[1].path:");
  });
});

/**
 * Notes render as endnotes, and the response has to say so.
 *
 * Spike 7: the export paints a cell note the way a printed document paints a
 * footnote, a bracketed marker on the cell and the note bodies as a numbered
 * list on a page after the grid. The plugin's own house style puts a note on
 * every Table header, so the best-documented sheets are exactly the ones this
 * happens to. A caller that keeps page one throws the documentation away and
 * nothing tells it, which is the failure these cases are here to prevent.
 */
describe("the extra page a noted tab renders", () => {
  test("a multi-page render explains the endnotes and says to keep the page", async () => {
    const tool = toolFor(makeContext(), 2);
    const response = await tool.handler({ spreadsheet_id: SPREADSHEET_ID, sheet: "Roster" });
    const warnings = ((response.structuredContent as Record<string, unknown>).warnings as string[]).join(" ");

    expect(warnings).toContain("cell notes");
    expect(warnings).toContain("endnotes");
    expect(warnings).toContain("numbered list");
    expect(warnings).toContain("Keep that page");
    // The markers are the thing most likely to be read as a defect in the
    // sheet, so the prose has to name them as references rather than content.
    expect(warnings).toContain("[1]");
    expect(warnings).toMatch(/references to that list rather than text/);
  });

  test("the same explanation reaches the prose a caller reads, not only structuredContent", async () => {
    const tool = toolFor(makeContext(), 2);
    const response = await tool.handler({ spreadsheet_id: SPREADSHEET_ID, sheet: "Roster" });
    expect(response.content[0].text).toContain("cell notes");
    expect(response.content[0].text).toContain("Keep that page");
  });

  test("a one-page render says nothing about notes", async () => {
    // There is no extra page to explain, and a caveat repeated where it does
    // not apply is how a caveat stops being read.
    const tool = toolFor(makeContext(), 1);
    const response = await tool.handler({ spreadsheet_id: SPREADSHEET_ID, sheet: "Roster" });
    const warnings = ((response.structuredContent as Record<string, unknown>).warnings as string[]).join(" ");
    expect(warnings).not.toContain("cell notes");
    expect(warnings).not.toContain("endnotes");
  });

  test("the claim is conditional, because a long tab without notes ends in more grid", async () => {
    const tool = toolFor(makeContext(), 3);
    const response = await tool.handler({ spreadsheet_id: SPREADSHEET_ID, sheet: "Roster" });
    const warnings = ((response.structuredContent as Record<string, unknown>).warnings as string[]).join(" ");
    expect(warnings).toContain("If this tab has cell notes");
    expect(warnings).not.toContain("The last page holds");
  });

  test("the description tells a caller to read every page and why", () => {
    const description = createRenderTool({ getContext: async () => makeContext() }).config.description;
    expect(description).toContain("Read every page");
    expect(description).toContain("notes");
    expect(description).toContain("pages[0]");
  });
});
