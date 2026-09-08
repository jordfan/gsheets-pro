/**
 * Colors, including the theme slots the old server had no concept of.
 */
import { describe, expect, test } from "vitest";

import {
  colorStyleToText,
  colorToHex,
  contrastRatio,
  isThemeSlotSpec,
  parseColor,
  parseColorStyle,
  parseThemeSlot,
  relativeLuminance,
  THEME_SLOTS,
} from "../src/lib/colors.js";

describe("literal colors", () => {
  test("hex parses to 0..1 floats", () => {
    expect(parseColor("#000000")).toEqual({ red: 0, green: 0, blue: 0 });
    expect(parseColor("#FFFFFF")).toEqual({ red: 1, green: 1, blue: 1 });
    expect(parseColor("ff0000")).toEqual({ red: 1, green: 0, blue: 0 });
    expect(parseColor("#f00")).toEqual({ red: 1, green: 0, blue: 0 });
  });

  test("named colors resolve, case and spacing insensitively", () => {
    expect(parseColor("white")).toEqual({ red: 1, green: 1, blue: 1 });
    expect(parseColor("BLACK")).toEqual({ red: 0, green: 0, blue: 0 });
    expect(parseColor("light gray")).toEqual(parseColor("lightgray"));
    expect(parseColor("lightgrey")).toEqual(parseColor("lightgray"));
  });

  test("a bad color throws and names the alternatives", () => {
    expect(() => parseColor("chartreuse")).toThrow(/Could not parse color/);
    expect(() => parseColor("#12345")).toThrow(/Could not parse color/);
    expect(() => parseColor("")).toThrow(/Could not parse color/);
  });

  test("colorToHex round trips", () => {
    expect(colorToHex(parseColor("#3d85c6"))).toBe("#3d85c6");
    expect(colorToHex({})).toBe("#000000");
  });
});

describe("theme slots", () => {
  test("every documented slot is recognised", () => {
    for (const slot of THEME_SLOTS) {
      expect(parseThemeSlot(`theme:${slot}`)).toBe(slot);
    }
  });

  test("the prefix is optional and the spelling is forgiving", () => {
    expect(parseThemeSlot("ACCENT1")).toBe("ACCENT1");
    expect(parseThemeSlot("theme:accent1")).toBe("ACCENT1");
    expect(parseThemeSlot("theme.accent 1")).toBe("ACCENT1");
    expect(parseThemeSlot("Theme: link")).toBe("LINK");
    expect(isThemeSlotSpec("theme:BACKGROUND")).toBe(true);
  });

  test("a slot that does not exist is not a slot", () => {
    expect(parseThemeSlot("theme:ACCENT7")).toBeUndefined();
    expect(parseThemeSlot("#ff0000")).toBeUndefined();
    expect(isThemeSlotSpec("periwinkle")).toBe(false);
  });

  test("parseColorStyle picks the right half of the union", () => {
    expect(parseColorStyle("theme:ACCENT1")).toEqual({ themeColor: "ACCENT1" });
    expect(parseColorStyle("#ff0000")).toEqual({ rgbColor: { red: 1, green: 0, blue: 0 } });
    expect(parseColorStyle("lightblue").rgbColor).toBeDefined();
  });

  test("a slot passed where only literal RGB fits says so", () => {
    expect(() => parseColor("theme:ACCENT1")).toThrow(/theme slot/);
  });

  test("colorStyleToText names the slot rather than resolving it", () => {
    expect(colorStyleToText({ themeColor: "ACCENT2" })).toBe("theme:ACCENT2");
    expect(colorStyleToText({ rgbColor: { red: 1, green: 0, blue: 0 } })).toBe("#ff0000");
    expect(colorStyleToText(null)).toBeUndefined();
    expect(colorStyleToText({})).toBeUndefined();
  });
});

describe("contrast, for the preset validator", () => {
  test("black on white is the maximum", () => {
    const ratio = contrastRatio(parseColor("#000000"), parseColor("#ffffff"));
    expect(ratio).toBeCloseTo(21, 5);
  });

  test("a color against itself is 1", () => {
    expect(contrastRatio(parseColor("#187054"), parseColor("#187054"))).toBeCloseTo(1, 5);
  });

  test("the order of the arguments does not matter", () => {
    const a = parseColor("#187054");
    const b = parseColor("#fafaf8");
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });

  test("a dark green header on an off white ground clears 4.5 to 1", () => {
    expect(contrastRatio(parseColor("#ffffff"), parseColor("#187054"))).toBeGreaterThan(4.5);
  });

  test("a light amber on white does not clear it", () => {
    expect(contrastRatio(parseColor("#ffffff"), parseColor("#febf3e"))).toBeLessThan(4.5);
  });

  test("luminance is monotonic", () => {
    expect(relativeLuminance(parseColor("#000000"))).toBe(0);
    expect(relativeLuminance(parseColor("#ffffff"))).toBeCloseTo(1, 10);
    expect(relativeLuminance(parseColor("#808080"))).toBeGreaterThan(0);
  });
});
