/**
 * The HTTP transport.
 *
 * This is the one that has to work in Claude Code cloud sessions, where stdio
 * servers cannot run at all. It is stateless: no session id, no stream, a JSON
 * response per request.
 *
 * Two things about SDK 1.x drive the shape.
 *
 * A stateless `StreamableHTTPServerTransport` cannot be reused. Connecting a
 * second request to a transport that already ran one throws. So every request
 * gets a fresh transport and a fresh McpServer, both thrown away when the
 * response closes. That is cheap because `createServer` only registers tools;
 * the Google client, the tab cache and the registry live at module scope and
 * are shared across every request.
 *
 * The aggregator in front of this server sends bare `tools/call` posts with no
 * `initialize` handshake, sometimes several at once. Stateless mode is what
 * makes that work, and `test/http.test.ts` holds it to it.
 */
import http from "node:http";
import { type CreateServerOptions } from "../server.js";
export interface HttpServerOptions extends CreateServerOptions {
    /** Paths that accept MCP posts. Default `/mcp` and `/`. */
    mcpPaths?: string[];
    /** Override the bearer requirement. Defaults to `GSHEETS_PRO_TOKEN`. */
    bearer?: string | undefined;
    /** Where rendered PNGs are written and served from. */
    renderDir?: string;
    /** The origin signed render URLs hang off, for example https://sheets.example.com. */
    publicUrl?: string;
}
export declare function createHttpHandler(options?: HttpServerOptions): (req: http.IncomingMessage, res: http.ServerResponse) => void;
export interface ServeOptions extends HttpServerOptions {
    port?: number;
    host?: string;
}
/** Start listening. Resolves with the server and the port actually bound. */
export declare function serveHttp(options?: ServeOptions): Promise<{
    server: http.Server;
    port: number;
    host: string;
}>;
//# sourceMappingURL=http.d.ts.map