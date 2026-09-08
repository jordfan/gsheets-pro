/**
 * The after-write hook, fed the responses the tools actually produce.
 *
 * A hook reads a tool response through the harness rather than through a type,
 * so nothing stops the two drifting apart, and when they do the hook simply
 * goes quiet and nobody notices. So these tests do not hand it a payload
 * somebody typed: they run `sheets_check` against a fake spreadsheet and post
 * its real response into the hook's stdin.
 */

import { describe, expect, test, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createCheckTool } from "../src/tools/check.js";
import { clearWrites } from "../src/lib/writelog.js";
import { makeCheckContext, FIXTURE_SPREADSHEET_ID, type FakeTabSpec } from "./helpers/fakeCheckContext.js";

const HOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "gsheets-pro",
  "hooks",
  "after-write.mjs",
);

const CLEAN: FakeTabSpec = {
  title: "Roster",
  sheetId: 11,
  frozenRows: 1,
  rows: [
    [
      { value: "Student", bold: true },
      { value: "Sessions", bold: true },
      { value: "Fee", bold: true },
    ],
    ["Nell Ashgrove", 16, "=B2*80"],
  ],
};

const BROKEN: FakeTabSpec = {
  ...CLEAN,
  rows: [
    CLEAN.rows[0],
    ["Nell Ashgrove", 16, { formula: "=B2*Rate", error: "NAME" }],
    ["Iver Tolman", 16, { formula: "=B3*Rate", error: "NAME" }],
  ],
};

/** Run the hook with a payload on stdin and return whatever it printed. */
function runHook(payload: unknown): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, code: code ?? 0 }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

async function checkResponse(tabs: FakeTabSpec[]) {
  const { context } = makeCheckContext(tabs);
  const tool = createCheckTool({ getContext: async () => context }, { loadingBudgetMs: 50 });
  return tool.handler({ spreadsheet_id: FIXTURE_SPREADSHEET_ID });
}

/** A different session id per test, so state from one does not reach another. */
let session = 0;
beforeEach(() => {
  clearWrites();
  session += 1;
});

describe("what the hook does with a real sheets_check response", () => {
  test("errors_found is put back in front of the model, with the addresses", async () => {
    const response = await checkResponse([BROKEN]);
    const { stdout } = await runHook({
      session_id: `hook-test-errors-${session}`,
      tool_name: "mcp__gsheets-pro__sheets_check",
      tool_response: response,
    });

    expect(stdout).not.toBe("");
    const emitted = JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } };
    const context = emitted.hookSpecificOutput.additionalContext;
    expect(context).toContain("errors_found");
    expect(context).toContain("NAME x2");
    expect(context).toContain("Roster!C2");
  });

  test("a clean report says nothing at all", async () => {
    const response = await checkResponse([CLEAN]);
    const { stdout } = await runHook({
      session_id: `hook-test-clean-${session}`,
      tool_name: "mcp__gsheets-pro__sheets_check",
      tool_response: response,
    });
    expect(stdout).toBe("");
  });

  test("the connector's tool name prefix is matched as well as the plugin's", async () => {
    const response = await checkResponse([BROKEN]);
    const { stdout } = await runHook({
      session_id: `hook-test-prefix-${session}`,
      tool_name: "mcp__claude_ai_Google_Workspace_Advanced__sheets_check",
      tool_response: response,
    });
    expect(stdout).toContain("errors_found");
  });

  test("a write's own gate is still read from its check wrapper", async () => {
    // The shape sheets_write returns: the gate nested under `check`, with
    // error_summary as plain counts rather than the lint's richer entries.
    const { stdout } = await runHook({
      session_id: `hook-test-write-${session}`,
      tool_name: "mcp__gsheets-pro__sheets_write",
      tool_response: {
        content: [{ type: "text", text: "Wrote 3 rows." }],
        structuredContent: {
          check: { status: "errors_found", total_errors: 1, error_summary: { REF: 1 } },
        },
      },
    });
    const emitted = JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } };
    expect(emitted.hookSpecificOutput.additionalContext).toContain("That write came back with errors_found");
    expect(emitted.hookSpecificOutput.additionalContext).toContain("REF x1");
  });

  test("sheets_render is not a write and produces no nudge", async () => {
    const { stdout } = await runHook({
      session_id: `hook-test-render-${session}`,
      tool_name: "mcp__gsheets-pro__sheets_render",
      tool_response: { structuredContent: { mode: "local", pages: [] } },
    });
    expect(stdout).toBe("");
  });
});
