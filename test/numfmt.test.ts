import { describe, expect, test } from "vitest";

import {
  describeNumberFormat,
  NUMBER_FORMAT_SHORTHANDS,
  resolveNumberFormat,
} from "../src/lib/numfmt.js";

describe("shorthands", () => {
  test("expand to a type and a pattern", () => {
    expect(resolveNumberFormat("currency")).toEqual({ type: "CURRENCY", pattern: '"$"#,##0.00' });
    expect(resolveNumberFormat("percent").type).toBe("PERCENT");
    expect(resolveNumberFormat("DATE").type).toBe("DATE");
    expect(resolveNumberFormat("integer").pattern).toBe("#,##0");
    expect(resolveNumberFormat("text")).toEqual({ type: "TEXT", pattern: "@" });
  });

  test("spelling is forgiving", () => {
    expect(resolveNumberFormat("Date Time")).toEqual(resolveNumberFormat("datetime"));
    expect(resolveNumberFormat("date_time")).toEqual(resolveNumberFormat("datetime"));
  });

  test("every shorthand resolves to itself", () => {
    for (const name of NUMBER_FORMAT_SHORTHANDS) {
      const resolved = resolveNumberFormat(name);
      expect(resolved.type).toBeTruthy();
      expect(resolved.pattern).toBeTruthy();
    }
  });

  test("the result is a copy, so a caller cannot mutate the table", () => {
    const first = resolveNumberFormat("currency");
    first.pattern = "wrecked";
    expect(resolveNumberFormat("currency").pattern).toBe('"$"#,##0.00');
  });
});

describe("literal patterns", () => {
  test("keep their pattern and get an inferred type", () => {
    expect(resolveNumberFormat("#,##0.00")).toEqual({ type: "NUMBER", pattern: "#,##0.00" });
    expect(resolveNumberFormat("$#,##0")).toEqual({ type: "CURRENCY", pattern: "$#,##0" });
    expect(resolveNumberFormat("0%")).toEqual({ type: "PERCENT", pattern: "0%" });
    expect(resolveNumberFormat("yyyy-mm-dd")).toEqual({ type: "DATE", pattern: "yyyy-mm-dd" });
    expect(resolveNumberFormat("yyyy-mm-dd hh:mm").type).toBe("DATE_TIME");
    expect(resolveNumberFormat("[h]:mm:ss").type).toBe("TIME");
  });

  test("text inside quotes does not confuse the inference", () => {
    // The "d" in "days" would otherwise read as a date token.
    expect(resolveNumberFormat('#,##0" days"').type).toBe("NUMBER");
  });

  test("an empty format is an error", () => {
    expect(() => resolveNumberFormat("")).toThrow(/Could not parse number format/);
    expect(() => resolveNumberFormat("   ")).toThrow(/Could not parse number format/);
  });
});

describe("describeNumberFormat", () => {
  test("names a shorthand when one matches", () => {
    expect(describeNumberFormat({ type: "CURRENCY", pattern: '"$"#,##0.00' })).toBe("currency");
    expect(describeNumberFormat({ type: "TEXT", pattern: "@" })).toBe("text");
  });

  test("falls back to the pattern", () => {
    expect(describeNumberFormat({ type: "NUMBER", pattern: "0.000" })).toBe("0.000");
  });

  test("absent means absent", () => {
    expect(describeNumberFormat(null)).toBeUndefined();
    expect(describeNumberFormat({})).toBeUndefined();
  });
});
