/**
 * Presets and colour resolution. Every value here comes from the shipped
 * preset files, so a change to those that breaks a role is caught offline.
 */
import { describe, expect, test } from "vitest";

import {
  availablePresets,
  DEFAULT_PRESET,
  loadPreset,
  numberFormatForColumnType,
  numberFormatForSettings,
  parsePreset,
  resolveFill,
  resolveMutedText,
  resolveHeaderText,
  resolveInputText,
  tableRowsProperties,
} from "../src/lib/tablecolors.js";

describe("loading presets", () => {
  test("the shipped presets all load", () => {
    const names = availablePresets();
    expect(names).toContain(DEFAULT_PRESET);
    for (const name of names) {
      const preset = loadPreset(name);
      expect(preset.name).toBe(name);
      expect(preset.roles.header.fill).toBeTruthy();
    }
  });

  test("an unknown preset says which ones exist", () => {
    expect(() => loadPreset("mauve")).toThrowError(/No preset named "mauve"/);
    try {
      loadPreset("mauve");
    } catch (error) {
      expect((error as { hint?: string }).hint).toMatch(/presets on this host/);
    }
  });

  test("a preset missing a theme slot is refused by name", () => {
    const broken = { ...loadPreset(DEFAULT_PRESET), theme: { TEXT: "#000000" } };
    expect(() => parsePreset(broken, "broken")).toThrowError(/theme.BACKGROUND/);
  });
});

describe("resolving a fill", () => {
  const preset = loadPreset(DEFAULT_PRESET);

  test("a role that names a theme slot compiles to themeColor", () => {
    // The header fill is ACCENT1 in the neutral preset, and staying a slot is
    // what keeps Format > Theme working as the human's knob.
    expect(resolveFill(preset, "header")).toEqual({ themeColor: "ACCENT1" });
  });

  test("a role that names a hex compiles to rgbColor", () => {
    const band2 = resolveFill(preset, "band2");
    expect(band2.themeColor).toBeUndefined();
    expect(band2.rgbColor?.red).toBeGreaterThan(0.9);
  });

  test("a caller may pass a theme slot or a hex directly", () => {
    expect(resolveFill(preset, "theme:ACCENT3")).toEqual({ themeColor: "ACCENT3" });
    expect(resolveFill(preset, "#102030").rgbColor).toBeDefined();
  });

  test("the muted role resolves to a fill, never to the muted text colour", () => {
    // The defect: these were one value. resolveFill("muted") handed back
    // #6B7770 on park, a text colour, and a golden render came out with three
    // status rows of dark text on a dark ground.
    const park = loadPreset("park");
    const fill = resolveFill(park, "muted");
    const text = resolveMutedText(park);
    expect(fill).not.toEqual(text);
    expect(fill.rgbColor?.red).toBeGreaterThan(0.9);
  });

  test("every preset keeps its fill and its text colour apart", () => {
    for (const name of availablePresets()) {
      const preset = loadPreset(name);
      expect(resolveFill(preset, "muted"), `${name} paints muted with its text colour`).not.toEqual(
        resolveMutedText(preset),
      );
    }
  });

  test("nonsense names the roles in the hint", () => {
    try {
      resolveFill(preset, "chartreuse");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as { hint?: string }).hint).toMatch(/ok, warn, flag, muted/);
    }
  });

  test("header text and input colours resolve", () => {
    expect(resolveHeaderText(preset)).toEqual({ themeColor: "BACKGROUND" });
    expect(resolveInputText(preset)?.rgbColor).toBeDefined();
  });
});

describe("table colours", () => {
  const preset = loadPreset(DEFAULT_PRESET);

  test("a Table gets a header and two bands, and never a footer", () => {
    const rows = tableRowsProperties(preset);
    expect(Object.keys(rows).sort()).toEqual([
      "firstBandColorStyle",
      "headerColorStyle",
      "secondBandColorStyle",
    ]);
    // footerColorStyle converts the last data row into a footer and overwrites
    // it with SUM formulas (spike 3). It must never appear here.
    expect(JSON.stringify(rows)).not.toContain("footer");
  });

  test("the preset schema offers no footer role to reach for", () => {
    expect(Object.keys(preset.roles)).not.toContain("footer");
  });
});

describe("number formats", () => {
  const preset = loadPreset(DEFAULT_PRESET);

  test("column types map to the preset's patterns", () => {
    expect(numberFormatForColumnType(preset, "CURRENCY")).toEqual({
      type: "CURRENCY",
      pattern: preset.numbers.currency,
    });
    expect(numberFormatForColumnType(preset, "DATE")?.pattern).toBe(preset.numbers.date);
    expect(numberFormatForColumnType(preset, "TEXT")).toBeUndefined();
    expect(numberFormatForColumnType(preset, undefined)).toBeUndefined();
  });

  test("settings formats map too, and text carries none", () => {
    expect(numberFormatForSettings(preset, "percent")?.type).toBe("PERCENT");
    expect(numberFormatForSettings(preset, "text")).toBeUndefined();
    expect(numberFormatForSettings(preset, undefined)).toBeUndefined();
  });
});
