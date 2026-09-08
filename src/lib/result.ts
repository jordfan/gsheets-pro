/**
 * Tool results.
 *
 * Every response carries both halves: prose in `content[0].text` for the model
 * to read, and `structuredContent` for it to act on. Neither one alone is
 * enough. Prose without structure means re-parsing numbers out of English;
 * structure without prose means the model has to infer what happened from a
 * blob of JSON, and it infers wrong.
 *
 * Errors are the same shape plus `isError: true`, and always carry a hint.
 */

import { errorToText, toStructuredError, type StructuredError } from "./errors.js";

/** The key Claude Code reads to size a tool result. */
export const MAX_RESULT_SIZE_KEY = "anthropic/maxResultSizeChars";

/** Roughly the 25k token default, in characters. */
export const DEFAULT_RESULT_BUDGET_CHARS = 100_000;

export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface OkOptions {
  /**
   * Declare how much room this result may take. Set it on reads that can be
   * large; leaving it unset keeps the client's default.
   */
  maxResultSizeChars?: number;
  meta?: Record<string, unknown>;
}

export function ok(
  text: string,
  structuredContent?: Record<string, unknown>,
  options: OkOptions = {},
): ToolResponse {
  const response: ToolResponse = { content: [{ type: "text", text }] };
  if (structuredContent) response.structuredContent = structuredContent;
  const meta: Record<string, unknown> = { ...(options.meta ?? {}) };
  if (options.maxResultSizeChars !== undefined) {
    meta[MAX_RESULT_SIZE_KEY] = options.maxResultSizeChars;
  }
  if (Object.keys(meta).length > 0) response._meta = meta;
  return response;
}

/** An error result: prose, the structured error, and `isError`. */
export function failure(error: unknown): ToolResponse {
  const structured = toStructuredError(error);
  return {
    content: [{ type: "text", text: errorToText(structured) }],
    structuredContent: { error: structured } as unknown as Record<string, unknown>,
    isError: true,
  };
}

export function isFailure(response: ToolResponse): boolean {
  return response.isError === true;
}

/** Pull the structured error back out, for tests and for the HTTP layer. */
export function errorOf(response: ToolResponse): StructuredError | undefined {
  const value = response.structuredContent?.["error"];
  return value && typeof value === "object" ? (value as StructuredError) : undefined;
}

/**
 * Wrap a tool handler so anything it throws becomes a structured error rather
 * than an MCP protocol error. A protocol error tells the model only that the
 * call failed; a structured one tells it what to do next.
 */
export function guarded<Args>(
  handler: (args: Args) => Promise<ToolResponse>,
): (args: Args) => Promise<ToolResponse> {
  return async (args: Args) => {
    try {
      return await handler(args);
    } catch (error) {
      return failure(error);
    }
  };
}

// ---------------------------------------------------------------------------
// Prose helpers
// ---------------------------------------------------------------------------

/** Join lines, dropping the empty ones, so builders can push conditionally. */
export function lines(...parts: Array<string | undefined | null | false>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join("\n");
}

/** "3 rows" / "1 row". */
export function count(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}

/** Join a list the way a person writes one: "a, b and c". */
export function listOf(items: string[], conjunction = "and"): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]}`;
}

/**
 * Cut a table of rows down to a character budget, reporting what was dropped.
 * Reads paginate rather than truncate, but a preview inside a larger response
 * still has to stop somewhere.
 */
export function truncateRows<T>(
  rows: T[],
  budgetChars: number,
  render: (row: T) => string,
): { text: string; shown: number; dropped: number } {
  const out: string[] = [];
  let used = 0;
  let shown = 0;
  for (const row of rows) {
    const line = render(row);
    if (used + line.length + 1 > budgetChars) break;
    out.push(line);
    used += line.length + 1;
    shown += 1;
  }
  return { text: out.join("\n"), shown, dropped: rows.length - shown };
}
