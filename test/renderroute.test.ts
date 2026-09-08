/**
 * The `/renders/` route.
 *
 * This is the one endpoint on the server that is not behind the bearer, because
 * whatever fetches a render URL does it with a plain GET and cannot attach a
 * header. So the URL is the credential, and what this suite holds it to is that
 * every way of getting it wrong answers the same 404: a route that said "bad
 * signature" for a real file and "not found" for an imaginary one would be a
 * way to find out which spreadsheets have been rendered.
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { Context } from "../src/lib/client.js";
import { createHttpHandler } from "../src/transport/http.js";
import { resetRenderMode } from "../src/lib/rendermode.js";
import { signRender, signRenderPath } from "../src/lib/rendersign.js";
import { makeFakeContext, type FakeSpreadsheet } from "./helpers/fakeContext.js";

const SPREADSHEET: FakeSpreadsheet = {
  title: "Render Route Fixture",
  tabs: [{ title: "Roster", sheetId: 0, values: [["Student"], ["Nell Ashgrove"]] }],
};

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
  0, 0, 0x02, 0x58, 0, 0, 0x01, 0x90,
]);

let server: http.Server;
let base: string;
let dir: string;
let context: Context;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsheets-render-route-"));
  fs.writeFileSync(path.join(dir, "roster-abc.png"), PNG);
  // Something that must never be served, sitting in the same directory.
  fs.writeFileSync(path.join(dir, "token.json"), '{"refresh_token":"not-a-real-token"}');

  process.env.GSHEETS_PRO_RENDER_SECRET = "route-test-secret";
  context = makeFakeContext(SPREADSHEET).context;
  server = http.createServer(
    createHttpHandler({ getContext: async () => context, bearer: "the-bearer", renderDir: dir }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.GSHEETS_PRO_RENDER_SECRET;
  resetRenderMode();
});

describe("serving a render", () => {
  test("a signed URL serves the PNG with no bearer", async () => {
    const signed = signRenderPath("roster-abc.png");
    const response = await fetch(`${base}${signed.path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
  });

  test("HEAD works, for a client checking the link is still live", async () => {
    const signed = signRenderPath("roster-abc.png");
    const response = await fetch(`${base}${signed.path}`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(PNG.length));
  });

  test("an expired link is a 404", async () => {
    const expiresAt = Date.now() - 1000;
    const sig = signRender("roster-abc.png", expiresAt, "route-test-secret");
    const response = await fetch(`${base}/renders/roster-abc.png?exp=${expiresAt}&sig=${sig}`);
    expect(response.status).toBe(404);
  });

  test("a forged signature is a 404, with the same body as a missing file", async () => {
    const real = await fetch(`${base}/renders/roster-abc.png?exp=${Date.now() + 60000}&sig=deadbeef`);
    const missing = await fetch(`${base}/renders/nothing-here.png?exp=${Date.now() + 60000}&sig=deadbeef`);
    expect(real.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await real.text()).toBe(await missing.text());
  });

  test("a valid signature for a file that is gone is still a 404", async () => {
    const signed = signRenderPath("deleted-page.png");
    expect((await fetch(`${base}${signed.path}`)).status).toBe(404);
  });

  test("the directory cannot be listed or walked out of", async () => {
    expect((await fetch(`${base}/renders/`)).status).toBe(404);
    expect((await fetch(`${base}/renders`)).status).toBe(404);

    // Even correctly signed, a name that is not a plain PNG file name is refused.
    const expiresAt = Date.now() + 60_000;
    for (const name of ["../token.json", "token.json", "..%2Ftoken.json"]) {
      const sig = signRender(name, expiresAt, "route-test-secret");
      const response = await fetch(`${base}/renders/${name}?exp=${expiresAt}&sig=${sig}`);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("refresh_token");
    }
  });

  test("writing to the route is refused", async () => {
    const signed = signRenderPath("roster-abc.png");
    const response = await fetch(`${base}${signed.path}`, { method: "DELETE" });
    expect(response.status).toBe(405);
  });

  test("the MCP endpoint still wants its bearer", async () => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });
});
