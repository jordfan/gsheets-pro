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
/** How long a render URL stays valid. */
export declare const RENDER_URL_TTL_MS: number;
/** File names the route will consider. Anything else is refused unread. */
export declare const RENDER_NAME_PATTERN: RegExp;
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
export declare function renderSecret(env?: NodeJS.ProcessEnv): string;
/** Forget the per process secret. Tests only. */
export declare function resetRenderSecret(): void;
export declare function signRender(name: string, expiresAt: number, secret: string): string;
export interface SignedRender {
    name: string;
    expiresAt: number;
    signature: string;
    /** The path and query, ready to hang off a base URL. */
    path: string;
}
export declare function signRenderPath(name: string, options?: {
    now?: number;
    ttlMs?: number;
    secret?: string;
}): SignedRender;
export type VerifyResult = {
    ok: true;
    name: string;
} | {
    ok: false;
    reason: "bad_name" | "missing_token" | "expired" | "bad_signature";
};
/**
 * Check a request for a rendered file. Every failure returns the same shape and
 * the route answers all of them with 404: telling a caller that a file exists
 * but their signature is wrong is telling them the file exists.
 */
export declare function verifyRenderRequest(name: string, params: {
    exp?: string | null;
    sig?: string | null;
}, options?: {
    now?: number;
    secret?: string;
}): VerifyResult;
//# sourceMappingURL=rendersign.d.ts.map