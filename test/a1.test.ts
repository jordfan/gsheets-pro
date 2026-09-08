/**
 * A1 notation and GridRange conversion.
 *
 * Ported from the earlier internal server's offline suite, extended for quoted
 * tab names (the case the old `lastIndexOf("!")` split got wrong) and for the
 * range union that closes a write.
 */
import { describe, expect, test } from "vitest";

import {
  a1ToGridRange,
  columnIndexToLetter,
  columnLetterToIndex,
  gridRangeToA1,
  parseA1,
  parseColumnSpan,
  parseRowSpan,
  pluralize,
  quoteSheetName,
  rangeCellCount,
  splitSheetRange,
  stripSheetPrefix,
  toA1Reference,
  unionBounds,
} from "../src/lib/a1.js";

describe("parseA1", () => {
  test("a single cell is a one by one range", () => {
    expect(parseA1("A1")).toEqual({
      startColumnIndex: 0,
      endColumnIndex: 1,
      startRowIndex: 0,
      endRowIndex: 1,
    });
  });

  test("A1:C10 bounds both axes, half open", () => {
    expect(parseA1("A1:C10")).toEqual({
      startColumnIndex: 0,
      endColumnIndex: 3,
      startRowIndex: 0,
      endRowIndex: 10,
    });
  });

  test("B:B is a whole column, leaving rows unbounded", () => {
    expect(parseA1("B:B")).toEqual({ startColumnIndex: 1, endColumnIndex: 2 });
  });

  test("3:3 is a whole row, leaving columns unbounded", () => {
    expect(parseA1("3:3")).toEqual({ startRowIndex: 2, endRowIndex: 3 });
  });

  test("two letter columns work", () => {
    expect(parseA1("AA1:AB2")).toEqual({
      startColumnIndex: 26,
      endColumnIndex: 28,
      startRowIndex: 0,
      endRowIndex: 2,
    });
  });

  test("a reversed range is normalized", () => {
    expect(parseA1("C10:A1")).toEqual({
      startColumnIndex: 0,
      endColumnIndex: 3,
      startRowIndex: 0,
      endRowIndex: 10,
    });
  });

  test("a half open range bounds only the side it names", () => {
    expect(parseA1("A2:C")).toEqual({
      startColumnIndex: 0,
      endColumnIndex: 3,
      startRowIndex: 1,
    });
  });

  test("dollar signs and a sheet prefix are tolerated", () => {
    expect(parseA1("'My Sheet'!$A$1:$B$2")).toEqual({
      startColumnIndex: 0,
      endColumnIndex: 2,
      startRowIndex: 0,
      endRowIndex: 2,
    });
  });

  test("bad input throws with a usable message", () => {
    expect(() => parseA1("banana split")).toThrow(/Could not parse A1 range/);
    expect(() => parseA1("1A")).toThrow(/Could not parse A1 range/);
    expect(() => parseA1("")).toThrow(/empty/);
    expect(() => parseA1("A1:B2:C3")).toThrow(/Too many/);
    expect(() => parseA1("A0")).toThrow(/start at 1/);
  });
});

describe("sheet qualifiers", () => {
  test("an unquoted tab name splits off", () => {
    expect(splitSheetRange("Tracker!A1:C10")).toEqual({ sheet: "Tracker", range: "A1:C10" });
    expect(stripSheetPrefix("Tracker!A1")).toBe("A1");
  });

  test("a quoted tab name with spaces splits off", () => {
    expect(splitSheetRange("'My Sheet'!A1:B2")).toEqual({ sheet: "My Sheet", range: "A1:B2" });
  });

  test("a quoted tab name containing an exclamation mark is not cut at the wrong place", () => {
    // The naive lastIndexOf("!") split returns "Draft'" as the tab here.
    expect(splitSheetRange("'Q1!Draft'!A1:B2")).toEqual({ sheet: "Q1!Draft", range: "A1:B2" });
  });

  test("a quoted tab name containing a colon keeps its colon", () => {
    expect(splitSheetRange("'Notes: 2026'!A1")).toEqual({ sheet: "Notes: 2026", range: "A1" });
  });

  test("a doubled apostrophe unescapes to one", () => {
    expect(splitSheetRange("'Ana''s tab'!A1")).toEqual({ sheet: "Ana's tab", range: "A1" });
  });

  test("a bare tab name has no range", () => {
    expect(splitSheetRange("Tracker")).toEqual({ range: "Tracker" });
    expect(splitSheetRange("'My Sheet'")).toEqual({ sheet: "My Sheet", range: "" });
  });

  test("an unbalanced quote is an error, not a silent misparse", () => {
    expect(() => splitSheetRange("'My Sheet!A1")).toThrow(/Unbalanced quote/);
  });

  test("quoting round trips through the parser", () => {
    const name = "Ana's Q1!Notes";
    const reference = toA1Reference(name, "A1:C3");
    expect(reference).toBe("'Ana''s Q1!Notes'!A1:C3");
    expect(splitSheetRange(reference)).toEqual({ sheet: name, range: "A1:C3" });
  });

  test("quoteSheetName doubles apostrophes", () => {
    expect(quoteSheetName("Ana's tab")).toBe("'Ana''s tab'");
  });

  test("a tab name alone renders without a bang", () => {
    expect(toA1Reference("Tracker")).toBe("'Tracker'");
  });
});

describe("columns, spans and round trips", () => {
  test("column letters convert both ways", () => {
    expect(columnLetterToIndex("A")).toBe(0);
    expect(columnLetterToIndex("Z")).toBe(25);
    expect(columnLetterToIndex("AA")).toBe(26);
    expect(columnLetterToIndex("ab")).toBe(27);
    expect(columnIndexToLetter(0)).toBe("A");
    expect(columnIndexToLetter(25)).toBe("Z");
    expect(columnIndexToLetter(26)).toBe("AA");
    expect(columnIndexToLetter(27)).toBe("AB");
    expect(() => columnLetterToIndex("A1")).toThrow(/Not a column letter/);
  });

  test("gridRangeToA1 round trips the shapes the tools emit", () => {
    expect(gridRangeToA1(parseA1("A1"))).toBe("A1");
    expect(gridRangeToA1(parseA1("A1:C10"))).toBe("A1:C10");
    expect(gridRangeToA1(parseA1("B:B"))).toBe("B:B");
    expect(gridRangeToA1(parseA1("3:3"))).toBe("3:3");
    expect(gridRangeToA1(parseA1("AA1:AB2"))).toBe("AA1:AB2");
    expect(gridRangeToA1({})).toBe("the whole sheet");
  });

  test("a1ToGridRange stamps the sheetId, and no range means the whole tab", () => {
    expect(a1ToGridRange("A1:B2", 42)).toEqual({
      sheetId: 42,
      startColumnIndex: 0,
      endColumnIndex: 2,
      startRowIndex: 0,
      endRowIndex: 2,
    });
    expect(a1ToGridRange(undefined, 7)).toEqual({ sheetId: 7 });
    expect(a1ToGridRange("  ", 7)).toEqual({ sheetId: 7 });
  });

  test("column and row spans parse single entries and ranges", () => {
    expect(parseColumnSpan("A")).toEqual({ startIndex: 0, endIndex: 1 });
    expect(parseColumnSpan("B:D")).toEqual({ startIndex: 1, endIndex: 4 });
    expect(parseColumnSpan("D:B")).toEqual({ startIndex: 1, endIndex: 4 });
    expect(parseRowSpan("1")).toEqual({ startIndex: 0, endIndex: 1 });
    expect(parseRowSpan("2:5")).toEqual({ startIndex: 1, endIndex: 5 });
    expect(() => parseColumnSpan("1")).toThrow(/Could not parse column span/);
    expect(() => parseRowSpan("A")).toThrow(/Could not parse row span/);
  });

  test("rangeCellCount is undefined when an axis is unbounded", () => {
    expect(rangeCellCount(parseA1("A1:C10"))).toBe(30);
    expect(rangeCellCount(parseA1("A1"))).toBe(1);
    expect(rangeCellCount(parseA1("B:B"))).toBeUndefined();
  });

  test("nulls from the API read as absent", () => {
    expect(gridRangeToA1({ startRowIndex: null, endRowIndex: null })).toBe("the whole sheet");
    expect(rangeCellCount({ startRowIndex: 0, endRowIndex: null })).toBeUndefined();
  });
});

describe("unionBounds", () => {
  test("covers both inputs", () => {
    expect(unionBounds(parseA1("A1:B2"), parseA1("C3:D4"))).toEqual({
      startRowIndex: 0,
      endRowIndex: 4,
      startColumnIndex: 0,
      endColumnIndex: 4,
    });
  });

  test("an unbounded axis swallows the other side", () => {
    expect(unionBounds(parseA1("B:B"), parseA1("A1:C10"))).toEqual({
      startColumnIndex: 0,
      endColumnIndex: 3,
    });
  });
});

test("pluralize", () => {
  expect(pluralize(1, "request")).toBe("1 request");
  expect(pluralize(3, "request")).toBe("3 requests");
  expect(pluralize(2, "entry", "entries")).toBe("2 entries");
});
