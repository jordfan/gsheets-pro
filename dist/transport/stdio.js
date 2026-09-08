/**
 * The stdio transport, for laptop users running the bundled server.
 *
 * One server, one transport, for the life of the process. Nothing may be
 * written to stdout except protocol traffic, so every diagnostic goes to
 * stderr: a stray `console.log` here corrupts the stream and the client sees a
 * parse error rather than a message.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../server.js";
export async function serveStdio(options = {}) {
    const server = createServer(options);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    await new Promise((resolve) => {
        const shutdown = () => {
            void server.close().finally(() => resolve());
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
        process.stdin.on("close", shutdown);
    });
}
//# sourceMappingURL=stdio.js.map