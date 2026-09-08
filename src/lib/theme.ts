/**
 * Presets: the answer to "what color is a header".
 *
 * A preset is a palette and a set of fonts. It compiles to two things. The
 * first is a full nine pair `SpreadsheetTheme`, because the Sheets API rejects
 * a partial theme write and because a theme is the human's knob: once the
 * workbook carries the palette, Format > Theme re-skins everything the plugin
 * painted. The second is a map from role name to `CellFormat`, so a styling
 * call says `role: "header"` and never a hex value.
 *
 * Wherever a role's color names one of the nine slots, it compiles to
 * `ColorStyle.themeColor` rather than to literal RGB. That is the whole point
 * of the system: a header written as `themeColor: ACCENT1` follows the theme,
 * a header written as `#187054` does not.
 *
 * Archetype is a second axis, orthogonal to the palette. `tracker` keeps font
 * color out of the data language and carries state in dropdowns and
 * conditional rules. `model` uses font color to encode data role, in the
 * financial-modeling convention, and turns banding off because the two systems
 * fight each other. Asking for an input color on a tracker is a mistake worth
 * refusing rather than quietly honouring.
 *
 * There is deliberately no footer role and the schema will not accept one. A
 * Table's `footerColorStyle` reads like a color and behaves like a data
 * migration: it converts the last data row into a footer and overwrites those
 * cells with SUM formulas, with no error (spike 3).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { dataDir } from "./auth.js";
import {
  contrastRatio,
  parseColor,
  parseThemeSlot,
  THEME_SLOTS,
  type Color,
  type ColorStyle,
  type ThemeSlot,
} from "./colors.js";
import { GsheetsError } from "./errors.js";
import { resolveNumberFormat, type NumberFormat } from "./numfmt.js";

export const DEFAULT_PRESET = "neutral";

export type Archetype = "tracker" | "model";

/** Role tokens a styling call may name. No footer, on purpose. */
export const ROLE_TOKENS = [
  "title",
  "header",
  "band1",
  "band2",
  "input",
  "formula",
  "cross_sheet",
  "ok",
  "warn",
  "flag",
  "muted",
] as const;

export type RoleToken = (typeof ROLE_TOKENS)[number];

/** Roles that encode data role through font color, so `model` only. */
export const MODEL_ONLY_ROLES: readonly RoleToken[] = ["input", "formula", "cross_sheet"];

// ---------------------------------------------------------------------------
// The file shape, mirroring presets/schema.json
// ---------------------------------------------------------------------------

const hex = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, "must be a six digit hex color with a leading #");

const colorToken = z.union([z.enum(THEME_SLOTS), hex]);

const presetSchema = z
  .object({
    $schema: z.string().optional(),
    name: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    description: z.string().optional(),
    archetype_default: z.enum(["tracker", "model"]).default("tracker"),
    fonts: z
      .object({
        primary: z.string().min(1),
        display: z.string().min(1).optional(),
        banned: z.array(z.string()).default([]),
      })
      .strict(),
    theme: z
      .object({
        TEXT: hex,
        BACKGROUND: hex,
        ACCENT1: hex,
        ACCENT2: hex,
        ACCENT3: hex,
        ACCENT4: hex,
        ACCENT5: hex,
        ACCENT6: hex,
        LINK: hex,
      })
      .strict(),
    roles: z
      .object({
        title: z
          .object({
            font: z.enum(["primary", "display"]).optional(),
            size: z.number().int().min(8).max(36).optional(),
            text: colorToken.optional(),
            bold: z.boolean().optional(),
          })
          .strict()
          .optional(),
        header: z
          .object({ fill: colorToken, text: colorToken, bold: z.boolean().optional() })
          .strict(),
        band1: colorToken,
        band2: colorToken,
        input: colorToken.optional(),
        formula: colorToken.optional(),
        cross_sheet: colorToken.optional(),
        ok: colorToken,
        warn: colorToken,
        flag: colorToken,
        muted: colorToken,
      })
      .strict(),
    numbers: z
      .object({
        currency: z.string(),
        percent: z.string(),
        date: z.string(),
        integer: z.string(),
        decimal: z.string().optional(),
        multiple: z.string().optional(),
      })
      .strict(),
    tabs: z
      .object({
        inputs: colorToken.optional(),
        workings: colorToken.optional(),
        outputs: colorToken.optional(),
      })
      .strict()
      .optional(),
    gridlines: z.enum(["always_show", "hide_when_banded"]).default("hide_when_banded"),
  })
  .strict();

export type Preset = z.infer<typeof presetSchema>;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Where preset JSON is looked for, most specific first. A user's own presets
 * in the data directory shadow the ones that ship, which is what lets someone
 * override `park` without editing an installed plugin.
 */
export function presetSearchPaths(options: { cwd?: string } = {}): string[] {
  const out: string[] = [];
  const fromEnv = process.env.GSHEETS_PRO_PRESETS;
  if (fromEnv) out.push(...fromEnv.split(path.delimiter).filter(Boolean));
  out.push(path.join(dataDir(), "presets"));
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot) out.push(path.join(pluginRoot, "presets"));
  for (const dir of bundledPresetDirs(options.cwd)) out.push(dir);
  return [...new Set(out)];
}

/**
 * The presets that ship with the repo. Found by walking up from this module,
 * which works whether the code runs from `src/` under vitest or from `dist/`
 * after a build, and from the working directory as a fallback for a checkout
 * whose layout differs.
 */
function bundledPresetDirs(cwd?: string): string[] {
  const out: string[] = [];
  const starts = [path.dirname(fileURLToPath(import.meta.url)), cwd ?? process.cwd()];
  for (const start of starts) {
    let dir = path.resolve(start);
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = path.join(dir, "plugins", "gsheets-pro", "presets");
      if (fs.existsSync(candidate)) {
        out.push(candidate);
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return out;
}

/** Parse preset JSON already in hand. Exported so tests need no files. */
export function parsePreset(text: string, source = "<inline>"): Preset {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new GsheetsError(
      "invalid_argument",
      `${source} is not valid JSON: ${(error as Error).message}`,
      "A preset is a JSON file shaped like presets/schema.json. Copy presets/neutral.json and change the values.",
    );
  }
  const parsed = presetSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new GsheetsError(
      "invalid_argument",
      `${source} does not match the preset schema: ${issues}`,
      "Every preset needs name, fonts, all nine theme slots, the roles header, band1, band2, ok, warn, flag and muted, and the numbers currency, percent, date and integer. There is no footer role and there cannot be one.",
    );
  }
  return parsed.data;
}

/** Read a named preset off disk, searching the preset paths in order. */
export function loadPreset(name: string, options: { cwd?: string } = {}): Preset {
  const wanted = String(name ?? "").trim().toLowerCase();
  if (!wanted) throw new GsheetsError("invalid_argument", "No preset name given.");
  const dirs = presetSearchPaths(options);
  for (const dir of dirs) {
    const file = path.join(dir, `${wanted}.json`);
    if (fs.existsSync(file)) {
      const preset = parsePreset(fs.readFileSync(file, "utf8"), file);
      validatePreset(preset);
      return preset;
    }
  }
  throw new GsheetsError(
    "invalid_argument",
    `No preset named "${name}".`,
    `Available presets: ${listPresets(options).join(", ") || "none found"}. Presets are read from ${dirs.join(", ")}.`,
    { searched: dirs },
  );
}

/** Every preset name findable on the search paths, nearest first. */
export function listPresets(options: { cwd?: string } = {}): string[] {
  const seen = new Set<string>();
  for (const dir of presetSearchPaths(options)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry === "schema.json") continue;
      seen.add(entry.slice(0, -5));
    }
  }
  return [...seen].sort();
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Header text on header fill must clear WCAG AA for normal text. */
export const MIN_HEADER_CONTRAST = 4.5;
/** Below this the two bands read as a rendering artifact rather than as bands. */
export const MIN_BAND_SEPARATION = 1.02;
/** Above this the banding stripes louder than the data. */
export const MAX_BAND_SEPARATION = 1.6;

export interface PresetProblem {
  severity: "error" | "warning";
  message: string;
}

/** Resolve a color token against a preset's own theme, to a literal color. */
export function resolveToken(preset: Preset, token: string): Color {
  const slot = parseThemeSlot(token);
  if (slot) return parseColor(preset.theme[slot]);
  return parseColor(token);
}

/**
 * Everything wrong with a preset. Errors refuse the preset; warnings are
 * reported alongside the sheet so a person can decide.
 */
export function checkPreset(preset: Preset): PresetProblem[] {
  const problems: PresetProblem[] = [];
  const banned = new Set(preset.fonts.banned.map((f) => f.trim().toLowerCase()));

  for (const [which, font] of [
    ["primary", preset.fonts.primary],
    ["display", preset.fonts.display],
  ] as const) {
    if (font && banned.has(font.trim().toLowerCase())) {
      problems.push({
        severity: "error",
        message: `The ${which} font "${font}" is in this preset's own banned list. A banned list exists so the defaults everyone else lands on stay unavailable; either drop the font or drop it from the list.`,
      });
    }
  }

  const headerFill = resolveToken(preset, preset.roles.header.fill);
  const headerText = resolveToken(preset, preset.roles.header.text);
  const headerContrast = contrastRatio(headerFill, headerText);
  if (headerContrast < MIN_HEADER_CONTRAST) {
    problems.push({
      severity: "error",
      message: `Header text on the header fill reaches only ${headerContrast.toFixed(2)} to 1. A header is normal text and needs ${MIN_HEADER_CONTRAST} to 1 to be readable. Darken the fill or lighten the text.`,
    });
  }

  const band1 = resolveToken(preset, preset.roles.band1);
  const band2 = resolveToken(preset, preset.roles.band2);
  const bandSeparation = contrastRatio(band1, band2);
  // finance-classic sets both bands to the background on purpose: the model
  // archetype turns banding off, so identical bands are a statement, not a bug.
  const bandingOff = preset.archetype_default === "model" && preset.roles.band1 === preset.roles.band2;
  if (!bandingOff && bandSeparation < MIN_BAND_SEPARATION) {
    problems.push({
      severity: "error",
      message: `band1 and band2 differ by only ${bandSeparation.toFixed(3)} to 1, which reads as a rendering artifact rather than as banding. Either separate them or set them equal and leave banding off.`,
    });
  }
  if (bandSeparation > MAX_BAND_SEPARATION) {
    problems.push({
      severity: "warning",
      message: `band1 and band2 differ by ${bandSeparation.toFixed(2)} to 1, which stripes louder than the data. Banding is meant to help the eye track a row, not to decorate.`,
    });
  }

  const text = parseColor(preset.theme.TEXT);
  for (const role of ["ok", "warn", "flag"] as const) {
    const fill = resolveToken(preset, preset.roles[role]);
    const ratio = contrastRatio(fill, text);
    if (ratio < MIN_HEADER_CONTRAST) {
      problems.push({
        severity: "warning",
        message: `Body text on the ${role} fill reaches ${ratio.toFixed(2)} to 1. Status fills carry ordinary cell text, so they want ${MIN_HEADER_CONTRAST} to 1 too.`,
      });
    }
  }

  for (const [name, spec] of Object.entries(preset.numbers)) {
    if (typeof spec !== "string") continue;
    try {
      resolveNumberFormat(spec);
    } catch (error) {
      problems.push({
        severity: "error",
        message: `The ${name} number format is not usable: ${(error as Error).message}`,
      });
    }
  }

  return problems;
}

/** Refuse a preset that fails a hard check. Returns the warnings. */
export function validatePreset(preset: Preset): string[] {
  const problems = checkPreset(preset);
  const errors = problems.filter((p) => p.severity === "error");
  if (errors.length) {
    throw new GsheetsError(
      "invalid_argument",
      `The preset "${preset.name}" is not usable: ${errors.map((e) => e.message).join(" ")}`,
      "Fix the preset file rather than working around it here. A preset that fails these checks produces a sheet that is hard to read, which is the one thing this plugin exists to prevent.",
    );
  }
  return problems.map((p) => p.message);
}

// ---------------------------------------------------------------------------
// Resolution order
// ---------------------------------------------------------------------------

export interface PresetSources {
  /** Named directly on the call. Wins over everything. */
  argument?: string;
  /** From the spreadsheet's own `gsheets.manifest` or `gsheets.sheet` metadata. */
  manifest?: string;
  /** From `.claude/gsheets-pro.json`, for a spreadsheet the repo knows about. */
  registry?: string;
  /** From `<data dir>/config.json`, a person's own default. */
  dataDir?: string;
}

export interface ResolvedPresetName {
  name: string;
  source: "argument" | "manifest" | "registry" | "data_dir" | "default";
}

/**
 * Which preset applies. The order runs from the most specific statement of
 * intent to the least: what this call asked for, what the spreadsheet says
 * about itself, what the repo says about this spreadsheet, what this person
 * prefers generally, and finally the neutral default.
 */
export function resolvePresetName(sources: PresetSources = {}): ResolvedPresetName {
  const clean = (v?: string) => {
    const s = String(v ?? "").trim();
    return s || undefined;
  };
  const argument = clean(sources.argument);
  if (argument) return { name: argument, source: "argument" };
  const manifest = clean(sources.manifest);
  if (manifest) return { name: manifest, source: "manifest" };
  const registry = clean(sources.registry);
  if (registry) return { name: registry, source: "registry" };
  const fromData = clean(sources.dataDir ?? readDataDirDefaults().preset);
  if (fromData) return { name: fromData, source: "data_dir" };
  return { name: DEFAULT_PRESET, source: "default" };
}

const dataDirConfigSchema = z
  .object({ preset: z.string().optional(), archetype: z.enum(["tracker", "model"]).optional() })
  .partial()
  .passthrough();

/** A person's own defaults, `<data dir>/config.json`. Absent is the norm. */
export function readDataDirDefaults(): { preset?: string; archetype?: Archetype } {
  const file = path.join(dataDir(), "config.json");
  try {
    if (!fs.existsSync(file)) return {};
    const parsed = dataDirConfigSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (!parsed.success) return {};
    const out: { preset?: string; archetype?: Archetype } = {};
    if (parsed.data.preset) out.preset = parsed.data.preset;
    if (parsed.data.archetype) out.archetype = parsed.data.archetype;
    return out;
  } catch {
    // A malformed personal config is not worth failing a write over. The
    // registry is the file where being loud matters, because it protects other
    // people's spreadsheets; this one only picks a palette.
    return {};
  }
}

/** Archetype follows the same order, then the preset's own default. */
export function resolveArchetype(
  preset: Preset,
  sources: { argument?: Archetype; manifest?: Archetype; registry?: Archetype } = {},
): Archetype {
  return (
    sources.argument ??
    sources.manifest ??
    sources.registry ??
    readDataDirDefaults().archetype ??
    preset.archetype_default
  );
}

// ---------------------------------------------------------------------------
// Compiling
// ---------------------------------------------------------------------------

/** The `SpreadsheetTheme` shape the API takes, all nine pairs. */
export interface SpreadsheetThemeWrite {
  primaryFontFamily: string;
  themeColors: Array<{ colorType: ThemeSlot; color: { rgbColor: Color } }>;
}

/** The Sheets `CellFormat` fragment a role compiles to. */
export interface CellFormat {
  backgroundColorStyle?: ColorStyle;
  numberFormat?: NumberFormat;
  horizontalAlignment?: string;
  verticalAlignment?: string;
  wrapStrategy?: string;
  textFormat?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    fontSize?: number;
    fontFamily?: string;
    foregroundColorStyle?: ColorStyle;
  };
}

export interface CompiledTheme {
  preset: Preset;
  archetype: Archetype;
  /** Every slot, ready for `updateSpreadsheetProperties`. */
  spreadsheetTheme: SpreadsheetThemeWrite;
  /** Which slots came from the sheet's existing theme rather than the preset. */
  inheritedSlots: ThemeSlot[];
  /** Role name to the CellFormat it paints. Model only roles are absent on a tracker. */
  roles: Partial<Record<RoleToken, CellFormat>>;
  /** Banding colors, resolved. There is no footer, deliberately. */
  banding: { header?: ColorStyle; first: ColorStyle; second: ColorStyle };
  /** Whether banding belongs on this archetype at all. */
  bandingApplies: boolean;
  numberFormats: Record<string, NumberFormat>;
  tabColors: Partial<Record<"inputs" | "workings" | "outputs", ColorStyle>>;
  /** True when gridlines should come off on a banded sheet. */
  hideGridlinesWhenBanded: boolean;
  warnings: string[];
}

/** A color token to the ColorStyle a write should carry. */
export function tokenToColorStyle(token: string): ColorStyle {
  const slot = parseThemeSlot(token);
  if (slot) return { themeColor: slot };
  return { rgbColor: parseColor(token) };
}

/** The existing theme as the API hands it back, so missing slots can be kept. */
export interface CurrentTheme {
  primaryFontFamily?: string | null;
  themeColors?: Array<{
    colorType?: string | null;
    color?: { rgbColor?: { red?: number | null; green?: number | null; blue?: number | null } | null } | null;
  }> | null;
}

export interface CompileOptions {
  archetype?: Archetype;
  /** The sheet's current theme, used to fill any slot the preset leaves out. */
  current?: CurrentTheme | null;
  /** Slot overrides from the call, applied over the preset. */
  themeOverrides?: Partial<Record<ThemeSlot, string>>;
  /** Font override from the call. */
  font?: string;
}

/**
 * Turn a preset into everything a styling call needs.
 *
 * The theme is always written whole. The API rejects a partial theme, and a
 * partial write would in any case leave a workbook half in one palette and
 * half in another. Slots the preset does not name are taken from the sheet's
 * current theme so nothing silently reverts to Google's defaults.
 */
export function compileTheme(preset: Preset, options: CompileOptions = {}): CompiledTheme {
  const warnings = checkPreset(preset)
    .filter((p) => p.severity === "warning")
    .map((p) => p.message);
  const archetype = options.archetype ?? preset.archetype_default;

  const currentBySlot = new Map<ThemeSlot, Color>();
  for (const entry of options.current?.themeColors ?? []) {
    const slot = entry?.colorType ? parseThemeSlot(entry.colorType) : undefined;
    const rgb = entry?.color?.rgbColor;
    if (!slot || !rgb) continue;
    currentBySlot.set(slot, {
      red: rgb.red ?? 0,
      green: rgb.green ?? 0,
      blue: rgb.blue ?? 0,
    });
  }

  const inheritedSlots: ThemeSlot[] = [];
  const themeColors = THEME_SLOTS.map((slot) => {
    const override = options.themeOverrides?.[slot];
    const fromPreset = override ?? preset.theme[slot];
    if (fromPreset) return { colorType: slot, color: { rgbColor: parseColor(fromPreset) } };
    const inherited = currentBySlot.get(slot);
    if (inherited) {
      inheritedSlots.push(slot);
      return { colorType: slot, color: { rgbColor: inherited } };
    }
    throw new GsheetsError(
      "invalid_argument",
      `The theme slot ${slot} has no value in preset "${preset.name}" and the spreadsheet has none to inherit.`,
      "A theme write must carry all nine slots. Add the slot to the preset.",
    );
  });

  const font = options.font ?? preset.fonts.primary;
  const displayFont = preset.fonts.display ?? font;

  const roles: Partial<Record<RoleToken, CellFormat>> = {};

  if (preset.roles.title) {
    const title = preset.roles.title;
    const textFormat: NonNullable<CellFormat["textFormat"]> = {
      fontFamily: title.font === "primary" ? font : displayFont,
    };
    if (title.size !== undefined) textFormat.fontSize = title.size;
    if (title.bold !== undefined) textFormat.bold = title.bold;
    if (title.text) textFormat.foregroundColorStyle = tokenToColorStyle(title.text);
    roles.title = { textFormat };
  }

  roles.header = {
    backgroundColorStyle: tokenToColorStyle(preset.roles.header.fill),
    textFormat: {
      bold: preset.roles.header.bold !== false,
      foregroundColorStyle: tokenToColorStyle(preset.roles.header.text),
    },
  };

  roles.band1 = { backgroundColorStyle: tokenToColorStyle(preset.roles.band1) };
  roles.band2 = { backgroundColorStyle: tokenToColorStyle(preset.roles.band2) };
  for (const role of ["ok", "warn", "flag"] as const) {
    roles[role] = { backgroundColorStyle: tokenToColorStyle(preset.roles[role]) };
  }
  roles.muted = { textFormat: { foregroundColorStyle: tokenToColorStyle(preset.roles.muted) } };

  // On a tracker, font color says nothing about whether a cell is typed or
  // calculated, so these roles do not exist rather than existing and meaning
  // nothing. `sheets_style` turns a request for one into a refusal that says
  // which archetype it belongs to.
  if (archetype === "model") {
    for (const role of MODEL_ONLY_ROLES) {
      const token = preset.roles[role as "input" | "formula" | "cross_sheet"];
      if (token) roles[role] = { textFormat: { foregroundColorStyle: tokenToColorStyle(token) } };
    }
  }

  const numberFormats: Record<string, NumberFormat> = {};
  for (const [name, spec] of Object.entries(preset.numbers)) {
    if (typeof spec === "string") numberFormats[name] = resolveNumberFormat(spec);
  }

  const tabColors: CompiledTheme["tabColors"] = {};
  for (const role of ["inputs", "workings", "outputs"] as const) {
    const token = preset.tabs?.[role];
    if (token) tabColors[role] = tokenToColorStyle(token);
  }

  return {
    preset,
    archetype,
    spreadsheetTheme: { primaryFontFamily: font, themeColors },
    inheritedSlots,
    roles,
    banding: {
      header: tokenToColorStyle(preset.roles.header.fill),
      first: tokenToColorStyle(preset.roles.band1),
      second: tokenToColorStyle(preset.roles.band2),
    },
    bandingApplies: archetype === "tracker",
    numberFormats,
    tabColors,
    hideGridlinesWhenBanded: preset.gridlines === "hide_when_banded",
    warnings,
  };
}

/**
 * The CellFormat for one role, or a refusal that explains the archetype.
 */
export function roleFormat(compiled: CompiledTheme, role: string): CellFormat {
  const wanted = String(role ?? "").trim().toLowerCase() as RoleToken;
  if (!(ROLE_TOKENS as readonly string[]).includes(wanted)) {
    throw new GsheetsError(
      "invalid_argument",
      `There is no style role named "${role}".`,
      `The roles are: ${ROLE_TOKENS.join(", ")}. There is no footer role, because a Table's footer color overwrites the last data row with SUM formulas.`,
    );
  }
  const format = compiled.roles[wanted];
  if (format) return format;
  if ((MODEL_ONLY_ROLES as readonly string[]).includes(wanted)) {
    throw new GsheetsError(
      "invalid_argument",
      `The role "${wanted}" belongs to the model archetype, and this sheet is a ${compiled.archetype}.`,
      "On a tracker, font color carries no meaning and state lives in a Status column painted by a dropdown or a conditional rule. If this really is a model, pass archetype: \"model\".",
    );
  }
  throw new GsheetsError(
    "invalid_argument",
    `The preset "${compiled.preset.name}" defines no ${wanted} role.`,
  );
}

/** The manifest metadata value a theme write records on the spreadsheet. */
export function manifestValue(compiled: CompiledTheme, now = new Date()): string {
  return JSON.stringify({
    version: 1,
    preset: compiled.preset.name,
    archetype: compiled.archetype,
    createdBy: "gsheets-pro",
    createdAt: now.toISOString(),
  });
}
