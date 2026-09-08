/**
 * The write ledger.
 *
 * It exists for one rule, and the things worth holding it to are the things
 * that would make that rule wrong: writes from another spreadsheet leaking in,
 * a write from two hours ago being reported as this session's, and the ledger
 * growing without limit on a long build.
 */

import { beforeEach, describe, expect, test } from "vitest";

import {
  MAX_WRITES_REMEMBERED,
  WRITE_MEMORY_MS,
  clearWrites,
  recordWrite,
  writeCount,
  writesFor,
} from "../src/lib/writelog.js";

const A = "1SpReAdShEeTaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const B = "1SpReAdShEeTbBbBbBbBbBbBbBbBbBbBbBbBbBbBb";

beforeEach(() => {
  clearWrites();
});

test("a write is remembered with the tab pulled out of its range", () => {
  recordWrite({ spreadsheetId: A, range: "'Roster'!D2:D40", tool: "sheets_write" });
  const writes = writesFor(A);
  expect(writes).toHaveLength(1);
  expect(writes[0].sheet).toBe("Roster");
  expect(writes[0].tool).toBe("sheets_write");
});

test("a bare range keeps the sheet the caller named", () => {
  recordWrite({ spreadsheetId: A, range: "D2:D40", sheet: "Roster" });
  expect(writesFor(A)[0].sheet).toBe("Roster");
});

test("another spreadsheet's writes are not this one's", () => {
  recordWrite({ spreadsheetId: A, range: "'Roster'!A1" });
  recordWrite({ spreadsheetId: B, range: "'Roster'!A1" });
  expect(writesFor(A)).toHaveLength(1);
});

test("writes can be narrowed to one tab, ignoring case", () => {
  recordWrite({ spreadsheetId: A, range: "'Roster'!A1" });
  recordWrite({ spreadsheetId: A, range: "'Settings'!B2" });
  expect(writesFor(A, { sheet: "roster" })).toHaveLength(1);
});

test("a write from before the window is forgotten rather than reported", () => {
  const now = Date.now();
  recordWrite({ spreadsheetId: A, range: "'Roster'!A1", at: now - WRITE_MEMORY_MS - 1 });
  recordWrite({ spreadsheetId: A, range: "'Roster'!A2", at: now });
  expect(writesFor(A, { now })).toHaveLength(1);
});

test("the ledger stops growing, keeping the newest", () => {
  for (let i = 0; i < MAX_WRITES_REMEMBERED + 50; i += 1) {
    recordWrite({ spreadsheetId: A, range: `'Roster'!A${i + 1}` });
  }
  expect(writeCount()).toBe(MAX_WRITES_REMEMBERED);
  const writes = writesFor(A);
  expect(writes[writes.length - 1].range).toBe(`'Roster'!A${MAX_WRITES_REMEMBERED + 50}`);
});

describe("what it refuses to record", () => {
  test("a call with no range or no spreadsheet is dropped rather than stored empty", () => {
    recordWrite({ spreadsheetId: A, range: "  " });
    recordWrite({ spreadsheetId: "", range: "'Roster'!A1" });
    expect(writeCount()).toBe(0);
  });

  test("a range that will not parse is still remembered by its text", () => {
    recordWrite({ spreadsheetId: A, range: "whatever this is" });
    expect(writesFor(A)[0].range).toBe("whatever this is");
  });
});
