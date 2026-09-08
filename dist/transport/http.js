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
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bearerMatches, expectedBearer, readBearer } from "../lib/auth.js";
import { renderDir as defaultRenderDir, setRenderMode } from "../lib/rendermode.js";
import { verifyRenderRequest } from "../lib/rendersign.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "../server.js";
/** Bodies larger than this are refused rather than buffered. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
export function createHttpHandler(options = {}) {
    const mcpPaths = new Set(options.mcpPaths ?? ["/mcp", "/"]);
    const bearer = options.bearer !== undefined ? options.bearer : expectedBearer();
    // A render has to know it is hosted before the first call, because the answer
    // it gives (a path or a URL) is different, and a path to a container's
    // filesystem is no answer at all.
    setRenderMode("hosted", {
        ...(options.renderDir ? { dir: options.renderDir } : {}),
        ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
    });
    return (req, res) => {
        void handle(req, res, mcpPaths, bearer, options).catch((error) => {
            if (!res.headersSent) {
                sendJson(res, 500, {
                    jsonrpc: "2.0",
                    error: { code: -32603, message: error.message },
                    id: null,
                });
            }
            else {
                res.end();
            }
        });
    };
}
async function handle(req, res, mcpPaths, bearer, options) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const requestPath = url.pathname.replace(/\/+$/, "") || "/";
    if (req.method === "GET" && (requestPath === "/health" || requestPath === "/healthz")) {
        sendJson(res, 200, {
            status: "ok",
            name: SERVER_NAME,
            version: SERVER_VERSION,
            transport: "streamable-http",
            stateless: true,
            auth_required: bearer !== undefined,
        });
        return;
    }
    if (requestPath.startsWith("/renders/")) {
        serveRender(req, res, requestPath, url, options);
        return;
    }
    if (!mcpPaths.has(requestPath)) {
        sendJson(res, 404, { error: "not_found", message: `Nothing is served at ${requestPath}.` });
        return;
    }
    if (bearer !== undefined && !bearerMatches(readBearer(req.headers.authorization), bearer)) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="gsheets-pro"');
        sendJson(res, 401, {
            error: "unauthorized",
            message: "This server requires a bearer token.",
            hint: "Send Authorization: Bearer <token>, matching GSHEETS_PRO_TOKEN on the server.",
        });
        return;
    }
    if (req.method !== "POST") {
        // Stateless mode has no server initiated stream to attach to, so the GET
        // and DELETE halves of the protocol have nothing to do.
        res.setHeader("Allow", "POST");
        sendJson(res, 405, {
            error: "method_not_allowed",
            message: "This server is stateless, so only POST carries MCP traffic.",
        });
        return;
    }
    let body;
    try {
        body = await readJsonBody(req);
    }
    catch (error) {
        sendJson(res, 400, {
            jsonrpc: "2.0",
            error: { code: -32700, message: `Could not parse the request body: ${error.message}` },
            id: null,
        });
        return;
    }
    // A fresh pair per request. SDK 1.x throws if a stateless transport is
    // connected twice, and reusing an McpServer across transports leaks the
    // previous request's response channel.
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
    });
    const server = createServer(options);
    const cleanup = () => {
        void transport.close().catch(() => { });
        void server.close().catch(() => { });
    };
    res.once("close", cleanup);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
}
/**
 * Serve one rendered PNG.
 *
 * The MCP endpoint is behind a bearer, but this one cannot be: whatever fetches
 * these URLs does it with an ordinary GET and has no way to attach a header. So
 * the URL itself is the credential, signed and short lived (`lib/rendersign.ts`),
 * and every way of failing answers 404 with nothing useful in the body. A
 * different answer for "wrong signature" than for "no such file" would tell a
 * caller which spreadsheets have been rendered, which is the one thing this
 * route knows and has no business saying.
 *
 * There is no listing. `/renders/` with no name is a 404 like everything else.
 */
function serveRender(req, res, requestPath, url, options) {
    if (req.method !== "GET" && req.method !== "HEAD") {
        res.setHeader("Allow", "GET, HEAD");
        sendJson(res, 405, { error: "method_not_allowed", message: "Renders are read only." });
        return;
    }
    const notFound = () => {
        sendJson(res, 404, { error: "not_found", message: "No such render." });
    };
    const name = requestPath.slice("/renders/".length);
    if (!name) {
        notFound();
        return;
    }
    const verdict = verifyRenderRequest(name, {
        exp: url.searchParams.get("exp"),
        sig: url.searchParams.get("sig"),
    });
    if (!verdict.ok) {
        notFound();
        return;
    }
    const dir = options.renderDir ?? defaultRenderDir();
    const file = path.join(dir, verdict.name);
    // The name pattern already refuses separators. Resolving and re-checking is
    // the belt to that pair of braces, and it costs nothing.
    if (path.dirname(path.resolve(file)) !== path.resolve(dir)) {
        notFound();
        return;
    }
    let bytes;
    try {
        bytes = fs.readFileSync(file);
    }
    catch {
        notFound();
        return;
    }
    res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": bytes.length,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") {
        res.end();
        return;
    }
    res.end(bytes);
}
function sendJson(res, status, payload) {
    const text = JSON.stringify(payload);
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(text),
    });
    res.end(text);
}
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error(`Body is over the ${MAX_BODY_BYTES} byte limit.`));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if (!text.trim()) {
                resolve(undefined);
                return;
            }
            try {
                resolve(JSON.parse(text));
            }
            catch (error) {
                reject(error);
            }
        });
        req.on("error", reject);
    });
}
/** Start listening. Resolves with the server and the port actually bound. */
export function serveHttp(options = {}) {
    const host = options.host ?? process.env.GSHEETS_PRO_HOST ?? "0.0.0.0";
    const port = options.port ?? Number(process.env.PORT ?? process.env.GSHEETS_PRO_PORT ?? 8080);
    const server = http.createServer(createHttpHandler(options));
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            const address = server.address();
            const bound = address && typeof address === "object" ? address.port : port;
            resolve({ server, port: bound, host });
        });
    });
}
//# sourceMappingURL=http.js.map