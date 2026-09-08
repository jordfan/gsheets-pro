/**
 * The tool registry.
 *
 * One array, so `server.ts` does not have to know what exists and a new tool
 * is one import plus one line.
 */

import { createOpenTool } from "./open.js";
import { createReadTool } from "./read.js";
import type { ToolDefinition, ToolDeps } from "./types.js";

export type AnyToolFactory = (deps: ToolDeps) => ToolDefinition<never>;

const FACTORIES = [createOpenTool, createReadTool] as const;

/** Build every tool against one set of dependencies. */
export function createTools(deps: ToolDeps): Array<ToolDefinition<never>> {
  return FACTORIES.map((factory) => factory(deps) as unknown as ToolDefinition<never>);
}

export { createOpenTool, createReadTool };
export type { ToolDefinition, ToolDeps } from "./types.js";
