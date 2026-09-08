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
import { getContext } from "./lib/client.js";
import { createTools } from "./tools/index.js";
export const SERVER_NAME = "gsheets-pro";
export const SERVER_VERSION = "0.1.0";
/** Under 2KB on purpose: longer instructions are silently dropped. */
export const SERVER_INSTRUCTIONS = [
    "Google Sheets, with formatting and structure as first class operations.",
    "",
    "Call sheets_open first, every time, before reading or writing. It returns the tabs, the native Tables, the named ranges, the contract that says which columns are yours to write, and the dropdowns that belong to the Sheets UI rather than to you.",
    "",
    "Everything takes tab NAMES and A1 ranges. The server resolves ids and grid coordinates.",
    "",
    "Reads return records keyed by header, each carrying _row, the true row number in the sheet. Use _row when you write back; never assume a row's position from its order in a filtered result.",
    "",
    "Formulas pass through byte for byte. Do not rewrite a colleague's formula.",
    "",
    "A dropdown the plugin did not create is the human's. Its chip colours cannot be read through the API and a rewrite loses them.",
    "",
    "Errors are {code, message, hint}. Read the hint; it names the fix.",
].join("\n");
export function createServer(options = {}) {
    const deps = { getContext: options.getContext ?? (() => getContext()) };
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS });
    for (const tool of createTools(deps)) {
        server.registerTool(tool.name, tool.config, tool.handler);
    }
    return server;
}
/** Tool names, for the hook matchers and the tests. */
export function toolNames() {
    return createTools({ getContext: async () => ({}) }).map((t) => t.name);
}
//# sourceMappingURL=server.js.map