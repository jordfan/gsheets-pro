// The render pipeline under test in spike 1: the undocumented Sheets export
// URL, then pdftoppm. Also the documented Drive files.export fallback.
//
// The interesting part is the redirect. Google answers the export URL with a
// 307 to a googleusercontent.com host, and fetch() drops the Authorization
// header on a cross-origin redirect, so the follow lands on a sign-in page and
// you get HTML instead of a PDF. We follow it by hand and re-attach the bearer.
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { accessToken, driveApi } from './auth.mjs';

const OUT = new URL('../out/', import.meta.url);
const PDFTOPPM = '/opt/homebrew/bin/pdftoppm';

export function outPath(name) {
  mkdirSync(OUT, { recursive: true });
  return new URL(name, OUT).pathname;
}

/**
 * Fetch a URL with a bearer, following redirects manually so the
 * Authorization header survives the hop to googleusercontent.com.
 * Returns the bytes plus the redirect trail, which is the evidence.
 */
export async function fetchWithBearerAcrossRedirects(url, token, maxHops = 5) {
  const trail = [];
  let current = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    const res = await fetch(current, {
      redirect: 'manual',
      headers: { Authorization: `Bearer ${token}` },
    });
    const location = res.headers.get('location');
    trail.push({
      hop,
      status: res.status,
      contentType: res.headers.get('content-type'),
      // host only: the signed redirect target carries a credential-ish token
      redirectHost: location ? new URL(location, current).host : null,
    });
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: res.ok, status: res.status, contentType: res.headers.get('content-type'), buf, trail };
  }
  throw new Error(`too many redirects (${maxHops})`);
}

/** The same fetch WITHOUT manual redirect handling, to prove the header is dropped. */
export async function fetchAutoRedirect(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    bytes: buf.length,
    looksLikePdf: buf.subarray(0, 5).toString('latin1') === '%PDF-',
    head: buf.subarray(0, 120).toString('latin1').replace(/\s+/g, ' '),
  };
}

/**
 * Build the export URL the plan proposes. gid selects the tab; r1/c1/r2/c2 are
 * a zero-based, end-exclusive range; empty means the whole tab.
 */
export function exportUrl(spreadsheetId, opts = {}) {
  const p = new URLSearchParams({
    format: 'pdf',
    gridlines: String(opts.gridlines ?? false),
    fitw: String(opts.fitw ?? true),
    size: String(opts.size ?? 0),
    portrait: String(opts.portrait ?? false),
    fzr: String(opts.fzr ?? true),
  });
  // These five must be OMITTED when not used, never sent empty. The template in
  // the plan (`&gid=&r1=&c1=&r2=&c2=`) makes the endpoint answer 400 with an
  // HTML error page: an empty string is not the same as "unset" here.
  for (const k of ['gid', 'r1', 'c1', 'r2', 'c2']) {
    if (opts[k] != null) p.set(k, String(opts[k]));
  }
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?${p}`;
}

/** PDF bytes to PNG(s) via poppler. Returns the paths written. */
export function pdfToPng(pdfPath, prefix, dpi = 96) {
  execFileSync(PDFTOPPM, ['-png', '-r', String(dpi), pdfPath, prefix]);
  const paths = [];
  for (let n = 1; n <= 9; n++) {
    const candidate = `${prefix}-${n}.png`;
    try {
      statSync(candidate);
      paths.push(candidate);
    } catch {
      break;
    }
  }
  return paths;
}

/** Export URL -> PDF -> PNG. The whole spike-1 pipeline in one call. */
export async function renderViaExportUrl(spreadsheetId, name, opts = {}) {
  const token = await accessToken();
  const url = exportUrl(spreadsheetId, opts);
  const { status, contentType, buf, trail } = await fetchWithBearerAcrossRedirects(url, token);
  const isPdf = buf.subarray(0, 5).toString('latin1') === '%PDF-';
  const pdfPath = outPath(`${name}.pdf`);
  writeFileSync(pdfPath, buf);
  const result = { status, contentType, bytes: buf.length, isPdf, trail, pdfPath, pngPaths: [] };
  if (isPdf) result.pngPaths = pdfToPng(pdfPath, outPath(name), opts.dpi ?? 96);
  else result.head = buf.subarray(0, 200).toString('latin1').replace(/\s+/g, ' ');
  return result;
}

/** The documented fallback. Drive can only export the WHOLE workbook. */
export async function renderViaDriveExport(spreadsheetId, name) {
  const drive = driveApi();
  const res = await drive.files.export(
    { fileId: spreadsheetId, mimeType: 'application/pdf' },
    { responseType: 'arraybuffer' },
  );
  const buf = Buffer.from(res.data);
  const pdfPath = outPath(`${name}.pdf`);
  writeFileSync(pdfPath, buf);
  const isPdf = buf.subarray(0, 5).toString('latin1') === '%PDF-';
  return {
    bytes: buf.length,
    isPdf,
    pdfPath,
    pngPaths: isPdf ? pdfToPng(pdfPath, outPath(name)) : [],
  };
}
