/**
 * The guard hook, spawned for real and fed the input the harness sends.
 *
 * The hook is the half of `read_only` that works before a single call goes
 * out, which is what makes it matter in a fresh clone: a cloud session that
 * has never opened the spreadsheet still refuses. Nothing type-checks the seam
 * between the harness and a .mjs file reading stdin, so these run the actual
 * process rather than importing a function out of it.
 *
 * All ids and names are invented.
 */
import { describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "gsheets-pro",
  "hooks",
  "guard.mjs",
);

const SPREADSHEET = "1SyNtH3t1cReAdOnLyIdAbCdEfGhIjKlMnOpQrStU";

/** A throwaway repo carrying one registry, which is all the hook reads. */
function repoWith(registry: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gsheets-guard-"));
  mkdirSync(path.join(dir, ".claude"), { recursive: true });
  writeFileSync(
    path.join(dir, ".claude", "gsheets-pro.json"),
    JSON.stringify({ spreadsheets: registry }),
    "utf8",
  );
  return dir;
}

interface HookResult {
  decision?: string;
  reason?: string;
  raw: string;
}

function runGuard(payload: Record<string, unknown>): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", reject);
    child.on("close", () => {
      if (!stdout.trim()) return resolve({ raw: "" });
      const parsed = JSON.parse(stdout) as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      };
      const out: HookResult = { raw: stdout };
      const decision = parsed.hookSpecificOutput?.permissionDecision;
      const reason = parsed.hookSpecificOutput?.permissionDecisionReason;
      if (decision) out.decision = decision;
      if (reason) out.reason = reason;
      resolve(out);
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

const call = (cwd: string, tool: string, input: Record<string, unknown>) =>
  runGuard({
    cwd,
    tool_name: `mcp__gsheets-pro__${tool}`,
    tool_input: { spreadsheet_id: SPREADSHEET, ...input },
    permission_mode: "default",
  });

describe("read_only in the guard hook", () => {
  const readOnly = repoWith({
    [SPREADSHEET]: {
      name: "Term Dates",
      owner: "human",
      read_only: true,
      note: "The calendar everything else quotes.",
    },
  });

  test("a write is stopped before it is sent, and the reason says why", async () => {
    const result = await call(readOnly, "sheets_write", { sheet: "Dates", range: "B2" });

    expect(result.decision).toBe("ask");
    expect(result.reason).toContain("read only");
    expect(result.reason).toContain("Term Dates");
    expect(result.reason).toContain("The calendar everything else quotes.");
  });

  test("it names the column list as the weaker statement, so the fix is not to add one", async () => {
    const result = await call(readOnly, "sheets_write", { sheet: "Dates", range: "B2" });
    expect(result.reason).toContain("stronger statement than a writable-column list");
  });

  test("every writing tool is covered, not only the ones that read columns", async () => {
    for (const tool of [
      "sheets_style",
      "sheets_table",
      "sheets_settings",
      "sheets_validation",
      "sheets_conditional_format",
      "sheets_structure",
      "sheets_batch",
    ]) {
      const result = await call(readOnly, tool, { sheet: "Dates" });
      expect(result.decision, `${tool} should have been stopped`).toBe("ask");
      expect(result.reason).toContain("read only");
    }
  });

  test("reading is not a write, so it passes without comment", async () => {
    for (const tool of ["sheets_read", "sheets_open", "sheets_check", "sheets_render"]) {
      const result = await call(readOnly, tool, { sheet: "Dates" });
      expect(result.raw, `${tool} should have been silent`).toBe("");
    }
  });

  test("force is how a person says they meant it", async () => {
    const result = await call(readOnly, "sheets_write", {
      sheet: "Dates",
      range: "B2",
      force: true,
    });
    expect(result.reason ?? "").not.toContain("read only");
  });

  test("an unattended run gets a denial rather than a question nobody can answer", async () => {
    const result = await runGuard({
      cwd: readOnly,
      tool_name: "mcp__gsheets-pro__sheets_write",
      tool_input: { spreadsheet_id: SPREADSHEET, sheet: "Dates", range: "B2" },
      permission_mode: "bypassPermissions",
    });
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("read only");
  });
});

describe("per-tab read_only in the guard hook", () => {
  const oneTab = repoWith({
    [SPREADSHEET]: {
      name: "Fall Enrichment",
      owner: "shared",
      sheets: { Archive: { read_only: true } },
    },
  });

  test("the locked tab is stopped", async () => {
    const result = await call(oneTab, "sheets_write", { sheet: "Archive", range: "B2" });
    expect(result.decision).toBe("ask");
    expect(result.reason).toContain("read only");
    expect(result.reason).toContain("tab Archive");
  });

  test("the rest of the workbook is not", async () => {
    const result = await call(oneTab, "sheets_write", { sheet: "Working", range: "B2" });
    expect(result.reason ?? "").not.toContain("read only");
  });

  test("tab names match without regard to case, as they do everywhere else", async () => {
    const result = await call(oneTab, "sheets_write", { sheet: "archive", range: "B2" });
    expect(result.reason).toContain("read only");
  });
});

describe("a spreadsheet the registry does not mark", () => {
  const ordinary = repoWith({ [SPREADSHEET]: { name: "Scratch", owner: "agent" } });

  test("is left alone", async () => {
    const result = await call(ordinary, "sheets_write", { sheet: "Roster", range: "B2" });
    expect(result.raw).toBe("");
  });

  test("and so is a spreadsheet with no entry at all", async () => {
    const result = await runGuard({
      cwd: ordinary,
      tool_name: "mcp__gsheets-pro__sheets_write",
      tool_input: { spreadsheet_id: "1AnOtHeRsPrEaDsHeEtIdNoBoDyWrOtEdOwN00", sheet: "Roster" },
      permission_mode: "default",
    });
    expect(result.raw).toBe("");
  });
});
