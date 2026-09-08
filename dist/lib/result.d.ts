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
import { type StructuredError } from "./errors.js";
/** The key Claude Code reads to size a tool result. */
export declare const MAX_RESULT_SIZE_KEY = "anthropic/maxResultSizeChars";
/** Roughly the 25k token default, in characters. */
export declare const DEFAULT_RESULT_BUDGET_CHARS = 100000;
export interface ToolResponse {
    content: Array<{
        type: "text";
        text: string;
    }>;
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
export declare function ok(text: string, structuredContent?: Record<string, unknown>, options?: OkOptions): ToolResponse;
/** An error result: prose, the structured error, and `isError`. */
export declare function failure(error: unknown): ToolResponse;
export declare function isFailure(response: ToolResponse): boolean;
/** Pull the structured error back out, for tests and for the HTTP layer. */
export declare function errorOf(response: ToolResponse): StructuredError | undefined;
/**
 * Wrap a tool handler so anything it throws becomes a structured error rather
 * than an MCP protocol error. A protocol error tells the model only that the
 * call failed; a structured one tells it what to do next.
 */
export declare function guarded<Args>(handler: (args: Args) => Promise<ToolResponse>): (args: Args) => Promise<ToolResponse>;
/** Join lines, dropping the empty ones, so builders can push conditionally. */
export declare function lines(...parts: Array<string | undefined | null | false>): string;
/** "3 rows" / "1 row". */
export declare function count(n: number, singular: string, plural?: string): string;
/** Join a list the way a person writes one: "a, b and c". */
export declare function listOf(items: string[], conjunction?: string): string;
/**
 * Cut a table of rows down to a character budget, reporting what was dropped.
 * Reads paginate rather than truncate, but a preview inside a larger response
 * still has to stop somewhere.
 */
export declare function truncateRows<T>(rows: T[], budgetChars: number, render: (row: T) => string): {
    text: string;
    shown: number;
    dropped: number;
};
//# sourceMappingURL=result.d.ts.map