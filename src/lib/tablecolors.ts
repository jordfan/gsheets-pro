/**
 * Presets, read as JSON, and the small amount of color resolution the Table,
 * Settings, validation and conditional format tools need.
 *
 * A preset is the palette a sheet is painted with. The tools here never invent
 * a color: they name a role ("header", "ok", "warn") and this file turns that
 * into the ColorStyle the API wants, preferring a theme slot over literal RGB
 * so that Format > Theme stays the human's knob.
 *
 * Two rules are load bearing rather than cosmetic.
 *
 * A Table's `footerColorStyle` is not a color. Setting it converts the Table's
 * last data row into a footer and silently overwrites that row's cells with SUM
 * aggregations, destroying real data (spike 3). So `tableRowsProperties` builds
 * the header and the two band colors and nothing else, and the preset schema
 * has no footer role to tempt anyone.
 *
 * Chip colors on a dropdown cannot be set through the API at all. Where a human
 * would reach for colored chips, the plugin emulates them with conditional
 * format rules built from the `ok` / `warn` / `flag` / `muted` roles, and only
 * on sheets it created itself.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseColorStyle, type ColorStyle, type ThemeSlot, THEME_SLOTS } from "./colors.js";
import { GsheetsError } from "./errors.js";

export const DEFAULT_PRESET = "neutral";

export interface PresetHeaderRole {
  fill: string;
  text: string;
  bold?: boolean;
}

export interface PresetTitleRole {
  font?: "primary" | "display";
  size?: number;
  text?: string;
  bold?: boolean;
}

export interface Preset {
  name: string;
  description?: string;
  archetype_default?: "tracker" | "model";
  fonts: { primary: string; display?: string; banned?: string[] };
  theme: Record<ThemeSlot, string>;
  roles: {
    title?: PresetTitleRole;
    header: PresetHeaderRole;
    band1: string;
    band2: string;
    input?: string;
    formula?: string;
    cross_sheet?: string;
    ok: string;
    warn: string;
    flag: string;
    muted: string;
  };
  numbers: {
    currency: string;
    percent: string;
    date: string;
    integer: string;
    decimal?: string;
    multiple?: string;
  };
  tabs?: { inputs?: string; workings?: string; outputs?: string };
  gridlines?: "always_show" | "hide_when_banded";
}

/** The role names a caller may pass anywhere a fill is accepted. */
export const FILL_ROLES = ["header", "band1", "band2", "ok", "warn", "flag", "muted"] as const;
export type FillRole = (typeof FILL_ROLES)[number];

/** The four roles that stand in for the chip colors the API cannot set. */
export const STATUS_ROLES = ["ok", "warn", "flag", "muted"] as const;
export type StatusRole = (typeof STATUS_ROLES)[number];

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const cache = new Map<string, Preset>();

/**
 * Where the preset files live. `GSHEETS_PRO_PRESETS` wins, so a host can ship
 * its own palettes; otherwise they come from the plugin directory beside the
 * built code. `src/lib` and `dist/lib` sit at the same depth, so one relative
 * path serves both the tests and the shipped server.
 */
export function presetDirectory(): string {
  const fromEnv = process.env.GSHEETS_PRO_PRESETS;
  if (fromEnv) return fromEnv;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "plugins", "gsheets-pro", "presets");
}

/** Preset names available on this host, in alphabetical order. */
export function availablePresets(): string[] {
  const dir = presetDirectory();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "schema.json")
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

/** Validate the shape we depend on. The JSON schema is the full contract. */
export function parsePreset(raw: unknown, name: string): Preset {
  const preset = raw as Preset;
  const missing: string[] = [];
  if (!preset || typeof preset !== "object") missing.push("the whole file");
  if (!preset?.fonts?.primary) missing.push("fonts.primary");
  if (!preset?.roles?.header?.fill || !preset?.roles?.header?.text) missing.push("roles.header");
  for (const role of ["band1", "band2", "ok", "warn", "flag", "muted"] as const) {
    if (!preset?.roles?.[role]) missing.push(`roles.${role}`);
  }
  for (const slot of THEME_SLOTS) {
    if (!preset?.theme?.[slot]) missing.push(`theme.${slot}`);
  }
  for (const key of ["currency", "percent", "date", "integer"] as const) {
    if (!preset?.numbers?.[key]) missing.push(`numbers.${key}`);
  }
  if (missing.length) {
    throw new GsheetsError(
      "invalid_argument",
      `The preset "${name}" is missing ${missing.join(", ")}.`,
      "A preset must match presets/schema.json: nine theme slots, the header and band roles, the four status roles, and the currency, percent, date and integer number formats.",
    );
  }
  return { ...preset, name: preset.name ?? name };
}

/** Load a preset by name, cached at module scope. */
export function loadPreset(name: string = DEFAULT_PRESET): Preset {
  const wanted = String(name ?? DEFAULT_PRESET).trim().toLowerCase() || DEFAULT_PRESET;
  const hit = cache.get(wanted);
  if (hit) return hit;

  const file = path.join(presetDirectory(), `${wanted}.json`);
  if (!fs.existsSync(file)) {
    const names = availablePresets();
    throw new GsheetsError(
      "invalid_argument",
      `No preset named "${wanted}".`,
      names.length
        ? `The presets on this host are: ${names.join(", ")}.`
        : "No preset files were found. Set GSHEETS_PRO_PRESETS to the directory holding them.",
      { available: names },
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new GsheetsError(
      "invalid_argument",
      `The preset "${wanted}" is not valid JSON: ${(error as Error).message}`,
      "Fix the file, or pass a different preset.",
    );
  }
  const preset = parsePreset(raw, wanted);
  cache.set(wanted, preset);
  return preset;
}

/** Forget loaded presets. For tests, and for `doctor` after an edit. */
export function resetPresetCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Resolving a color
// ---------------------------------------------------------------------------

function roleValue(preset: Preset, role: string): string | undefined {
  switch (role) {
    case "header":
      return preset.roles.header.fill;
    case "band1":
      return preset.roles.band1;
    case "band2":
      return preset.roles.band2;
    case "ok":
      return preset.roles.ok;
    case "warn":
      return preset.roles.warn;
    case "flag":
      return preset.roles.flag;
    case "muted":
      return preset.roles.muted;
    case "input":
      return preset.roles.input;
    case "formula":
      return preset.roles.formula;
    case "cross_sheet":
      return preset.roles.cross_sheet;
    default:
      return undefined;
  }
}

/**
 * Turn a fill spec into a ColorStyle. The spec is a role name from the preset,
 * a theme slot, or a hex value, in that order of preference: a role survives a
 * change of preset, a slot survives a change of theme, and hex survives nothing.
 */
export function resolveFill(preset: Preset, spec: string): ColorStyle {
  const wanted = String(spec ?? "").trim();
  if (!wanted) {
    throw new GsheetsError("invalid_argument", "A color is required.", fillHint(preset));
  }
  const fromRole = roleValue(preset, wanted.toLowerCase());
  try {
    return parseColorStyle(fromRole ?? wanted);
  } catch (error) {
    throw new GsheetsError("invalid_argument", (error as Error).message, fillHint(preset));
  }
}

export function fillHint(preset: Preset): string {
  return `Use a role from the ${preset.name} preset (${FILL_ROLES.join(", ")}), a theme slot such as theme:ACCENT1, or a hex color such as #F2F5F8.`;
}

/** The text color for a role's fill, when the preset pairs one with it. */
export function resolveHeaderText(preset: Preset): ColorStyle {
  return parseColorStyle(preset.roles.header.text);
}

/** The font color that marks a cell as a human's input, per the preset. */
export function resolveInputText(preset: Preset): ColorStyle | undefined {
  return preset.roles.input ? parseColorStyle(preset.roles.input) : undefined;
}

export function resolveMutedText(preset: Preset): ColorStyle {
  return parseColorStyle(preset.roles.muted);
}

// ---------------------------------------------------------------------------
// Table colors
// ---------------------------------------------------------------------------

export interface TableRowsProperties {
  headerColorStyle: ColorStyle;
  firstBandColorStyle: ColorStyle;
  secondBandColorStyle: ColorStyle;
}

/**
 * The header and band colors for a Table.
 *
 * There is deliberately no `footerColorStyle` here and no way to ask for one.
 * Spike 3 established that the field is not cosmetic: it converts the Table's
 * last data row into a footer and overwrites that row's values with SUM
 * formulas, with no error and no warning. A totals row has to be an explicit,
 * separate request that says so out loud.
 */
export function tableRowsProperties(preset: Preset): TableRowsProperties {
  return {
    headerColorStyle: resolveFill(preset, "header"),
    firstBandColorStyle: resolveFill(preset, "band1"),
    secondBandColorStyle: resolveFill(preset, "band2"),
  };
}

/** The number format pattern a Table column type should carry, if any. */
export function numberFormatForColumnType(
  preset: Preset,
  columnType: string | undefined,
): { type: string; pattern: string } | undefined {
  switch (columnType) {
    case "CURRENCY":
      return { type: "CURRENCY", pattern: preset.numbers.currency };
    case "PERCENT":
      return { type: "PERCENT", pattern: preset.numbers.percent };
    case "DATE":
      return { type: "DATE", pattern: preset.numbers.date };
    case "DATE_TIME":
      return { type: "DATE_TIME", pattern: `${preset.numbers.date} h:mm am/pm` };
    case "TIME":
      return { type: "TIME", pattern: "h:mm am/pm" };
    case "DOUBLE":
      return { type: "NUMBER", pattern: preset.numbers.decimal ?? preset.numbers.integer };
    default:
      return undefined;
  }
}

/** The number format for a Settings row, named the way a person would say it. */
export const SETTINGS_FORMATS = [
  "currency",
  "percent",
  "date",
  "integer",
  "decimal",
  "multiple",
  "text",
] as const;

export type SettingsFormat = (typeof SETTINGS_FORMATS)[number];

export function numberFormatForSettings(
  preset: Preset,
  format: SettingsFormat | undefined,
): { type: string; pattern: string } | undefined {
  switch (format) {
    case "currency":
      return { type: "CURRENCY", pattern: preset.numbers.currency };
    case "percent":
      return { type: "PERCENT", pattern: preset.numbers.percent };
    case "date":
      return { type: "DATE", pattern: preset.numbers.date };
    case "integer":
      return { type: "NUMBER", pattern: preset.numbers.integer };
    case "decimal":
      return { type: "NUMBER", pattern: preset.numbers.decimal ?? "#,##0.00" };
    case "multiple":
      return { type: "NUMBER", pattern: preset.numbers.multiple ?? '0.0"x"' };
    default:
      return undefined;
  }
}
