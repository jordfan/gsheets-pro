/**
 * The settings block layout and the names it gives things.
 *
 * A named range is what turns `$B$4 * D2` into `Fee_per_session * Sessions`, so
 * the naming rules matter more than they look: Sheets refuses a name that could
 * be read as a cell reference, and a duplicate name fails the whole batch.
 */
import { describe, expect, test } from "vitest";

import {
  isFormula,
  layoutSettingsBlock,
  looksLikeReference,
  sanitizeNamedRange,
  settingsRowValues,
  SETTINGS_HEADERS,
} from "../src/lib/settings.js";

describe("named range names", () => {
  test("a label becomes something a person still recognises", () => {
    expect(sanitizeNamedRange("Fee per session")).toBe("Fee_per_session");
    expect(sanitizeNamedRange("Sessions / term")).toBe("Sessions_term");
    expect(sanitizeNamedRange("  Aid split (%)  ")).toBe("Aid_split");
  });

  test("names Sheets would refuse are nudged rather than sent", () => {
    expect(sanitizeNamedRange("2026 rate")).toBe("_2026_rate");
    expect(sanitizeNamedRange("A1")).toBe("A1_");
    expect(sanitizeNamedRange("true")).toBe("true_");
    expect(looksLikeReference("R1C1")).toBe(true);
    expect(looksLikeReference("Fee")).toBe(false);
  });

  test("a name already in use gets a suffix instead of failing the batch", () => {
    const taken = new Set(["Fee_per_session"]);
    expect(sanitizeNamedRange("Fee per session", taken)).toBe("Fee_per_session_2");
  });

  test("an empty label is refused with a hint", () => {
    expect(() => sanitizeNamedRange("   ")).toThrowError(/needs a label/);
  });
});

describe("layout", () => {
  const items = [
    { label: "Fee per session", value: 55, unit: "dollars", source: "2026-27 agreement" },
    { label: "Sessions per term", value: 8, unit: "sessions" },
    { label: "Total", value: "=Fee_per_session*Sessions_per_term", format: "currency" as const },
  ];

  test("a titled block puts the header under the title and the rows under that", () => {
    const layout = layoutSettingsBlock(items, { title: "Assumptions" });
    expect(layout.titleRow).toBe(1);
    expect(layout.headerRow).toBe(2);
    expect(layout.firstDataRow).toBe(3);
    expect(layout.lastDataRow).toBe(5);
    expect(layout.blockA1).toBe("A2:D5");
    expect(layout.valueColumnA1).toBe("B3:B5");
    expect(layout.width).toBe(SETTINGS_HEADERS.length);
  });

  test("without a title the header is the first row", () => {
    const layout = layoutSettingsBlock(items);
    expect(layout.titleRow).toBeUndefined();
    expect(layout.headerRow).toBe(1);
    expect(layout.rows[0].valueA1).toBe("B2");
  });

  test("an anchor moves the whole block", () => {
    const layout = layoutSettingsBlock(items, { startRow: 4, startColumn: 2, title: "Assumptions" });
    expect(layout.blockA1).toBe("C5:F8");
    expect(layout.rows[0].valueA1).toBe("D6");
  });

  test("every row is named unless it asks not to be", () => {
    const layout = layoutSettingsBlock([
      { label: "Fee per session", value: 55 },
      { label: "Notes", value: "n/a", named: false },
      { label: "Fee per session", value: 65 },
    ]);
    expect(layout.rows.map((r) => r.namedRange)).toEqual([
      "Fee_per_session",
      undefined,
      "Fee_per_session_2",
    ]);
  });

  test("names already used elsewhere in the workbook are avoided", () => {
    const layout = layoutSettingsBlock([{ label: "Fee per session", value: 55 }], {
      taken: ["Fee_per_session"],
    });
    expect(layout.rows[0].namedRange).toBe("Fee_per_session_2");
  });

  test("an empty block is refused with an example", () => {
    expect(() => layoutSettingsBlock([])).toThrowError(/at least one row/);
  });
});

describe("row values", () => {
  test("come out in column order, gaps included", () => {
    expect(settingsRowValues({ label: "Fee", value: 55 })).toEqual(["Fee", 55, undefined, undefined]);
  });

  test("a leading equals sign marks a formula", () => {
    expect(isFormula("=SUM(B2:B4)")).toBe(true);
    expect(isFormula("55")).toBe(false);
    expect(isFormula(55)).toBe(false);
  });
});
