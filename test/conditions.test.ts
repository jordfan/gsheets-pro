/**
 * The condition vocabulary: the words a caller uses, and the API types they
 * become. The interesting cases are the four operators that read the same for
 * a number, a date and a string.
 */
import { describe, expect, test } from "vitest";

import { buildCondition, describeCondition, resolveKind } from "../src/lib/conditions.js";

describe("kind inference", () => {
  test("an operator that only makes sense one way fixes the kind", () => {
    expect(resolveKind({ operator: "contains", value: "42" })).toBe("text");
    expect(resolveKind({ operator: "after", value: "2026-09-07" })).toBe("date");
  });

  test("an ambiguous operator reads the value", () => {
    expect(resolveKind({ operator: "equal", value: 40 })).toBe("number");
    expect(resolveKind({ operator: "equal", value: "40" })).toBe("number");
    expect(resolveKind({ operator: "equal", value: "Confirmed" })).toBe("text");
    expect(resolveKind({ operator: "equal", value: "2026-09-07" })).toBe("date");
    expect(resolveKind({ operator: "equal", value: "today" })).toBe("date");
  });

  test("an explicit kind wins over the guess", () => {
    expect(resolveKind({ operator: "equal", kind: "text", value: "40" })).toBe("text");
  });
});

describe("building conditions", () => {
  test("numbers", () => {
    expect(buildCondition({ operator: "greater_than", value: 40 })).toEqual({
      type: "NUMBER_GREATER",
      values: [{ userEnteredValue: "40" }],
    });
    expect(buildCondition({ operator: "between", value: 1, value2: 10 })).toEqual({
      type: "NUMBER_BETWEEN",
      values: [{ userEnteredValue: "1" }, { userEnteredValue: "10" }],
    });
  });

  test("text", () => {
    expect(buildCondition({ operator: "contains", value: "overdue" })).toEqual({
      type: "TEXT_CONTAINS",
      values: [{ userEnteredValue: "overdue" }],
    });
    expect(buildCondition({ operator: "is_email" })).toEqual({ type: "TEXT_IS_EMAIL" });
  });

  test("dates, including the relative ones", () => {
    expect(buildCondition({ operator: "before", value: "2026-09-07" })).toEqual({
      type: "DATE_BEFORE",
      values: [{ userEnteredValue: "2026-09-07" }],
    });
    expect(buildCondition({ operator: "after", value: "today" })).toEqual({
      type: "DATE_AFTER",
      values: [{ relativeDate: "TODAY" }],
    });
  });

  test("lists, ranges, blanks, checkboxes and formulas", () => {
    expect(buildCondition({ operator: "one_of_list", values: ["A", "B"] })).toEqual({
      type: "ONE_OF_LIST",
      values: [{ userEnteredValue: "A" }, { userEnteredValue: "B" }],
    });
    expect(buildCondition({ operator: "one_of_range", source_range: "Lists!A2:A9" })).toEqual({
      type: "ONE_OF_RANGE",
      values: [{ userEnteredValue: "=Lists!A2:A9" }],
    });
    expect(buildCondition({ operator: "blank" })).toEqual({ type: "BLANK" });
    expect(buildCondition({ operator: "checkbox" })).toEqual({ type: "BOOLEAN" });
    expect(buildCondition({ operator: "custom_formula", formula: "$D2>0" })).toEqual({
      type: "CUSTOM_FORMULA",
      values: [{ userEnteredValue: "=$D2>0" }],
    });
  });

  test("a missing piece is refused with a hint that says what to pass", () => {
    expect(() => buildCondition({ operator: "one_of_list", values: [] })).toThrowError(/needs the list/);
    expect(() => buildCondition({ operator: "between", value: 1 })).toThrowError(/second value/);
    expect(() => buildCondition({ operator: "greater_than" })).toThrowError(/needs a value/);
    expect(() => buildCondition({ operator: "custom_formula" })).toThrowError(/needs a formula/);
  });

  test("an operator that does not apply to the kind lists the ones that do", () => {
    // An operator with a fixed kind ignores the caller's kind rather than
    // failing: contains is text, whatever the caller says.
    expect(buildCondition({ operator: "contains", kind: "number", value: "x" }).type).toBe(
      "TEXT_CONTAINS",
    );
    // A genuine mismatch does fail, and the hint lists what would work.
    expect(() => buildCondition({ operator: "between", kind: "text", value: 1, value2: 2 })).toThrowError(
      /does not apply to a text/,
    );
    try {
      buildCondition({ operator: "between", kind: "text", value: 1, value2: 2 });
    } catch (error) {
      expect((error as { hint?: string }).hint).toMatch(/contains/);
    }
  });
});

describe("describing conditions", () => {
  test("reads like a person saying it out loud", () => {
    expect(describeCondition(buildCondition({ operator: "greater_than", value: 40 }))).toBe(
      "the number is greater than 40",
    );
    expect(describeCondition(buildCondition({ operator: "equal", kind: "text", value: "Overdue" }))).toBe(
      "the text is Overdue",
    );
    expect(describeCondition(buildCondition({ operator: "one_of_list", values: ["A", "B"] }))).toMatch(
      /one of 2 options/,
    );
    expect(describeCondition(undefined)).toBe("no condition");
  });
});
