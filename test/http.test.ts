/**
 * The HTTP transport under the traffic the aggregator actually sends.
 *
 * The aggregator in front of a hosted server posts bare `tools/call` requests
 * with no `initialize` handshake, sometimes several at once from different
 * subagents. This suite is the check that stateless mode plus a per request
 * transport survives that, because it is the one failure that would only show
 * up in production.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { Context } from "../src/lib/client.js";
import { createHttpHandler } from "../src/transport/http.js";
import { FAKE_SPREADSHEET_ID, makeFakeContext, type FakeSpreadsheet } from "./helpers/fakeContext.js";

const SPREADSHEET: FakeSpreadsheet = {
  title: "Concurrency Fixture",
  tabs: [
    {
      title: "Roster",
      sheetId: 0,
      frozenRowCount: 1,
      values: [
        ["Student", "Class"],
        ["Ana Reyes", "Clay Studio"],
        ["Bo Tran", "Chess Club"],
      ],
    },
  ],
};

let context: Context;
let server: http.Server;
let base: string;

beforeAll(async () => {
  context = makeFakeContext(SPREADSHEET).context;
  server = http.createServer(createHttpHandler({ getContext: async () => context, bearer: undefined }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: {
    content?: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  };
  error?: { code: number; message: string };
}

async function post(body: unknown, headers: Record<string, string> = {}, url = `${base}/mcp`) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // The aggregator sends both, which the transport requires.
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: JsonRpcResponse | undefined;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text) as JsonRpcResponse;
    } catch {
      // An SSE framed body, which is what we get if enableJsonResponse ever
      // stops taking effect. Pull the data line out so the assertion is about
      // the payload rather than the framing.
      const line = text.split("\n").find((l) => l.startsWith("data: "));
      if (line) parsed = JSON.parse(line.slice(6)) as JsonRpcResponse;
    }
  }
  return { status: response.status, text, json: parsed, headers: response.headers };
}

const callTool = (id: number, name: string, args: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

describe("health and routing", () => {
  test("GET /health answers without any MCP handshake", async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("ok");
    expect(body["stateless"]).toBe(true);
    expect(body["name"]).toBe("gsheets-pro");
  });

  test("the renders route explains itself rather than 404ing", async () => {
    const response = await fetch(`${base}/renders/abc.png`);
    expect(response.status).toBe(501);
    const body = (await response.json()) as Record<string, unknown>;
    expect(String(body["hint"])).toContain("sheets_render");
  });

  test("an unknown path is a plain 404", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  test("GET on the MCP path is refused, since stateless mode has no stream", async () => {
    const response = await fetch(`${base}/mcp`);
    expect(response.status).toBe(405);
  });

  test("the root path also carries MCP", async () => {
    const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {}, `${base}/`);
    expect(response.json?.result?.tools?.length).toBeGreaterThan(0);
  });

  test("a malformed body is a parse error, not a crash", async () => {
    const response = await post("{ not json", {});
    expect(response.status).toBe(400);
    expect(response.json?.error?.code).toBe(-32700);
  });
});

describe("bare calls, with no initialize", () => {
  test("tools/list works without a handshake", async () => {
    const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(200);
    const names = response.json?.result?.tools?.map((t) => t.name) ?? [];
    expect(names).toContain("sheets_open");
    expect(names).toContain("sheets_read");
  });

  test("every tool advertises an input schema", async () => {
    const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    for (const tool of response.json?.result?.tools ?? []) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.description).toBeTruthy();
    }
  });

  test("a bare tools/call returns a real result", async () => {
    const response = await post(callTool(2, "sheets_read", {
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      sheet: "Roster",
    }));
    expect(response.status).toBe(200);
    expect(response.json?.result?.isError).toBeFalsy();
    const records = (response.json?.result?.structuredContent as { records: unknown[] }).records;
    expect(records).toHaveLength(2);
  });

  test("the response is JSON, not an SSE stream", async () => {
    const response = await post(callTool(3, "sheets_read", {
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      sheet: "Roster",
    }));
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.text.startsWith("event:")).toBe(false);
  });

  test("no session id is issued, so nothing has to be remembered between calls", async () => {
    const response = await post({ jsonrpc: "2.0", id: 4, method: "tools/list" });
    expect(response.headers.get("mcp-session-id")).toBeNull();
  });

  test("a tool error comes back as a result with isError, not a protocol error", async () => {
    const response = await post(callTool(5, "sheets_read", {
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      sheet: "Nonexistent",
    }));
    expect(response.json?.error).toBeUndefined();
    expect(response.json?.result?.isError).toBe(true);
    const error = (response.json?.result?.structuredContent as { error: { code: string } }).error;
    expect(error.code).toBe("sheet_not_found");
  });

  test("an unknown tool is reported, not silently ignored", async () => {
    const response = await post(callTool(6, "sheets_nope", {}));
    const failed = response.json?.error !== undefined || response.json?.result?.isError === true;
    expect(failed).toBe(true);
  });
});

describe("concurrency", () => {
  test("twelve simultaneous bare calls all succeed, each with its own id", async () => {
    const requests = Array.from({ length: 12 }, (_, i) =>
      post(callTool(100 + i, "sheets_read", { spreadsheet_id: FAKE_SPREADSHEET_ID, sheet: "Roster" })),
    );
    const responses = await Promise.all(requests);

    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(responses.map((r) => r.json?.id).sort((a, b) => Number(a) - Number(b))).toEqual(
      Array.from({ length: 12 }, (_, i) => 100 + i),
    );
    for (const response of responses) {
      const records = (response.json?.result?.structuredContent as { records: unknown[] }).records;
      expect(records).toHaveLength(2);
    }
  });

  test("a mix of methods and tools in flight together stays sorted out", async () => {
    const responses = await Promise.all([
      post({ jsonrpc: "2.0", id: 200, method: "tools/list" }),
      post(callTool(201, "sheets_open", { spreadsheet_id: FAKE_SPREADSHEET_ID })),
      post(callTool(202, "sheets_read", { spreadsheet_id: FAKE_SPREADSHEET_ID, sheet: "Roster" })),
      post(callTool(203, "sheets_read", { spreadsheet_id: FAKE_SPREADSHEET_ID, sheet: "Missing" })),
      post({ jsonrpc: "2.0", id: 204, method: "tools/list" }),
    ]);

    expect(responses.map((r) => r.json?.id)).toEqual([200, 201, 202, 203, 204]);
    expect(responses[0].json?.result?.tools).toBeDefined();
    expect(responses[1].json?.result?.isError).toBeFalsy();
    expect(responses[2].json?.result?.isError).toBeFalsy();
    expect(responses[3].json?.result?.isError).toBe(true);
    expect(responses[4].json?.result?.tools).toBeDefined();
  });

  // Spike 6's finding, and the reason this case exists at all: a stateless
  // transport that gets reused fails on the SECOND request, and it fails
  // silently. No exception, no error callback, just an empty body with a 500.
  // The concurrency cases above cannot catch it, because parallel requests each
  // get their own transport whether the code is right or wrong. Two sequential
  // requests against one server is the only cheap assertion that does, so the
  // body is checked for content and not merely for a status code.
  test("a second sequential request on the same server still returns a real body", async () => {
    const first = await post(
      callTool(300, "sheets_read", { spreadsheet_id: FAKE_SPREADSHEET_ID, sheet: "Roster" }),
    );
    expect(first.status).toBe(200);
    expect(first.text.length).toBeGreaterThan(0);

    const second = await post(
      callTool(301, "sheets_read", { spreadsheet_id: FAKE_SPREADSHEET_ID, sheet: "Roster" }),
    );
    // Transport reuse shows up exactly here: an empty string and a 500.
    expect(second.text.length).toBeGreaterThan(0);
    expect(second.status).toBe(200);
    expect(second.json?.id).toBe(301);
    expect(second.json?.result?.isError).toBeFalsy();
    expect((second.json?.result?.structuredContent as { records: unknown[] }).records).toHaveLength(
      2,
    );
  });

  test("a longer sequential run keeps returning bodies", async () => {
    for (let i = 0; i < 5; i += 1) {
      const response = await post(
        callTool(310 + i, "sheets_read", { spreadsheet_id: FAKE_SPREADSHEET_ID, sheet: "Roster" }),
      );
      expect(response.text.length).toBeGreaterThan(0);
      expect(response.status).toBe(200);
      expect(response.json?.id).toBe(310 + i);
      expect(response.json?.result?.isError).toBeFalsy();
    }
  });

  test("two sequential tools/list calls both answer", async () => {
    const first = await post({ jsonrpc: "2.0", id: 320, method: "tools/list" });
    const second = await post({ jsonrpc: "2.0", id: 321, method: "tools/list" });
    expect(first.text.length).toBeGreaterThan(0);
    expect(second.text.length).toBeGreaterThan(0);
    expect(second.json?.result?.tools?.length).toBe(first.json?.result?.tools?.length);
  });
});

describe("the bearer, when one is configured", () => {
  let guarded: http.Server;
  let guardedBase: string;

  beforeAll(async () => {
    guarded = http.createServer(
      createHttpHandler({ getContext: async () => context, bearer: "s3cret-value" }),
    );
    await new Promise<void>((resolve) => guarded.listen(0, "127.0.0.1", resolve));
    const address = guarded.address();
    guardedBase = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => guarded.close(() => resolve()));
  });

  test("a request with no bearer is refused", async () => {
    const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {}, `${guardedBase}/mcp`);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  test("a wrong bearer is refused", async () => {
    const response = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { Authorization: "Bearer wrong" },
      `${guardedBase}/mcp`,
    );
    expect(response.status).toBe(401);
  });

  test("the right bearer gets through", async () => {
    const response = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { Authorization: "Bearer s3cret-value" },
      `${guardedBase}/mcp`,
    );
    expect(response.status).toBe(200);
    expect(response.json?.result?.tools?.length).toBeGreaterThan(0);
  });

  test("health stays open, so a load balancer can probe it", async () => {
    expect((await fetch(`${guardedBase}/health`)).status).toBe(200);
  });
});
