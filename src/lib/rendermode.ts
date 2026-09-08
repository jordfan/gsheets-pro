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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dataDir } from "./auth.js";

export type RenderMode = "local" | "hosted";

interface RenderConfig {
  mode: RenderMode;
  /** Where PNGs are written. */
  dir?: string;
  /** Origin the signed URL hangs off, for example https://sheets.example.com. */
  publicUrl?: string;
}

let config: RenderConfig | undefined;

/** Called by the transport at startup. Last call wins. */
export function setRenderMode(mode: RenderMode, options: { dir?: string; publicUrl?: string } = {}): void {
  const next: RenderConfig = { mode };
  if (options.dir) next.dir = options.dir;
  if (options.publicUrl) next.publicUrl = options.publicUrl;
  config = next;
}

/** Forget the configured mode. Tests, and `doctor`. */
export function resetRenderMode(): void {
  config = undefined;
}

export function renderMode(env: NodeJS.ProcessEnv = process.env): RenderMode {
  const override = env.GSHEETS_PRO_RENDER_MODE?.trim().toLowerCase();
  if (override === "hosted" || override === "local") return override;
  return config?.mode ?? "local";
}

/**
 * The directory renders are written to, created if it is missing.
 *
 * Local renders live beside the token, under the plugin's data directory, so
 * they are somewhere a person can find and delete. Hosted renders default to a
 * directory under the system temp dir, because a container's filesystem is
 * disposable and treating renders as durable there would be a lie.
 */
export function renderDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.GSHEETS_PRO_RENDER_DIR?.trim() || config?.dir;
  const dir =
    configured ||
    (renderMode(env) === "hosted"
      ? path.join(os.tmpdir(), "gsheets-pro-renders")
      : path.join(dataDir(), "renders"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The origin a hosted signed URL hangs off, when the host has told us one. */
export function renderPublicUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.GSHEETS_PRO_PUBLIC_URL?.trim() || config?.publicUrl;
  if (!configured) return undefined;
  return configured.replace(/\/+$/, "");
}
