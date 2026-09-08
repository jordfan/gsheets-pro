// Spike 6: stateless streamable HTTP under the aggregator's traffic shape.
//
// The production aggregator does NOT run the MCP handshake against a backend
// per request. It POSTs a bare `tools/call` with an arbitrary JSON-RPC id and
// no prior `initialize`, many at once. This spike reproduces that.
//
// Mode A: a fresh StreamableHTTPServerTransport + McpServer per request
//         (sessionIdGenerator: undefined, enableJsonResponse: true).
// Mode B: one transport + one McpServer constructed at startup and reused.
//
// Run: node spike6-stateless-http.mjs
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = Number(process.env.SPIKE6_PORT || 8791);
const N = Number(process.env.SPIKE6_N || 20);

// ---- module-scope shared state, the thing the plan says survives per-request
// construction. A counter stands in for the Google client and the sheet cache.
let sharedCalls = 0;
const sharedCache = new Map();

function buildServer() {
  const server = new McpServer(
    { name: 'gsheets-pro-spike', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  server.registerTool(
    'sheets_open',
    {
      description: 'Spike stand-in for the real first-call tool.',
      inputSchema: { spreadsheet: z.string() },
    },
    async ({ spreadsheet }) => {
      sharedCalls += 1;
      sharedCache.set(spreadsheet, (sharedCache.get(spreadsheet) ?? 0) + 1);
      // a tick of real async work, so overlapping requests actually interleave
      await new Promise((r) => setTimeout(r, 25));
      return {
        content: [{ type: 'text', text: `opened ${spreadsheet} (shared call #${sharedCalls})` }],
        structuredContent: { spreadsheet, sharedCalls },
      };
    },
  );
  return server;
}

// ---- read the body ourselves and hand it to the transport, the way an
// express app with express.json() would.
function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// Mode B state: built once, reused for every request.
let reusedTransport = null;
let reusedServer = null;

async function handle(req, res, mode) {
  const body = await readJson(req);
  if (mode === 'per-request') {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } else {
    if (!reusedTransport) {
      reusedServer = buildServer();
      reusedTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      // capture whatever the transport and the protocol layer complain about,
      // since the wire response for a reuse failure is an empty 500
      reusedTransport.onerror = (e) => serverSideErrors.push(`transport.onerror: ${e?.message}`);
      reusedServer.server.onerror = (e) => serverSideErrors.push(`server.onerror: ${e?.message}`);
      await reusedServer.connect(reusedTransport);
    }
    await reusedTransport.handleRequest(req, res, body);
  }
}

const serverSideErrors = [];

function start(mode) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        await handle(req, res, mode);
      } catch (err) {
        serverSideErrors.push(String(err && err.message));
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
        }
        res.end(JSON.stringify({ serverThrew: String(err && err.message) }));
      }
    });
    server.listen(PORT, () => resolve(server));
  });
}

// ---- the aggregator's request shape: bare tools/call, no initialize,
// arbitrary ids, both Accept types present (the SDK requires both).
async function bareToolCall(id) {
  const started = Date.now();
  let res, text;
  try {
    res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'sheets_open', arguments: { spreadsheet: `sheet-${id}` } },
      }),
    });
    text = await res.text();
  } catch (err) {
    return {
      id,
      status: 'transport-error',
      contentType: null,
      ms: Date.now() - started,
      ok: false,
      errorCode: err?.cause?.code ?? 'FETCH_FAILED',
      errorMessage: String(err?.cause?.message ?? err?.message),
      bodyHead: '',
    };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* SSE or empty */
  }
  return {
    id,
    status: res.status,
    contentType: res.headers.get('content-type'),
    ms: Date.now() - started,
    idEchoed: parsed?.id,
    ok: Boolean(parsed?.result),
    errorCode: parsed?.error?.code,
    errorMessage: parsed?.error?.message,
    bodyHead: text.slice(0, 160),
  };
}

async function runMode(mode, { sequential = false } = {}) {
  sharedCalls = 0;
  sharedCache.clear();
  serverSideErrors.length = 0;
  const httpServer = await start(mode);
  // arbitrary, non-sequential ids, some strings, some numbers, one repeated
  const ids = Array.from({ length: N }, (_, i) =>
    i % 4 === 0 ? `agg-${1000 + i}` : 90000 + i * 7,
  );
  ids[N - 1] = ids[0]; // the aggregator does reuse ids across independent calls
  let results;
  if (sequential) {
    results = [];
    for (const id of ids) results.push(await bareToolCall(id));
  } else {
    results = await Promise.all(ids.map((id) => bareToolCall(id)));
  }
  await new Promise((r) => httpServer.close(r));

  const okCount = results.filter((r) => r.ok).length;
  const statuses = [...new Set(results.map((r) => r.status))];
  const ctypes = [...new Set(results.map((r) => r.contentType))];
  const idsMatch = results.every((r) => String(r.idEchoed) === String(r.id));
  const failures = results.filter((r) => !r.ok);

  console.log(`\n=== mode: ${mode}${sequential ? ' (sequential)' : ' (concurrent)'} ===`);
  console.log(`  requests            ${N}`);
  console.log(`  ok (result present) ${okCount}/${N}`);
  console.log(`  http statuses       ${JSON.stringify(statuses)}`);
  console.log(`  content-types       ${JSON.stringify(ctypes)}`);
  console.log(`  every id echoed     ${idsMatch}`);
  console.log(`  shared module state ${sharedCalls} tool invocations, ${sharedCache.size} cache keys`);
  console.log(`  max latency         ${Math.max(...results.map((r) => r.ms))} ms`);
  if (failures.length) {
    // one example per distinct HTTP status, so a 500 body is never hidden
    // behind a pile of connection resets
    const byStatus = new Map();
    for (const f of failures) if (!byStatus.has(f.status)) byStatus.set(f.status, f);
    console.log(`  FAILURES (${failures.length}), one per status:`);
    for (const f of byStatus.values()) {
      console.log(
        `    id=${f.id} status=${f.status} code=${f.errorCode} msg=${JSON.stringify(f.errorMessage)}`,
      );
      console.log(`      body: ${JSON.stringify(f.bodyHead)}`);
    }
  }
  if (serverSideErrors.length) {
    console.log(`  server-side throws (${serverSideErrors.length}), unique:`);
    for (const m of [...new Set(serverSideErrors)]) console.log(`    ${JSON.stringify(m)}`);
  }
  return {
    mode,
    okCount,
    statuses,
    ctypes,
    idsMatch,
    failures: failures.length,
    serverThrows: [...new Set(serverSideErrors)],
  };
}

const a = await runMode('per-request');
const b = await runMode('reused-transport');
reusedTransport = null;
reusedServer = null;
const c = await runMode('reused-transport', { sequential: true });
console.log('\n=== verdict ===');
console.log(
  JSON.stringify(
    { perRequestConcurrent: a, reusedConcurrent: b, reusedSequential: c },
    null,
    2,
  ),
);
