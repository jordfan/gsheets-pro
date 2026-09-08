/**
 * The tool registry.
 *
 * One array, so `server.ts` does not have to know what exists and a new tool
 * is one import plus one line.
 *
 * The order is the order a session works in: open and read first, then the
 * tools that build a sheet, then the ones that rearrange it, then the escape
 * hatch, then the two that check the result. Tool lists are read top down by
 * the model as well as by people.
 */

import { createBatchTool } from "./batch.js";
import { createCheckTool } from "./check.js";
import { createConditionalFormatTool } from "./conditional_format.js";
import { createFindTool } from "./find.js";
import { createOpenTool } from "./open.js";
import { createReadTool } from "./read.js";
import { createRenderTool } from "./render.js";
import { createSettingsTool } from "./settings.js";
import { createStructureTool } from "./structure.js";
import { createStyleTool } from "./style.js";
import { createTableTool } from "./table.js";
import { createValidationTool } from "./validation.js";
import { createWriteTool } from "./write.js";
import type { ToolDefinition, ToolDeps } from "./types.js";

export type AnyToolFactory = (deps: ToolDeps) => ToolDefinition<never>;

const FACTORIES = [
  createOpenTool,
  createReadTool,
  createWriteTool,
  createTableTool,
  createSettingsTool,
  createStyleTool,
  createValidationTool,
  createConditionalFormatTool,
  createStructureTool,
  createFindTool,
  createBatchTool,
  createCheckTool,
  createRenderTool,
] as const;

/** Build every tool against one set of dependencies. */
export function createTools(deps: ToolDeps): Array<ToolDefinition<never>> {
  return FACTORIES.map((factory) => factory(deps) as unknown as ToolDefinition<never>);
}

export {
  createBatchTool,
  createCheckTool,
  createConditionalFormatTool,
  createFindTool,
  createOpenTool,
  createReadTool,
  createRenderTool,
  createSettingsTool,
  createStructureTool,
  createStyleTool,
  createTableTool,
  createValidationTool,
  createWriteTool,
};
export type { ToolDefinition, ToolDeps } from "./types.js";
