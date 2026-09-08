/**
 * Where a render goes, and what the tool hands back.
 *
 * Local: a file on the machine the model is already reading files from, so the
 * response is a path and `Read` opens it.
 *
 * Hosted: the file is on a container the model cannot reach, so it is written
 * where the HTTP transport can serve it and the response is a short lived
 * signed URL.
 *
 * The mode is set by whichever transport started, not sniffed per call, because
 * a tool that guesses wrong hands back a path to a machine nobody can see. The
 * environment variable exists for the case of a stdio server whose renders are
 * served by something else.
 */
export type RenderMode = "local" | "hosted";
/** Called by the transport at startup. Last call wins. */
export declare function setRenderMode(mode: RenderMode, options?: {
    dir?: string;
    publicUrl?: string;
}): void;
/** Forget the configured mode. Tests, and `doctor`. */
export declare function resetRenderMode(): void;
export declare function renderMode(env?: NodeJS.ProcessEnv): RenderMode;
/**
 * The directory renders are written to, created if it is missing.
 *
 * Local renders live beside the token, under the plugin's data directory, so
 * they are somewhere a person can find and delete. Hosted renders default to a
 * directory under the system temp dir, because a container's filesystem is
 * disposable and treating renders as durable there would be a lie.
 */
export declare function renderDir(env?: NodeJS.ProcessEnv): string;
/** The origin a hosted signed URL hangs off, when the host has told us one. */
export declare function renderPublicUrl(env?: NodeJS.ProcessEnv): string | undefined;
//# sourceMappingURL=rendermode.d.ts.map