/**
 * Signed, short lived URLs for rendered PNGs in hosted mode.
 *
 * A render has to come back as something the model can look at. Locally that is
 * a file path. Hosted, the file is on a machine the model cannot reach, so the
 * server serves it over HTTP, and an image served over HTTP with a guessable
 * name is the spreadsheet's contents published to anyone who tries the name.
 *
 * So the URL carries an expiry and an HMAC over the name and that expiry. No
 * token, no file. An expired token, a token for a different name, or a token of
 * the wrong length are all the same answer: not found. Comparison is constant
 * time, because a signature check that leaks its progress through timing is not
 * a signature check.
 *
 * Five minutes is the default life. It is long enough for the model to fetch
 * the image in the same turn and short enough that a URL in a transcript is
 * worthless by the time anybody reads it.
 */

import crypto from "node:crypto";

/** How long a render URL stays valid. */
export const RENDER_URL_TTL_MS = 5 * 60 * 1000;

/** File names the route will consider. Anything else is refused unread. */
export const RENDER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.png$/;

let ephemeralSecret: string | undefined;

/**
 * The signing secret.
 *
 * `GSHEETS_PRO_RENDER_SECRET` when set, so a host running more than one
 * container can serve a URL minted by any of them. Otherwise the bearer, which
 * every hosted deployment already has and never publishes. Otherwise a random
 * value made once per process, which works for a single process and makes every
 * URL from a previous process expire the moment it restarts. That last case is
 * a slightly worse experience and never a weaker one.
 */
export function renderSecret(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.GSHEETS_PRO_RENDER_SECRET ?? env.GSHEETS_PRO_TOKEN;
  if (configured && configured.trim() !== "") return configured;
  ephemeralSecret ??= crypto.randomBytes(32).toString("hex");
  return ephemeralSecret;
}

/** Forget the per process secret. Tests only. */
export function resetRenderSecret(): void {
  ephemeralSecret = undefined;
}

export function signRender(name: string, expiresAt: number, secret: string): string {
  return crypto.createHmac("sha256", secret).update(`${name}.${expiresAt}`).digest("hex");
}

export interface SignedRender {
  name: string;
  expiresAt: number;
  signature: string;
  /** The path and query, ready to hang off a base URL. */
  path: string;
}

export function signRenderPath(
  name: string,
  options: { now?: number; ttlMs?: number; secret?: string } = {},
): SignedRender {
  const now = options.now ?? Date.now();
  const expiresAt = now + (options.ttlMs ?? RENDER_URL_TTL_MS);
  const signature = signRender(name, expiresAt, options.secret ?? renderSecret());
  return {
    name,
    expiresAt,
    signature,
    path: `/renders/${encodeURIComponent(name)}?exp=${expiresAt}&sig=${signature}`,
  };
}

export type VerifyResult =
  | { ok: true; name: string }
  | { ok: false; reason: "bad_name" | "missing_token" | "expired" | "bad_signature" };

/**
 * Check a request for a rendered file. Every failure returns the same shape and
 * the route answers all of them with 404: telling a caller that a file exists
 * but their signature is wrong is telling them the file exists.
 */
export function verifyRenderRequest(
  name: string,
  params: { exp?: string | null; sig?: string | null },
  options: { now?: number; secret?: string } = {},
): VerifyResult {
  const decoded = safeDecode(name);
  if (!decoded || !RENDER_NAME_PATTERN.test(decoded)) return { ok: false, reason: "bad_name" };

  const exp = Number(params.exp);
  const sig = params.sig ?? "";
  if (!Number.isFinite(exp) || exp <= 0 || sig === "") return { ok: false, reason: "missing_token" };

  const now = options.now ?? Date.now();
  if (exp < now) return { ok: false, reason: "expired" };

  const expected = signRender(decoded, exp, options.secret ?? renderSecret());
  if (!timingSafeEqual(sig, expected)) return { ok: false, reason: "bad_signature" };

  return { ok: true, name: decoded };
}

function safeDecode(name: string): string | undefined {
  try {
    const decoded = decodeURIComponent(name);
    // A name that walks out of the directory is refused before it is signed,
    // and again here, because the two checks protect different mistakes.
    if (decoded.includes("/") || decoded.includes("\\") || decoded.includes("..")) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
