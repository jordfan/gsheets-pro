/**
 * Every tool call written in the skill's documentation must be a call the
 * server would actually accept.
 *
 * The worked examples are what SKILL.md tells the model to read before its
 * first build of that shape, so a call in one that would not execute is a
 * direct cost: the model copies it, the server rejects it, and the run spends
 * its recovery budget on a mistake the docs made. Three such calls shipped
 * before this test existed, and checking the rest turned up four more.
 *
 * The schemas come from the tool registry rather than a hand-written list, so
 * a new tool is covered the day it is registered and a renamed parameter fails
 * here rather than in front of a user.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { ZodRawShape } from "zod";

import { createTools } from "../src/tools/index.js";
import type { Context } from "../src/lib/client.js";

// The factories only build descriptors here; nothing calls getContext, which is
// the same shortcut toolNames() in server.ts takes.
const TOOLS = new Map(
  createTools({ getContext: async () => ({}) as Context }).map((tool) => [
    tool.name,
    z.object(tool.config.inputSchema as ZodRawShape),
  ]),
);

const url = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

const EXAMPLES_DIR = url("../plugins/gsheets-pro/skills/gsheets-pro/examples/");
const REFERENCES_DIR = url("../plugins/gsheets-pro/skills/gsheets-pro/references/");

/** Every markdown file that may quote a tool call. */
function documentationFiles(): Array<{ label: string; path: string }> {
  const files: Array<{ label: string; path: string }> = [
    { label: "skills/gsheets-pro/SKILL.md", path: url("../plugins/gsheets-pro/skills/gsheets-pro/SKILL.md") },
    { label: "skills/setup/SKILL.md", path: url("../plugins/gsheets-pro/skills/setup/SKILL.md") },
    { label: "skills/review/SKILL.md", path: url("../plugins/gsheets-pro/skills/review/SKILL.md") },
    { label: "agents/sheet-reviewer.md", path: url("../plugins/gsheets-pro/agents/sheet-reviewer.md") },
  ];
  for (const [dir, prefix] of [
    [EXAMPLES_DIR, "examples"],
    [REFERENCES_DIR, "references"],
  ] as const) {
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith(".md")) files.push({ label: `${prefix}/${name}`, path: `${dir}${name}` });
    }
  }
  return files;
}

interface DocumentedCall {
  file: string;
  /** 1 based, counted within the file, so a failure names something findable. */
  index: number;
  tool: string;
  json: string;
}

/**
 * Pull the tool calls out of one markdown file.
 *
 * A call is a ```json fence whose body opens with a tool name and a brace.
 * That rule is deliberately narrow: the same files carry fenced JSON that is a
 * tool *response*, a lint report, and a registry file, and none of those open
 * with `sheets_`. Anything that does open that way is a call and is checked, so
 * the way to add a documented call is also the way to get it verified.
 */
function extractCalls(label: string, source: string): DocumentedCall[] {
  const calls: DocumentedCall[] = [];
  const fences = source.matchAll(/^```json\n([\s\S]*?)\n```$/gm);
  let index = 0;
  for (const fence of fences) {
    const body = fence[1];
    const opener = /^(sheets_[a-z_]+)\s*(\{[\s\S]*)$/.exec(body.trim());
    if (!opener) continue;
    index += 1;
    calls.push({ file: label, index, tool: opener[1], json: opener[2] });
  }
  return calls;
}

/**
 * Keys present in the input that zod dropped, at any depth.
 *
 * Zod strips what a schema does not declare rather than complaining, so a
 * misspelled or invented parameter parses cleanly and the doc looks fine. This
 * compares the input against what came back and reports anything that vanished.
 * Records keep arbitrary keys, so a free-form map like status_colors does not
 * produce false positives, and defaults only ever add keys, which are ignored.
 *
 * This is the check that catches the interesting class of error. A wrong *type*
 * fails zod outright; a wrong *name* is silent, and both of the parameter bugs
 * this test was written for were wrong names, one of them nested inside an
 * array of column definitions.
 */
function droppedKeys(input: unknown, parsed: unknown, path: string[] = []): string[] {
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

  if (Array.isArray(input) && Array.isArray(parsed)) {
    return input.flatMap((item, i) => droppedKeys(item, parsed[i], [...path, String(i)]));
  }
  if (isPlainObject(input) && isPlainObject(parsed)) {
    return Object.entries(input).flatMap(([key, value]) =>
      key in parsed ? droppedKeys(value, parsed[key], [...path, key]) : [[...path, key].join(".")],
    );
  }
  return [];
}

// The prose says spreadsheet_id is on every call and elides it after the first,
// to keep the shapes readable. Supply one so the rest of the call is what gets
// judged.
const ELIDED_SPREADSHEET_ID = "1EXAMPLEsyntheticSpreadsheetIdForTests0001";

const ALL_CALLS = documentationFiles().flatMap(({ label, path }) =>
  extractCalls(label, readFileSync(path, "utf8")),
);

describe("documented tool calls", () => {
  test("the extractor finds the calls the examples are made of", () => {
    // A regression here means the extractor stopped matching, which would make
    // every other assertion below pass by finding nothing.
    expect(ALL_CALLS.length).toBeGreaterThanOrEqual(40);
    for (const example of ["examples/roster-tracker.md", "examples/budget.md"]) {
      expect(ALL_CALLS.filter((c) => c.file === example).length).toBeGreaterThanOrEqual(15);
    }
  });

  test("every documented call names a registered tool", () => {
    const unknown = ALL_CALLS.filter((c) => !TOOLS.has(c.tool)).map(
      (c) => `${c.file} call ${c.index}: ${c.tool}`,
    );
    expect(unknown).toEqual([]);
  });

  test.each(ALL_CALLS.map((c) => [`${c.file} call ${c.index} (${c.tool})`, c] as const))(
    "%s",
    (_label, call) => {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.json) as Record<string, unknown>;
      } catch (error) {
        throw new Error(
          `${call.file} call ${call.index} (${call.tool}) is not valid JSON: ` +
            `${(error as Error).message}\n${call.json}`,
        );
      }

      if (!("spreadsheet_id" in args)) args.spreadsheet_id = ELIDED_SPREADSHEET_ID;

      const schema = TOOLS.get(call.tool);
      if (!schema) throw new Error(`${call.file} call ${call.index}: no tool named ${call.tool}`);

      const result = schema.safeParse(args);
      if (!result.success) {
        const issues = result.error.issues
          .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("\n");
        throw new Error(
          `${call.file} call ${call.index} (${call.tool}) does not match the tool's schema:\n${issues}`,
        );
      }

      const dropped = droppedKeys(args, result.data);
      if (dropped.length > 0) {
        throw new Error(
          `${call.file} call ${call.index} (${call.tool}) passes parameters the tool does not accept: ` +
            `${dropped.join(", ")}.\n` +
            `Check the tool's input schema in src/tools/. A parameter the schema does not declare is ` +
            `dropped silently, so this reads as working and would not.`,
        );
      }
    },
  );
});
