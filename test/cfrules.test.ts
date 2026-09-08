/**
 * Conditional format fingerprints.
 *
 * The point of a fingerprint is that it survives what an index does not: other
 * rules being added and deleted around it, and colours coming back from the API
 * as floats rather than as the hex that was sent.
 */
import { describe, expect, test } from "vitest";

import {
  buildCellFormat,
  canonicalColor,
  describeRule,
  fingerprintRule,
  isMatch,
  meaningFingerprint,
  meaningPartOf,
  resolveFingerprint,
  type CfRule,
} from "../src/lib/cfrules.js";
import { parseColorStyle } from "../src/lib/colors.js";

const overdue: CfRule = {
  ranges: [{ sheetId: 0, startRowIndex: 1, endRowIndex: 40, startColumnIndex: 4, endColumnIndex: 5 }],
  booleanRule: {
    condition: { type: "TEXT_EQ", values: [{ userEnteredValue: "Overdue" }] },
    format: { backgroundColorStyle: { rgbColor: { red: 0.96, green: 0.886, blue: 0.878 } } },
  },
};

const confirmed: CfRule = {
  ranges: [{ sheetId: 0, startRowIndex: 1, endRowIndex: 40, startColumnIndex: 4, endColumnIndex: 5 }],
  booleanRule: {
    condition: { type: "TEXT_EQ", values: [{ userEnteredValue: "Confirmed" }] },
    format: { backgroundColorStyle: { rgbColor: { red: 0.89, green: 0.941, blue: 0.914 } } },
  },
};

describe("canonical colour", () => {
  test("floats that round to the same byte fingerprint the same", () => {
    expect(canonicalColor({ rgbColor: { red: 0.09411765, green: 0, blue: 0 } })).toBe(
      canonicalColor({ rgbColor: { red: 0.094, green: 0, blue: 0 } }),
    );
  });

  test("a theme slot stays a slot rather than becoming hex", () => {
    expect(canonicalColor({ themeColor: "ACCENT1" })).toBe("theme:ACCENT1");
  });

  test("the API's older Color field is read too", () => {
    expect(canonicalColor(undefined, { red: 1, green: 1, blue: 1 })).toBe("#ffffff");
  });
});

describe("fingerprints", () => {
  test("are stable and distinct", () => {
    expect(fingerprintRule(overdue)).toBe(fingerprintRule({ ...overdue }));
    expect(fingerprintRule(overdue)).not.toBe(fingerprintRule(confirmed));
    expect(fingerprintRule(overdue)).toMatch(/^cf_[0-9a-f]{10}_[0-9a-f]{6}$/);
  });

  test("the meaning half survives the ranges changing", () => {
    const moved: CfRule = {
      ...overdue,
      ranges: [{ sheetId: 0, startRowIndex: 5, endRowIndex: 60, startColumnIndex: 4, endColumnIndex: 5 }],
    };
    expect(fingerprintRule(moved)).not.toBe(fingerprintRule(overdue));
    expect(meaningFingerprint(moved)).toBe(meaningFingerprint(overdue));
    expect(meaningPartOf(fingerprintRule(overdue))).toBe(meaningFingerprint(overdue));
  });
});

describe("resolving a fingerprint to an index", () => {
  const rules = [confirmed, overdue];

  test("an exact hit reports the index it found", () => {
    const found = resolveFingerprint(rules, fingerprintRule(overdue));
    expect(isMatch(found)).toBe(true);
    if (isMatch(found)) {
      expect(found.index).toBe(1);
      expect(found.match).toBe("exact");
    }
  });

  test("the index moves when a rule above is deleted, and the fingerprint still finds it", () => {
    const print = fingerprintRule(overdue);
    const after = resolveFingerprint([overdue], print);
    expect(isMatch(after)).toBe(true);
    if (isMatch(after)) expect(after.index).toBe(0);
  });

  test("a rule whose ranges shifted is found and reported as moved", () => {
    const moved: CfRule = {
      ...overdue,
      ranges: [{ sheetId: 0, startRowIndex: 1, endRowIndex: 90, startColumnIndex: 4, endColumnIndex: 5 }],
    };
    const found = resolveFingerprint([confirmed, moved], fingerprintRule(overdue));
    expect(isMatch(found)).toBe(true);
    if (isMatch(found)) {
      expect(found.index).toBe(1);
      expect(found.match).toBe("moved");
    }
  });

  test("a miss hands back every rule with its fingerprint", () => {
    const found = resolveFingerprint(rules, "cf_deadbeef00_abcdef");
    expect(isMatch(found)).toBe(false);
    if (!isMatch(found)) {
      expect(found.reason).toBe("not_found");
      expect(found.candidates).toHaveLength(2);
      expect(found.candidates[0].fingerprint).toBe(fingerprintRule(confirmed));
    }
  });

  test("two identical rules in different places are ambiguous rather than guessed at", () => {
    const elsewhere: CfRule = {
      ...overdue,
      ranges: [{ sheetId: 0, startRowIndex: 1, endRowIndex: 40, startColumnIndex: 7, endColumnIndex: 8 }],
    };
    const found = resolveFingerprint([overdue, elsewhere], meaningFingerprint(overdue));
    expect(isMatch(found)).toBe(false);
    if (!isMatch(found)) expect(found.reason).toBe("ambiguous");
  });
});

describe("building a format", () => {
  const resolve = (token: string) => parseColorStyle(token === "flag" ? "#F5E2E0" : token);

  test("only what the caller asked for is set", () => {
    expect(buildCellFormat({ bold: true }, resolve)).toEqual({ textFormat: { bold: true } });
    expect(buildCellFormat({ fill: "flag" }, resolve)?.backgroundColorStyle).toBeDefined();
    expect(buildCellFormat({}, resolve)).toBeUndefined();
  });
});

describe("describing a rule", () => {
  test("says where, what it paints, and when", () => {
    expect(describeRule(overdue)).toMatch(/E2:E40: fills #f5e2e0 when the text is Overdue/);
  });

  test("a gradient reads as a scale", () => {
    const gradient: CfRule = {
      ranges: [{ sheetId: 0, startRowIndex: 1, endRowIndex: 10, startColumnIndex: 1, endColumnIndex: 2 }],
      gradientRule: {
        minpoint: { type: "MIN", colorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } } },
        maxpoint: { type: "MAX", colorStyle: { themeColor: "ACCENT3" } },
      },
    };
    expect(describeRule(gradient)).toMatch(/colour scale from min #ffffff to max theme:ACCENT3/);
  });
});
