/**
 * What a tool module exports.
 *
 * Tools are plain definitions rather than direct `server.registerTool` calls
 * because HTTP mode builds a new McpServer for every request. Registration has
 * to be cheap and repeatable, and a definition object is both. It also means a
 * tool's handler can be called straight from a test with a fake context, with
 * no MCP machinery in the way.
 */

import type { ZodRawShape } from "zod";

import type { Context } from "../lib/client.js";
import type { ToolResponse } from "../lib/result.js";

export interface ToolDeps {
  getContext: () => Promise<Context>;
}

export interface ToolDefinition<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  config: {
    title: string;
    description: string;
    inputSchema: Shape;
    annotations?: {
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      idempotentHint?: boolean;
      openWorldHint?: boolean;
    };
  };
  handler: (args: Record<string, unknown>) => Promise<ToolResponse>;
}

export type ToolFactory = (deps: ToolDeps) => ToolDefinition;
