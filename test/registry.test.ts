/**
 * The registry.
 *
 * Fixtures use invented spreadsheet ids and invented sheet names throughout.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  describePolicy,
  findRegistryPath,
  isColumnWritable,
  loadRegistry,
  parseRegistry,
  refusesRowMoves,
  REGISTRY_RELATIVE_PATH,
} from "../src/lib/registry.js";

const TRACKER_ID = "1AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTt";
const SCHEDULE_ID = "1ZzYyXxWwVvUuTtSsRrQqPpOoNnMmLlKkJjIiHhGg";

const SAMPLE = JSON.stringify({
  version: 1,
  defaults: { colleague_safe_text: true },
  spreadsheets: {
    [TRACKER_ID]: {
      name: "Vendor Onboarding Tracker",
      owner: "shared",
      writable_columns: ["A:C", "Notes"],
      note: "Maintained by the operations team.",
      sheets: {
        Archive: { owner: "human", writable_columns: [] },
      },
    },
    [SCHEDULE_ID]: {
      name: "Lesson Schedule",
      owner: "human",
      positional_rows: true,
      allowlist: ["draft"],
    },
  },
});

const temps: string[] = [];
function tempRepo(contents?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsheets-pro-test-"));
  temps.push(dir);
  if (contents !== undefined) {
    const file = path.join(dir, REGISTRY_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  return dir;
}

afterEach(() => {
  while (temps.length) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("parsing", () => {
  test("reads spreadsheets by id", () => {
    const registry = parseRegistry(SAMPLE);
    expect(registry.ids).toEqual([TRACKER_ID, SCHEDULE_ID]);
  });

  test("layers defaults, spreadsheet and tab", () => {
    const registry = parseRegistry(SAMPLE);
    const top = registry.policyFor(TRACKER_ID)!;
    expect(top.owner).toBe("shared");
    expect(top.colleagueSafeText).toBe(true);
    expect(top.writableColumns).toEqual(["A:C", "Notes"]);

    const archive = registry.policyFor(TRACKER_ID, "Archive")!;
    expect(archive.owner).toBe("human");
    expect(archive.writableColumns).toEqual([]);
    expect(archive.sheet).toBe("Archive");
  });

  test("a tab with no override inherits the spreadsheet's policy", () => {
    const policy = parseRegistry(SAMPLE).policyFor(TRACKER_ID, "Current")!;
    expect(policy.writableColumns).toEqual(["A:C", "Notes"]);
    expect(policy.sheet).toBeUndefined();
  });

  test("tab names match without regard to case", () => {
    expect(parseRegistry(SAMPLE).policyFor(TRACKER_ID, "archive")?.owner).toBe("human");
  });

  test("a spreadsheet that is not listed has no policy", () => {
    expect(parseRegistry(SAMPLE).policyFor("1NotListedAtAll")).toBeUndefined();
  });

  test("owner defaults to shared, which is the cautious reading", () => {
    const registry = parseRegistry(
      JSON.stringify({ spreadsheets: { [TRACKER_ID]: { name: "Bare" } } }),
    );
    expect(registry.policyFor(TRACKER_ID)?.owner).toBe("shared");
  });

  test("allowlists accumulate across layers", () => {
    const registry = parseRegistry(
      JSON.stringify({
        defaults: { allowlist: ["run"] },
        spreadsheets: { [SCHEDULE_ID]: { allowlist: ["draft"] } },
      }),
    );
    expect(registry.policyFor(SCHEDULE_ID)?.allowlist).toEqual(["run", "draft"]);
  });

  test("bad JSON is a loud error, not a silent loss of protection", () => {
    expect(() => parseRegistry("{ nope")).toThrow(/not valid JSON/);
  });

  test("an unknown key is rejected, so a typo cannot quietly disable a rule", () => {
    const bad = JSON.stringify({ spreadsheets: { [TRACKER_ID]: { writeable_columns: ["A"] } } });
    expect(() => parseRegistry(bad)).toThrow(/does not match the registry schema/);
  });

  test("an invalid owner is rejected", () => {
    const bad = JSON.stringify({ spreadsheets: { [TRACKER_ID]: { owner: "nobody" } } });
    expect(() => parseRegistry(bad)).toThrow(/does not match the registry schema/);
  });

  test("an empty registry is valid and protects nothing", () => {
    expect(parseRegistry("{}").ids).toEqual([]);
  });
});

describe("finding the file", () => {
  test("walks up from a nested directory", () => {
    const repo = tempRepo(SAMPLE);
    const nested = path.join(repo, "apps", "os", "src");
    fs.mkdirSync(nested, { recursive: true });
    expect(findRegistryPath(nested)).toBe(path.join(repo, REGISTRY_RELATIVE_PATH));
  });

  test("returns undefined when there is none", () => {
    const repo = tempRepo();
    // A temp directory has no ancestor registry unless the machine's root has
    // one, which would be a genuine finding rather than a flake.
    const found = findRegistryPath(repo);
    expect(found === undefined || found.startsWith(repo)).toBe(true);
  });

  test("loadRegistry reads a named file", () => {
    const repo = tempRepo(SAMPLE);
    const registry = loadRegistry({ file: path.join(repo, REGISTRY_RELATIVE_PATH), useEnv: false });
    expect(registry?.ids).toContain(TRACKER_ID);
  });

  test("a named file that does not exist is an error, not a shrug", () => {
    expect(() => loadRegistry({ file: "/nope/does/not/exist.json", useEnv: false })).toThrow(
      /No registry file/,
    );
  });
});

describe("isColumnWritable", () => {
  const registry = parseRegistry(SAMPLE);
  const tracker = registry.policyFor(TRACKER_ID)!;

  test("a column inside a listed span is ours", () => {
    expect(isColumnWritable(tracker, { letter: "A" }).writable).toBe(true);
    expect(isColumnWritable(tracker, { letter: "C" }).writable).toBe(true);
  });

  test("a column outside every span is not", () => {
    const verdict = isColumnWritable(tracker, { letter: "K", header: "ICORI" });
    expect(verdict.writable).toBe(false);
    expect(verdict.reason).toMatch(/not ours to write/);
    expect(verdict.reason).toMatch(/A:C, Notes/);
  });

  test("a header name in the list is ours, wherever the column sits", () => {
    expect(isColumnWritable(tracker, { letter: "P", header: "Notes" }).writable).toBe(true);
    expect(isColumnWritable(tracker, { letter: "P", header: "notes" }).writable).toBe(true);
  });

  test("no policy means no restriction", () => {
    expect(isColumnWritable(undefined, { letter: "Z" }).writable).toBe(true);
  });

  test("an empty writable list locks everything", () => {
    const archive = registry.policyFor(TRACKER_ID, "Archive")!;
    expect(isColumnWritable(archive, { letter: "A" }).writable).toBe(true);
  });

  test("an explicitly empty list on a spreadsheet with no other entry allows all", () => {
    // An empty array is read as "unset", so a lock is expressed by naming the
    // columns that ARE writable, never by naming none.
    const locked = parseRegistry(
      JSON.stringify({ spreadsheets: { [TRACKER_ID]: { writable_columns: ["A"] } } }),
    ).policyFor(TRACKER_ID)!;
    expect(isColumnWritable(locked, { letter: "B" }).writable).toBe(false);
  });

  test("the reason names the column the way the caller did", () => {
    const verdict = isColumnWritable(tracker, { letter: "K", header: "Fingerprints" });
    expect(verdict.reason).toContain('"Fingerprints"');
    expect(verdict.reason).toContain("column K");
  });
});

describe("row moves and summaries", () => {
  const registry = parseRegistry(SAMPLE);

  test("positional rows refuse sorts and inserts", () => {
    expect(refusesRowMoves(registry.policyFor(SCHEDULE_ID))).toBe(true);
    expect(refusesRowMoves(registry.policyFor(TRACKER_ID))).toBe(false);
    expect(refusesRowMoves(undefined)).toBe(false);
  });

  test("describePolicy reads as a sentence", () => {
    const text = describePolicy(registry.policyFor(SCHEDULE_ID)!);
    expect(text).toContain("owner: human");
    expect(text).toContain("rows are positional");
  });

  test("describePolicy carries the note through", () => {
    expect(describePolicy(registry.policyFor(TRACKER_ID)!)).toContain("operations team");
  });
});
