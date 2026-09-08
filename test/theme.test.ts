/**
 * Presets: loading, validating, and compiling.
 *
 * The compile step is where a palette becomes a spreadsheet, so these hold it
 * to the two rules that make the system work: every theme write carries all
 * nine slots, and a role whose color names a slot compiles to a theme
 * reference rather than to frozen hex.
 */
import { describe, expect, test } from "vitest";

import {
  checkPreset,
  compileTheme,
  DEFAULT_PRESET,
  listPresets,
  loadPreset,
  manifestValue,
  MODEL_ONLY_ROLES,
  parsePreset,
  resolveArchetype,
  resolvePresetName,
  roleFormat,
  tokenToColorStyle,
  validatePreset,
  type Preset,
} from "../src/lib/theme.js";
import { THEME_SLOTS } from "../src/lib/colors.js";

const MINIMAL = {
  name: "test-preset",
  fonts: { primary: "Georgia", display: "Georgia", banned: [] },
  theme: {
    TEXT: "#101010",
    BACKGROUND: "#FFFFFF",
    ACCENT1: "#204060",
    ACCENT2: "#3F7F6B",
    ACCENT3: "#5B7C99",
    ACCENT4: "#C9A227",
    ACCENT5: "#B25E28",
    ACCENT6: "#9B4A44",
    LINK: "#1155CC",
  },
  roles: {
    header: { fill: "ACCENT1", text: "BACKGROUND", bold: true },
    band1: "BACKGROUND",
    band2: "#F1F4F7",
    input: "#1155CC",
    formula: "TEXT",
    cross_sheet: "ACCENT2",
    ok: "#E3F0E9",
    warn: "#FBF0D3",
    flag: "#F5E2E0",
    muted: "#6B7280",
  },
  numbers: { currency: '"$"#,##0', percent: "0.0%", date: "yyyy-mm-dd", integer: "#,##0" },
};

const preset = (overrides: Record<string, unknown> = {}): Preset =>
  parsePreset(JSON.stringify({ ...MINIMAL, ...overrides }));

describe("loading the presets that ship", () => {
  test("all three load and validate", () => {
    for (const name of ["neutral", "park", "finance-classic"]) {
      const loaded = loadPreset(name);
      expect(loaded.name).toBe(name);
      expect(Object.keys(loaded.theme).sort()).toEqual([...THEME_SLOTS].sort());
    }
  });

  test("listPresets finds them", () => {
    const names = listPresets();
    expect(names).toContain("neutral");
    expect(names).toContain("park");
    expect(names).toContain("finance-classic");
    expect(names).not.toContain("schema");
  });

  test("an unknown preset names the ones that exist", () => {
    try {
      loadPreset("does-not-exist");
      throw new Error("should have refused");
    } catch (error) {
      expect((error as Error).message).toContain("does-not-exist");
      expect((error as { hint?: string }).hint).toContain("neutral");
    }
  });

  test("a preset carrying a footer role is refused by the schema", () => {
    expect(() =>
      parsePreset(JSON.stringify({ ...MINIMAL, roles: { ...MINIMAL.roles, footer: "ACCENT1" } })),
    ).toThrow(/preset schema/);
  });
});

describe("validation", () => {
  test("header text must clear 4.5 to 1 against the header fill", () => {
    const bad = preset({
      roles: { ...MINIMAL.roles, header: { fill: "#EEEEEE", text: "#FFFFFF" } },
    });
    const problems = checkPreset(bad);
    expect(problems.some((p) => p.severity === "error" && /4.5 to 1/.test(p.message))).toBe(true);
    expect(() => validatePreset(bad)).toThrow(/not usable/);
  });

  test("a banned font is refused as the primary", () => {
    const bad = preset({ fonts: { primary: "Inter", display: "Georgia", banned: ["Inter"] } });
    expect(checkPreset(bad).some((p) => /banned list/.test(p.message))).toBe(true);
  });

  test("two bands that barely differ are refused", () => {
    const bad = preset({ roles: { ...MINIMAL.roles, band1: "#FFFFFF", band2: "#FEFEFE" } });
    expect(checkPreset(bad).some((p) => p.severity === "error" && /rendering artifact/.test(p.message))).toBe(
      true,
    );
  });

  test("a model preset may set both bands the same, because banding is off", () => {
    const model = preset({
      archetype_default: "model",
      roles: { ...MINIMAL.roles, band1: "BACKGROUND", band2: "BACKGROUND" },
    });
    expect(checkPreset(model).filter((p) => p.severity === "error")).toEqual([]);
  });

  test("finance-classic, which does exactly that, passes", () => {
    expect(() => loadPreset("finance-classic")).not.toThrow();
  });
});

describe("compiling", () => {
  test("the theme carries all nine slots, every time", () => {
    const compiled = compileTheme(loadPreset("park"));
    expect(compiled.spreadsheetTheme.themeColors).toHaveLength(9);
    expect(compiled.spreadsheetTheme.themeColors.map((c) => c.colorType).sort()).toEqual(
      [...THEME_SLOTS].sort(),
    );
    expect(compiled.spreadsheetTheme.primaryFontFamily).toBe("Open Sans");
  });

  test("a role naming a slot compiles to a theme reference, not to hex", () => {
    const compiled = compileTheme(loadPreset("park"));
    expect(compiled.roles.header?.backgroundColorStyle).toEqual({ themeColor: "ACCENT1" });
    expect(compiled.roles.header?.textFormat?.foregroundColorStyle).toEqual({
      themeColor: "BACKGROUND",
    });
  });

  test("a role naming a hex compiles to literal rgb", () => {
    const compiled = compileTheme(loadPreset("park"));
    const ok = compiled.roles.ok?.backgroundColorStyle;
    expect(ok?.themeColor).toBeUndefined();
    expect(ok?.rgbColor).toBeDefined();
  });

  test("slots the preset leaves out are inherited rather than reset", () => {
    const partial = { ...MINIMAL, theme: { ...MINIMAL.theme } } as Record<string, unknown>;
    // Build a compiled theme against a preset whose ACCENT6 was blanked, the
    // way a hand-written preset might arrive after an edit.
    const loaded = preset();
    delete (loaded.theme as Record<string, string>).ACCENT6;
    const compiled = compileTheme(loaded, {
      current: {
        themeColors: [{ colorType: "ACCENT6", color: { rgbColor: { red: 0.5, green: 0.25, blue: 0 } } }],
      },
    });
    expect(compiled.inheritedSlots).toEqual(["ACCENT6"]);
    const accent6 = compiled.spreadsheetTheme.themeColors.find((c) => c.colorType === "ACCENT6");
    expect(accent6?.color.rgbColor.red).toBeCloseTo(0.5);
    void partial;
  });

  test("a missing slot with nothing to inherit is refused rather than guessed", () => {
    const loaded = preset();
    delete (loaded.theme as Record<string, string>).ACCENT6;
    expect(() => compileTheme(loaded)).toThrow(/ACCENT6/);
  });

  test("a tracker has no font-color roles at all", () => {
    const compiled = compileTheme(loadPreset("neutral"), { archetype: "tracker" });
    for (const role of MODEL_ONLY_ROLES) {
      expect(compiled.roles[role]).toBeUndefined();
    }
    expect(compiled.bandingApplies).toBe(true);
  });

  test("a model has them, and turns banding off", () => {
    const compiled = compileTheme(loadPreset("finance-classic"));
    expect(compiled.archetype).toBe("model");
    expect(compiled.roles.input?.textFormat?.foregroundColorStyle).toBeDefined();
    expect(compiled.bandingApplies).toBe(false);
  });

  test("asking a tracker for an input color is a refusal that names the archetype", () => {
    const compiled = compileTheme(loadPreset("park"), { archetype: "tracker" });
    try {
      roleFormat(compiled, "input");
      throw new Error("should have refused");
    } catch (error) {
      expect((error as Error).message).toContain("model archetype");
      expect((error as { hint?: string }).hint).toContain("tracker");
    }
  });

  test("there is no footer role and the refusal says why", () => {
    const compiled = compileTheme(loadPreset("park"));
    try {
      roleFormat(compiled, "footer");
      throw new Error("should have refused");
    } catch (error) {
      expect((error as { hint?: string }).hint).toContain("SUM formulas");
    }
  });

  test("number formats resolve to a type and a pattern", () => {
    const compiled = compileTheme(loadPreset("park"));
    expect(compiled.numberFormats.percent).toEqual({ type: "PERCENT", pattern: "0.0%" });
    expect(compiled.numberFormats.date?.type).toBe("DATE");
  });

  test("the manifest records the preset and the archetype", () => {
    const compiled = compileTheme(loadPreset("park"), { archetype: "tracker" });
    const parsed = JSON.parse(manifestValue(compiled, new Date("2026-09-07T12:00:00Z")));
    expect(parsed).toMatchObject({ preset: "park", archetype: "tracker", version: 1 });
    expect(parsed.createdAt).toBe("2026-09-07T12:00:00.000Z");
  });
});

describe("tokens", () => {
  test("a slot name becomes a themeColor and a hex becomes rgb", () => {
    expect(tokenToColorStyle("ACCENT3")).toEqual({ themeColor: "ACCENT3" });
    expect(tokenToColorStyle("theme:ACCENT3")).toEqual({ themeColor: "ACCENT3" });
    expect(tokenToColorStyle("#187054").rgbColor).toBeDefined();
  });
});

describe("resolution order", () => {
  test("the argument beats everything", () => {
    expect(
      resolvePresetName({ argument: "park", manifest: "neutral", registry: "finance-classic" }),
    ).toEqual({ name: "park", source: "argument" });
  });

  test("the sheet's own manifest beats the repo registry", () => {
    expect(resolvePresetName({ manifest: "park", registry: "neutral" })).toEqual({
      name: "park",
      source: "manifest",
    });
  });

  test("the registry beats the person's default", () => {
    expect(resolvePresetName({ registry: "park", dataDir: "neutral" })).toEqual({
      name: "park",
      source: "registry",
    });
  });

  test("with nothing stated at all it is neutral", () => {
    expect(resolvePresetName({ dataDir: undefined })).toEqual({
      name: DEFAULT_PRESET,
      source: "default",
    });
  });

  test("an empty string is not a statement of intent", () => {
    expect(resolvePresetName({ argument: "   ", manifest: "park" }).name).toBe("park");
  });

  test("archetype falls back to the preset's own default", () => {
    const park = loadPreset("park");
    expect(resolveArchetype(park)).toBe("tracker");
    expect(resolveArchetype(park, { argument: "model" })).toBe("model");
    expect(resolveArchetype(loadPreset("finance-classic"))).toBe("model");
  });
});
