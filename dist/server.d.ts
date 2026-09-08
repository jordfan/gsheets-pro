/**
 * The MCP server.
 *
 * `createServer` is called once for stdio and once per request for HTTP, which
 * is why it does no I/O beyond registration: the SDK's stateless
 * StreamableHTTPServerTransport cannot be reused across requests, so a fresh
 * McpServer has to be cheap. Everything expensive (the Google client, the tab
 * cache, the registry) lives at module scope in `lib/client.ts` and is shared.
 *
 * `instructions` is kept under two kilobytes. Claude Code does not reliably
 * forward server instructions for stdio plugin servers and the aggregator drops
 * them entirely, so this is a backstop, not the carrier. The skill and the
 * first-call hook are the carriers.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Context } from "./lib/client.js";
export declare const SERVER_NAME = "gsheets-pro";
export declare const SERVER_VERSION = "0.1.0";
/** Under 2KB on purpose: longer instructions are silently dropped. */
export declare const SERVER_INSTRUCTIONS: string;
export interface CreateServerOptions {
    /** Override the context factory, which is what the tests do. */
    getContext?: () => Promise<Context>;
}
export declare function createServer(options?: CreateServerOptions): McpServer;
/** Tool names, for the hook matchers and the tests. */
export declare function toolNames(): string[];
//# sourceMappingURL=server.d.ts.map