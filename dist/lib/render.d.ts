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
/** The default resolution. Spike 1 read text comfortably at this. */
export declare const DEFAULT_DPI = 120;
/** Refuse a PDF larger than this rather than converting it. */
export declare const MAX_PDF_BYTES: number;
/** The longest edge a PNG may have. Beyond it the page is scaled down. */
export declare const MAX_PNG_EDGE = 4000;
/** How many pages of a long tab are converted. */
export declare const MAX_PAGES = 8;
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
export declare function exportUrl(spreadsheetId: string, options: ExportUrlOptions): string;
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
export declare function fetchExportPdf(url: string, accessToken: string, fetchImpl?: typeof fetch): Promise<FetchPdfResult>;
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
export declare function readPngSize(bytes: Buffer): PngSize | undefined;
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
export declare const PDFTOPPM_HINT = "Rendering needs pdftoppm from poppler. Install it with `brew install poppler` on macOS or `apt install poppler-utils` on Debian and Ubuntu. Everything except sheets_render works without it.";
export declare function pdftoppmBinary(env?: NodeJS.ProcessEnv): string;
/** Is poppler here? Cheap enough to ask before writing a PDF to disk. */
export declare function hasPdftoppm(binary?: string, run?: (file: string, args: string[]) => Promise<void>): Promise<boolean>;
/**
 * Convert a PDF on disk to PNGs beside it, capped in pages and in pixels.
 *
 * The pixel cap is applied by measuring the first page and, when it is over,
 * re-running with `-scale-to`. Measuring first rather than scaling always keeps
 * a normal tab at its requested resolution, which is what makes small text
 * legible, and only a genuinely huge sheet pays for the second pass.
 */
export declare function pdfToPng(pdfPath: string, prefix: string, options?: PdftoppmOptions): Promise<PdfToPngResult>;
/** Run one render at a time. A small host converting two PDFs at once swaps. */
export declare function serializeRender<T>(work: () => Promise<T>): Promise<T>;
/** A file name that is safe to sign, serve, and paste. */
export declare function renderFileName(sheetTitle: string, at?: number): string;
//# sourceMappingURL=render.d.ts.map