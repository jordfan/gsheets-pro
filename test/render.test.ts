/**
 * The render pipeline, offline.
 *
 * Nothing here touches Google or poppler. The URL builder, the PNG header
 * reader, the scale-down decision, the serialization and the signed URLs are
 * all pure or injectable, and every one of them is somewhere the tool could go
 * quietly wrong: an empty range parameter that returns 400, a signature that
 * compares in variable time, a render that hands back a path to a container
 * nobody can reach.
 */

import { describe, expect, test, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  exportUrl,
  pdfToPng,
  readPngSize,
  renderFileName,
  serializeRender,
  PDFTOPPM_HINT,
} from "../src/lib/render.js";
import {
  RENDER_NAME_PATTERN,
  renderSecret,
  resetRenderSecret,
  signRender,
  signRenderPath,
  verifyRenderRequest,
} from "../src/lib/rendersign.js";
import { renderDir, renderMode, renderPublicUrl, resetRenderMode, setRenderMode } from "../src/lib/rendermode.js";
import { rangeParams, RENDER_CAVEAT } from "../src/tools/render.js";
import { GsheetsError } from "../src/lib/errors.js";

const SPREADSHEET = "1ReNdErFiXtUrEsPrEaDsHeEtIdAbCdEfGhIjKlMn";

describe("the export URL", () => {
  test("always sends an explicit gid", () => {
    const url = new URL(exportUrl(SPREADSHEET, { gid: 0 }));
    expect(url.searchParams.get("gid")).toBe("0");
  });

  test("omits the range parameters rather than sending them empty", () => {
    // The plan's template sent &r1=&c1=&r2=&c2= and the endpoint answers 400
    // with an HTML error page. An empty string is not the same as unset here.
    const url = new URL(exportUrl(SPREADSHEET, { gid: 42 }));
    for (const key of ["r1", "c1", "r2", "c2"]) {
      expect(url.searchParams.has(key)).toBe(false);
    }
    expect(url.toString()).not.toContain("r1=&");
  });

  test("carries the range when there is one", () => {
    const url = new URL(exportUrl(SPREADSHEET, { gid: 42, r1: 0, c1: 0, r2: 40, c2: 8 }));
    expect(url.searchParams.get("r1")).toBe("0");
    expect(url.searchParams.get("c2")).toBe("8");
  });

  test("keeps the settings spike 1 verified: frozen rows repeat, no gridlines", () => {
    const url = new URL(exportUrl(SPREADSHEET, { gid: 1 }));
    expect(url.searchParams.get("fzr")).toBe("true");
    expect(url.searchParams.get("gridlines")).toBe("false");
    expect(url.searchParams.get("fitw")).toBe("true");
    expect(url.searchParams.get("format")).toBe("pdf");
  });

  test("a zero row index is sent, not treated as absent", () => {
    const params = rangeParams("A1:H40");
    expect(params).toEqual({ r1: 0, c1: 0, r2: 40, c2: 8 });
  });

  test("an open ended range leaves the axis it does not name alone", () => {
    expect(rangeParams("B:D")).toEqual({ c1: 1, c2: 4 });
  });

  test("a range that will not parse is a teaching error", () => {
    expect(() => rangeParams("not a range")).toThrow(GsheetsError);
  });
});

describe("PNG measurement and the pixel cap", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsheets-render-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A PNG header carrying the dimensions we want, which is all we read. */
  function fakePng(width: number, height: number): Buffer {
    const bytes = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    bytes.write("IHDR", 12, "latin1");
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes;
  }

  test("dimensions come out of the IHDR chunk", () => {
    expect(readPngSize(fakePng(1200, 800))).toEqual({ width: 1200, height: 800 });
  });

  test("something that is not a PNG measures as nothing", () => {
    expect(readPngSize(Buffer.from("%PDF-1.4 and then some"))).toBeUndefined();
  });

  test("a normal page is converted once, at the dpi asked for", async () => {
    const runs: string[][] = [];
    const prefix = path.join(dir, "roster");
    const result = await pdfToPng(`${prefix}.pdf`, prefix, {
      run: async (_file, args) => {
        runs.push(args);
        fs.writeFileSync(`${prefix}-1.png`, fakePng(1600, 1100));
      },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain("120");
    expect(result.paths).toEqual([`${prefix}-1.png`]);
    expect(result.size).toEqual({ width: 1600, height: 1100 });
    expect(result.scaledTo).toBeUndefined();
  });

  test("a page over the pixel cap is re-rendered scaled down", async () => {
    const runs: string[][] = [];
    const prefix = path.join(dir, "wide");
    let call = 0;
    const result = await pdfToPng(`${prefix}.pdf`, prefix, {
      maxEdge: 2000,
      run: async (_file, args) => {
        runs.push(args);
        call += 1;
        fs.writeFileSync(`${prefix}-1.png`, call === 1 ? fakePng(9000, 400) : fakePng(2000, 89));
      },
    });
    expect(runs).toHaveLength(2);
    expect(runs[1]).toContain("-scale-to");
    expect(result.scaledTo).toBe(2000);
    expect(result.size).toEqual({ width: 2000, height: 89 });
  });

  test("multiple pages come back in page order, not readdir order", async () => {
    const prefix = path.join(dir, "long");
    const result = await pdfToPng(`${prefix}.pdf`, prefix, {
      run: async () => {
        for (const page of [10, 2, 1]) {
          fs.writeFileSync(`${prefix}-${page}.png`, fakePng(800, 600));
        }
      },
    });
    expect(result.paths.map((p) => path.basename(p))).toEqual(["long-1.png", "long-2.png", "long-10.png"]);
  });

  test("a missing pdftoppm says how to install it", async () => {
    const prefix = path.join(dir, "nope");
    await expect(
      pdfToPng(`${prefix}.pdf`, prefix, {
        run: async () => {
          const error = new Error("spawn pdftoppm ENOENT") as Error & { code: string };
          error.code = "ENOENT";
          throw error;
        },
      }),
    ).rejects.toThrow(/not installed/);

    expect(PDFTOPPM_HINT).toContain("brew install poppler");
    expect(PDFTOPPM_HINT).toContain("apt install poppler-utils");
  });

  test("a conversion that produces nothing says so rather than returning an empty list", async () => {
    const prefix = path.join(dir, "empty");
    await expect(pdfToPng(`${prefix}.pdf`, prefix, { run: async () => {} })).rejects.toThrow(/no images/);
  });
});

describe("serialization", () => {
  test("renders run one at a time even when asked for together", async () => {
    const order: string[] = [];
    const work = (name: string) => async () => {
      order.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(`${name}:end`);
      return name;
    };
    await Promise.all([serializeRender(work("a")), serializeRender(work("b"))]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  test("one render failing does not wedge the queue", async () => {
    await expect(
      serializeRender(async () => {
        throw new Error("poppler fell over");
      }),
    ).rejects.toThrow("poppler fell over");
    await expect(serializeRender(async () => "fine")).resolves.toBe("fine");
  });
});

describe("signed render URLs", () => {
  const secret = "a-test-secret";

  test("a freshly signed URL verifies", () => {
    const signed = signRenderPath("roster-abc.png", { secret });
    const url = new URL(`http://host${signed.path}`);
    const verdict = verifyRenderRequest("roster-abc.png", {
      exp: url.searchParams.get("exp"),
      sig: url.searchParams.get("sig"),
    }, { secret });
    expect(verdict).toEqual({ ok: true, name: "roster-abc.png" });
  });

  test("an expired token is refused", () => {
    const signed = signRenderPath("roster-abc.png", { secret, ttlMs: -1000 });
    expect(
      verifyRenderRequest("roster-abc.png", { exp: String(signed.expiresAt), sig: signed.signature }, { secret }),
    ).toEqual({ ok: false, reason: "expired" });
  });

  test("a signature for a different file is refused", () => {
    const expiresAt = Date.now() + 60_000;
    const sig = signRender("other.png", expiresAt, secret);
    expect(
      verifyRenderRequest("roster-abc.png", { exp: String(expiresAt), sig }, { secret }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("a signature for a different expiry is refused", () => {
    const expiresAt = Date.now() + 60_000;
    const sig = signRender("roster-abc.png", expiresAt, secret);
    expect(
      verifyRenderRequest("roster-abc.png", { exp: String(expiresAt + 1), sig }, { secret }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("a signature minted with a different secret is refused", () => {
    const expiresAt = Date.now() + 60_000;
    const sig = signRender("roster-abc.png", expiresAt, "someone-elses-secret");
    expect(
      verifyRenderRequest("roster-abc.png", { exp: String(expiresAt), sig }, { secret }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("no token at all is refused", () => {
    expect(verifyRenderRequest("roster-abc.png", { exp: null, sig: null }, { secret })).toEqual({
      ok: false,
      reason: "missing_token",
    });
  });

  test("a name that walks out of the directory is refused before anything is read", () => {
    for (const name of ["../token.json", "..%2Ftoken.json", "sub/dir.png", "roster.txt", ""]) {
      const verdict = verifyRenderRequest(name, { exp: String(Date.now() + 1000), sig: "x" }, { secret });
      expect(verdict.ok).toBe(false);
    }
  });

  test("the name pattern accepts what the tool actually generates", () => {
    expect(RENDER_NAME_PATTERN.test(`${renderFileName("Background Check Tracker")}-1.png`)).toBe(true);
    expect(RENDER_NAME_PATTERN.test(`${renderFileName("2026-27 Academic Year")}-1.png`)).toBe(true);
  });

  test("the secret prefers the configured value, then the bearer", () => {
    resetRenderSecret();
    expect(renderSecret({ GSHEETS_PRO_RENDER_SECRET: "configured", GSHEETS_PRO_TOKEN: "bearer" } as never)).toBe(
      "configured",
    );
    expect(renderSecret({ GSHEETS_PRO_TOKEN: "bearer" } as never)).toBe("bearer");
    const first = renderSecret({} as never);
    expect(first).toHaveLength(64);
    expect(renderSecret({} as never)).toBe(first);
  });
});

describe("where a render goes", () => {
  afterEach(() => {
    resetRenderMode();
    delete process.env.GSHEETS_PRO_RENDER_MODE;
    delete process.env.GSHEETS_PRO_RENDER_DIR;
    delete process.env.GSHEETS_PRO_PUBLIC_URL;
  });

  test("local unless a transport says otherwise", () => {
    resetRenderMode();
    expect(renderMode({} as never)).toBe("local");
    setRenderMode("hosted");
    expect(renderMode({} as never)).toBe("hosted");
  });

  test("the environment overrides the transport, for a stdio server behind a proxy", () => {
    setRenderMode("hosted");
    expect(renderMode({ GSHEETS_PRO_RENDER_MODE: "local" } as never)).toBe("local");
  });

  test("the directory is created rather than assumed", () => {
    const dir = path.join(os.tmpdir(), `gsheets-render-dir-${Date.now()}`);
    process.env.GSHEETS_PRO_RENDER_DIR = dir;
    expect(renderDir()).toBe(dir);
    expect(fs.existsSync(dir)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a public URL loses its trailing slash so the path can be appended", () => {
    process.env.GSHEETS_PRO_PUBLIC_URL = "https://sheets.example.com/";
    expect(renderPublicUrl()).toBe("https://sheets.example.com");
  });
});

describe("what the response always says", () => {
  test("the caveat names dropdowns and points at the lint", () => {
    expect(RENDER_CAVEAT).toContain("No dropdown paints as a pill");
    expect(RENDER_CAVEAT).toContain("coloured by hand");
    expect(RENDER_CAVEAT).toContain("sheets_check is authoritative");
  });

  test("a file name is safe to sign and readable to a person", () => {
    expect(renderFileName("Background Check Tracker", 0)).toMatch(/^background-check-tracker-0$/);
    expect(renderFileName("  ", 0)).toBe("sheet-0");
  });
});
