/**
 * Turning a tab into a picture.
 *
 * Google has no API for this. What it has is the undocumented endpoint the
 * File > Download > PDF menu item uses, and spike 1 established that the
 * picture it produces tells the truth: at 120 dpi it paints merged titles,
 * header fills, banding, conditional formats including font-only rules, and
 * real column widths, and `fzr=true` repeats the frozen header on every page.
 *
 * Three things about the URL are worth knowing before touching it.
 *
 * The five range parameters must be omitted when unused, not sent empty. The
 * plan's template sent `&gid=&r1=&c1=&r2=&c2=` and the endpoint answers 400
 * with an HTML error page, so an empty string is not the same as unset here.
 *
 * `gid` is always sent explicitly. Leaving it off is the whole-workbook render,
 * which is a different picture than the first tab and never the one asked for.
 *
 * The redirect needs no special handling. Google answers with a 307 to
 * googleusercontent.com and the plan assumed the bearer had to be re-attached
 * by hand. It does not: the redirect target is pre-signed and carries its own
 * credential, so a plain authorized fetch following redirects is enough. That
 * pre-signed URL is a bearer-equivalent capability, and it is never logged,
 * returned, or written anywhere.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { GsheetsError } from "./errors.js";

const execFileAsync = promisify(execFile);

/** Renders are serialized, so a small host is never converting two at once. */
let renderQueue: Promise<unknown> = Promise.resolve();

/** The default resolution. Spike 1 read text comfortably at this. */
export const DEFAULT_DPI = 120;
/** Refuse a PDF larger than this rather than converting it. */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
/** The longest edge a PNG may have. Beyond it the page is scaled down. */
export const MAX_PNG_EDGE = 4000;
/** How many pages of a long tab are converted. */
export const MAX_PAGES = 8;

export interface ExportUrlOptions {
  /** Always sent. Omitting it renders the whole workbook, which is a different picture. */
  gid: number;
  /** Zero based, end exclusive, all four or none. */
  r1?: number;
  c1?: number;
  r2?: number;
  c2?: number;
  gridlines?: boolean;
  fitw?: boolean;
  portrait?: boolean;
  /** Repeat the frozen rows on every page. */
  fzr?: boolean;
  /** Paper size. 0 is letter. */
  size?: number | string;
}

/** Build the export URL, omitting the range parameters that are not in use. */
export function exportUrl(spreadsheetId: string, options: ExportUrlOptions): string {
  const params = new URLSearchParams({
    format: "pdf",
    gridlines: String(options.gridlines ?? false),
    fitw: String(options.fitw ?? true),
    size: String(options.size ?? 0),
    portrait: String(options.portrait ?? false),
    fzr: String(options.fzr ?? true),
    gid: String(options.gid),
  });
  for (const key of ["r1", "c1", "r2", "c2"] as const) {
    const value = options[key];
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?${params.toString()}`;
}

export interface FetchPdfResult {
  bytes: Buffer;
  contentType?: string;
}

/**
 * Fetch the PDF with a bearer, following redirects normally.
 *
 * A response that is not a PDF is almost always an HTML sign-in or error page,
 * and its body must not reach the caller: it can carry the pre-signed redirect
 * URL. So the error says the status and the content type and nothing else.
 */
export async function fetchExportPdf(
  url: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchPdfResult> {
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const contentType = response.headers.get("content-type") ?? undefined;
  const bytes = Buffer.from(await response.arrayBuffer());

  if (!response.ok) {
    throw new GsheetsError(
      response.status === 401 || response.status === 403 ? "permission_denied" : "unavailable",
      `The export endpoint answered ${response.status}${contentType ? ` with ${contentType}` : ""}.`,
      response.status === 401 || response.status === 403
        ? "The token cannot read this spreadsheet through the export endpoint. Run `gsheets-pro doctor` to see which credential is in use, and check that the account has at least view access."
        : "This endpoint is undocumented and occasionally unavailable. Try again, or fall back to reading the sheet with sheets_read.",
    );
  }
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new GsheetsError(
      "unavailable",
      `The export endpoint returned ${contentType ?? "something"} rather than a PDF (${bytes.length} bytes).`,
      "This is usually a sign-in page, which means the credential was not accepted. Run `gsheets-pro doctor`.",
    );
  }
  if (bytes.length > MAX_PDF_BYTES) {
    throw new GsheetsError(
      "result_too_large",
      `The rendered PDF is ${Math.round(bytes.length / 1024 / 1024)} MB, over the ${Math.round(MAX_PDF_BYTES / 1024 / 1024)} MB cap.`,
      "Render one tab at a time, or pass a range covering the part worth looking at.",
    );
  }
  return contentType ? { bytes, contentType } : { bytes };
}

// ---------------------------------------------------------------------------
// PDF to PNG
// ---------------------------------------------------------------------------

export interface PngSize {
  width: number;
  height: number;
}

/**
 * Read a PNG's dimensions out of its header.
 *
 * IHDR is the first chunk and its width and height are big-endian 32 bit
 * integers at bytes 16 and 20. Reading them costs 24 bytes and saves shelling
 * out to a second poppler binary just to find out whether a page is enormous.
 */
export function readPngSize(bytes: Buffer): PngSize | undefined {
  if (bytes.length < 24) return undefined;
  if (bytes.subarray(1, 4).toString("latin1") !== "PNG") return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export interface PdftoppmOptions {
  dpi?: number;
  maxPages?: number;
  /** Longest edge in pixels. A page over it is re-rendered scaled down. */
  maxEdge?: number;
  /** Injectable for tests. */
  run?: (file: string, args: string[]) => Promise<void>;
  binary?: string;
}

export interface PdfToPngResult {
  paths: string[];
  size?: PngSize;
  /** Set when the page was re-rendered smaller than the requested dpi. */
  scaledTo?: number;
}

/** The install line, which is the only useful thing to say when it is missing. */
export const PDFTOPPM_HINT =
  "Rendering needs pdftoppm from poppler. Install it with `brew install poppler` on macOS or `apt install poppler-utils` on Debian and Ubuntu. Everything except sheets_render works without it.";

export function pdftoppmBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.GSHEETS_PRO_PDFTOPPM?.trim() || "pdftoppm";
}

/** Is poppler here? Cheap enough to ask before writing a PDF to disk. */
export async function hasPdftoppm(
  binary = pdftoppmBinary(),
  run: (file: string, args: string[]) => Promise<void> = defaultRun,
): Promise<boolean> {
  try {
    await run(binary, ["-v"]);
    return true;
  } catch {
    return false;
  }
}

async function defaultRun(file: string, args: string[]): Promise<void> {
  await execFileAsync(file, args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
}

/**
 * Convert a PDF on disk to PNGs beside it, capped in pages and in pixels.
 *
 * The pixel cap is applied by measuring the first page and, when it is over,
 * re-running with `-scale-to`. Measuring first rather than scaling always keeps
 * a normal tab at its requested resolution, which is what makes small text
 * legible, and only a genuinely huge sheet pays for the second pass.
 */
export async function pdfToPng(
  pdfPath: string,
  prefix: string,
  options: PdftoppmOptions = {},
): Promise<PdfToPngResult> {
  const run = options.run ?? defaultRun;
  const binary = options.binary ?? pdftoppmBinary();
  const dpi = options.dpi ?? DEFAULT_DPI;
  const maxPages = options.maxPages ?? MAX_PAGES;
  const maxEdge = options.maxEdge ?? MAX_PNG_EDGE;

  const convert = async (args: string[]): Promise<string[]> => {
    try {
      await run(binary, args);
    } catch (error) {
      const message = (error as { code?: string; message?: string }).code === "ENOENT"
        ? "pdftoppm is not installed, or is not on this server's PATH."
        : `pdftoppm failed: ${(error as Error).message}`;
      throw new GsheetsError("unavailable", message, PDFTOPPM_HINT);
    }
    return listPages(prefix);
  };

  let paths = await convert(["-png", "-r", String(dpi), "-f", "1", "-l", String(maxPages), pdfPath, prefix]);
  if (paths.length === 0) {
    throw new GsheetsError(
      "unavailable",
      "pdftoppm produced no images from the exported PDF.",
      "The PDF may be empty, which happens when the tab has no content in the range asked for.",
    );
  }

  let size = readPngSize(fs.readFileSync(paths[0]));
  let scaledTo: number | undefined;
  if (size && Math.max(size.width, size.height) > maxEdge) {
    for (const stale of paths) fs.rmSync(stale, { force: true });
    paths = await convert([
      "-png",
      "-scale-to",
      String(maxEdge),
      "-f",
      "1",
      "-l",
      String(maxPages),
      pdfPath,
      prefix,
    ]);
    scaledTo = maxEdge;
    size = paths[0] ? readPngSize(fs.readFileSync(paths[0])) : undefined;
  }

  const result: PdfToPngResult = { paths };
  if (size) result.size = size;
  if (scaledTo) result.scaledTo = scaledTo;
  return result;
}

/** pdftoppm writes prefix-1.png, prefix-2.png, and pads for long documents. */
function listPages(prefix: string): string[] {
  const dir = path.dirname(prefix);
  const base = path.basename(prefix);
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.startsWith(`${base}-`) && name.endsWith(".png"))
    .sort((a, b) => pageNumber(a, base) - pageNumber(b, base))
    .map((name) => path.join(dir, name));
}

function pageNumber(name: string, base: string): number {
  const match = new RegExp(`^${escapeRegExp(base)}-(\\d+)\\.png$`).exec(name);
  return match ? Number(match[1]) : 0;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Run one render at a time. A small host converting two PDFs at once swaps. */
export function serializeRender<T>(work: () => Promise<T>): Promise<T> {
  const next = renderQueue.then(work, work);
  // Keep the chain alive whatever happens to this render.
  renderQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** A file name that is safe to sign, serve, and paste. */
export function renderFileName(sheetTitle: string, at = Date.now()): string {
  const slug =
    sheetTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "sheet";
  return `${slug}-${at.toString(36)}`;
}
