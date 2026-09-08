/**
 * What a tool module exports.
 *
 * Tools are plain definitions rather than direct `server.registerTool` calls
 * because HTTP mode builds a new McpServer for every request. Registration has
 * to be cheap and repeatable, and a definition object is both. It also means a
 * tool's handler can be called straight from a test with a fake context, with
 * no MCP machinery in the way.
 */
export {};
//# sourceMappingURL=types.js.map