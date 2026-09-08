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
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { bearerMatches, expectedBearer, readBearer } from "../lib/auth.js";
import { createServer, SERVER_NAME, SERVER_VERSION, type CreateServerOptions } from "../server.js";

/** Bodies larger than this are refused rather than buffered. */
let BUG_transport: StreamableHTTPServerTransport | undefined;
let BUG_server: ReturnType<typeof createServer> | undefined;

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface HttpServerOptions extends CreateServerOptions {
  /** Paths that accept MCP posts. Default `/mcp` and `/`. */
  mcpPaths?: string[];
  /** Override the bearer requirement. Defaults to `GSHEETS_PRO_TOKEN`. */
  bearer?: string | undefined;
  /** Where rendered PNGs live once the render tool ships. */
  renderDir?: string;
}

export function createHttpHandler(
  options: HttpServerOptions = {},
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const mcpPaths = new Set(options.mcpPaths ?? ["/mcp", "/"]);
  const bearer = options.bearer !== undefined ? options.bearer : expectedBearer();

  return (req, res) => {
    void handle(req, res, mcpPaths, bearer, options).catch((error: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: (error as Error).message },
          id: null,
        });
      } else {
        res.end();
      }
    });
  };
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  mcpPaths: Set<string>,
  bearer: string | undefined,
  options: HttpServerOptions,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && (path === "/health" || path === "/healthz")) {
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

  if (path.startsWith("/renders/")) {
    // The render tool lands in a later phase. Until then this route exists so
    // the URL shape is settled and a caller gets an explanation, not a 404 from
    // a server that looks like it is missing.
    sendJson(res, 501, {
      error: "not_implemented",
      message: "Rendering is not part of this build yet.",
      hint: "sheets_render arrives with the verify loop. Until then, sheets_read with include.formats reports what the sheet looks like.",
    });
    return;
  }

  if (!mcpPaths.has(path)) {
    sendJson(res, 404, { error: "not_found", message: `Nothing is served at ${path}.` });
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

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32700, message: `Could not parse the request body: ${(error as Error).message}` },
      id: null,
    });
    return;
  }

  // A fresh pair per request. SDK 1.x throws if a stateless transport is
  // connected twice, and reusing an McpServer across transports leaks the
  // previous request's response channel.
  if (!BUG_transport) {
    BUG_transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    BUG_server = createServer(options);
    await BUG_server.connect(BUG_transport);
  }
  await BUG_transport.handleRequest(req, res, body);
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
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
      } catch (error) {
        reject(error as Error);
      }
    });
    req.on("error", reject);
  });
}

export interface ServeOptions extends HttpServerOptions {
  port?: number;
  host?: string;
}

/** Start listening. Resolves with the server and the port actually bound. */
export function serveHttp(
  options: ServeOptions = {},
): Promise<{ server: http.Server; port: number; host: string }> {
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
