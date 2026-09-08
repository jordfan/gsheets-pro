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
import { z } from "zod";
import { type Color, type ColorStyle, type ThemeSlot } from "./colors.js";
import { type NumberFormat } from "./numfmt.js";
export declare const DEFAULT_PRESET = "neutral";
export type Archetype = "tracker" | "model";
/** Role tokens a styling call may name. No footer, on purpose. */
export declare const ROLE_TOKENS: readonly ["title", "header", "band1", "band2", "input", "formula", "cross_sheet", "ok", "warn", "flag", "muted"];
export type RoleToken = (typeof ROLE_TOKENS)[number];
/** Roles that encode data role through font color, so `model` only. */
export declare const MODEL_ONLY_ROLES: readonly RoleToken[];
declare const presetSchema: z.ZodObject<{
    $schema: z.ZodOptional<z.ZodString>;
    name: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    archetype_default: z.ZodDefault<z.ZodEnum<{
        tracker: "tracker";
        model: "model";
    }>>;
    fonts: z.ZodObject<{
        primary: z.ZodString;
        display: z.ZodOptional<z.ZodString>;
        banned: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>;
    theme: z.ZodObject<{
        TEXT: z.ZodString;
        BACKGROUND: z.ZodString;
        ACCENT1: z.ZodString;
        ACCENT2: z.ZodString;
        ACCENT3: z.ZodString;
        ACCENT4: z.ZodString;
        ACCENT5: z.ZodString;
        ACCENT6: z.ZodString;
        LINK: z.ZodString;
    }, z.core.$strict>;
    roles: z.ZodObject<{
        title: z.ZodOptional<z.ZodObject<{
            font: z.ZodOptional<z.ZodEnum<{
                primary: "primary";
                display: "display";
            }>>;
            size: z.ZodOptional<z.ZodNumber>;
            text: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
                TEXT: "TEXT";
                BACKGROUND: "BACKGROUND";
                ACCENT1: "ACCENT1";
                ACCENT2: "ACCENT2";
                ACCENT3: "ACCENT3";
                ACCENT4: "ACCENT4";
                ACCENT5: "ACCENT5";
                ACCENT6: "ACCENT6";
                LINK: "LINK";
            }>, z.ZodString]>>;
            bold: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        header: z.ZodObject<{
            fill: z.ZodUnion<readonly [z.ZodEnum<{
                TEXT: "TEXT";
                BACKGROUND: "BACKGROUND";
                ACCENT1: "ACCENT1";
                ACCENT2: "ACCENT2";
                ACCENT3: "ACCENT3";
                ACCENT4: "ACCENT4";
                ACCENT5: "ACCENT5";
                ACCENT6: "ACCENT6";
                LINK: "LINK";
            }>, z.ZodString]>;
            text: z.ZodUnion<readonly [z.ZodEnum<{
                TEXT: "TEXT";
                BACKGROUND: "BACKGROUND";
                ACCENT1: "ACCENT1";
                ACCENT2: "ACCENT2";
                ACCENT3: "ACCENT3";
                ACCENT4: "ACCENT4";
                ACCENT5: "ACCENT5";
                ACCENT6: "ACCENT6";
                LINK: "LINK";
            }>, z.ZodString]>;
            bold: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>;
        band1: z.ZodUnion<readonly [z.ZodEnum<{
            TEXT: "TEXT";
            BACKGROUND: "BACKGROUND";
            ACCENT1: "ACCENT1";
            ACCENT2: "ACCENT2";
            ACCENT3: "ACCENT3";
            ACCENT4: "ACCENT4";
            ACCENT5: "ACCENT5";
            ACCENT6: "ACCENT6";
            LINK: "LINK";
        }>, z.ZodString]>;
        band2: z.ZodUnion<readonly [z.ZodEnum<{
            TEXT: "TEXT";
            BACKGROUND: "BACKGROUND";
            ACCENT1: "ACCENT1";
            ACCENT2: "ACCENT2";
            ACCENT3: "ACCENT3";
            ACCENT4: "ACCENT4";
            ACCENT5: "ACCENT5";
            ACCENT6: "ACCENT6";
            LINK: "LINK";
        }>, z.ZodString]>;
        input: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
            TEXT: "TEXT";
            BACKGROUND: "BACKGROUND";
            ACCENT1: "ACCENT1";
            ACCENT2: "ACCENT2";
            ACCENT3: "ACCENT3";
            ACCENT4: "ACCENT4";
            ACCENT5: "ACCENT5";
            ACCENT6: "ACCENT6";
            LINK: "LINK";
        }>, z.ZodString]>>;
        formula: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
            TEXT: "TEXT";
            BACKGROUND: "BACKGROUND";
            ACCENT1: "ACCENT1";
            ACCENT2: "ACCENT2";
            ACCENT3: "ACCENT3";
            ACCENT4: "ACCENT4";
            ACCENT5: "ACCENT5";
            ACCENT6: "ACCENT6";
            LINK: "LINK";
        }>, z.ZodString]>>;
        cross_sheet: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
            TEXT: "TEXT";
            BACKGROUND: "BACKGROUND";
            ACCENT1: "ACCENT1";
            ACCENT2: "ACCENT2";
            ACCENT3: "ACCENT3";
            ACCENT4: "ACCENT4";
            ACCENT5: "ACCENT5";
            ACCENT6: "ACCENT6";
            LINK: "LINK";
        }>, z.ZodString]>>;
        ok: z.ZodUnion<readonly [z.ZodEnum<{
            TEXT: "TEXT";
            BACKGROUND: "BACKGROUND";
            ACCENT1: "ACCENT1";
            ACCENT2: "ACCENT2";
            ACCENT3: "ACCENT3";
            ACCENT4: "ACCENT4";
            ACCENT5: "ACCENT5";
            ACCENT6: "ACCENT6";
            LINK: "LINK";
        }>, z.ZodString]>;
        warn: z.ZodUnion<readonly [z.ZodEnum<{
            TEXT: "TEXT";
            BACKGROUND: "BACKGROUND";
            ACCENT1: "ACCENT1";
            ACCENT2: "ACCENT2";
            ACCENT3: "ACCENT3";
            ACCENT4: "ACCENT4";
            ACCENT5: "ACCENT5";
            ACCENT6: "ACCENT6";
            LINK: "LINK";
        }>, z.ZodString]>;
        flag: z.ZodUnion<readonly [z.ZodEnum<{
            TEXT: "TEXT";
            BACKGROUND: "BACKGROUND";
            ACCENT1: "ACCENT1";
            ACCENT2: "ACCENT2";
            ACCENT3: "ACCENT3";
            ACCENT4: "ACCENT4";
            ACCENT5: "ACCENT5";
            ACCENT6: "ACCENT6";
            LINK: "LINK";
        }>, z.ZodString]>;
        muted: z.ZodUnion<readonly [z.ZodEnum<{
            TEXT: "TEXT";
            BACKGROUND: "BACKGROUND";
            ACCENT1: "ACCENT1";
            ACCENT2: "ACCENT2";
            ACCENT3: "ACCENT3";
            ACCENT4: "ACCENT4";
            ACCENT5: "ACCENT5";
            ACCENT6: "ACCENT6";
            LINK: "LINK";
        }>, z.ZodString]>;
        muted_fill: z.ZodUnion<readonly [z.ZodEnum<{
            TEXT: "TEXT";
            BACKGROUND: "BACKGROUND";
            ACCENT1: "ACCENT1";
            ACCENT2: "ACCENT2";
            ACCENT3: "ACCENT3";
            ACCENT4: "ACCENT4";
            ACCENT5: "ACCENT5";
            ACCENT6: "ACCENT6";
            LINK: "LINK";
        }>, z.ZodString]>;
    }, z.core.$strict>;
    numbers: z.ZodObject<{
        currency: z.ZodString;
        percent: z.ZodString;
        date: z.ZodString;
        integer: z.ZodString;
        decimal: z.ZodOptional<z.ZodString>;
        multiple: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    tabs: z.ZodOptional<z.ZodObject<{
        inputs: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
            TEXT: "TEXT";
            BACKGROUND: "BACKGROUND";
            ACCENT1: "ACCENT1";
            ACCENT2: "ACCENT2";
            ACCENT3: "ACCENT3";
            ACCENT4: "ACCENT4";
            ACCENT5: "ACCENT5";
            ACCENT6: "ACCENT6";
            LINK: "LINK";
        }>, z.ZodString]>>;
        workings: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
            TEXT: "TEXT";
            BACKGROUND: "BACKGROUND";
            ACCENT1: "ACCENT1";
            ACCENT2: "ACCENT2";
            ACCENT3: "ACCENT3";
            ACCENT4: "ACCENT4";
            ACCENT5: "ACCENT5";
            ACCENT6: "ACCENT6";
            LINK: "LINK";
        }>, z.ZodString]>>;
        outputs: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
            TEXT: "TEXT";
            BACKGROUND: "BACKGROUND";
            ACCENT1: "ACCENT1";
            ACCENT2: "ACCENT2";
            ACCENT3: "ACCENT3";
            ACCENT4: "ACCENT4";
            ACCENT5: "ACCENT5";
            ACCENT6: "ACCENT6";
            LINK: "LINK";
        }>, z.ZodString]>>;
    }, z.core.$strict>>;
    gridlines: z.ZodDefault<z.ZodEnum<{
        always_show: "always_show";
        hide_when_banded: "hide_when_banded";
    }>>;
}, z.core.$strict>;
export type Preset = z.infer<typeof presetSchema>;
/**
 * Where preset JSON is looked for, most specific first. A user's own presets
 * in the data directory shadow the ones that ship, which is what lets someone
 * override `park` without editing an installed plugin.
 */
export declare function presetSearchPaths(options?: {
    cwd?: string;
}): string[];
/** Parse preset JSON already in hand. Exported so tests need no files. */
export declare function parsePreset(text: string, source?: string): Preset;
/** Read a named preset off disk, searching the preset paths in order. */
export declare function loadPreset(name: string, options?: {
    cwd?: string;
}): Preset;
/** Every preset name findable on the search paths, nearest first. */
export declare function listPresets(options?: {
    cwd?: string;
}): string[];
/** Header text on header fill must clear WCAG AA for normal text. */
export declare const MIN_HEADER_CONTRAST = 4.5;
/** Below this the two bands read as a rendering artifact rather than as bands. */
export declare const MIN_BAND_SEPARATION = 1.02;
/** Above this the banding stripes louder than the data. */
export declare const MAX_BAND_SEPARATION = 1.6;
export interface PresetProblem {
    severity: "error" | "warning";
    message: string;
}
/** Resolve a color token against a preset's own theme, to a literal color. */
export declare function resolveToken(preset: Preset, token: string): Color;
/**
 * Everything wrong with a preset. Errors refuse the preset; warnings are
 * reported alongside the sheet so a person can decide.
 */
export declare function checkPreset(preset: Preset): PresetProblem[];
/** Refuse a preset that fails a hard check. Returns the warnings. */
export declare function validatePreset(preset: Preset): string[];
export interface PresetSources {
    /** Named directly on the call. Wins over everything. */
    argument?: string;
    /** From the spreadsheet's own `gsheets.manifest` or `gsheets.sheet` metadata. */
    manifest?: string;
    /** From `.claude/gsheets-pro.json`, for a spreadsheet the repo knows about. */
    registry?: string;
    /** Overrides `GSHEETS_PRO_DEFAULT_PRESET`, for tests. */
    envDefault?: string;
    /** From `<data dir>/config.json`, a person's own default. */
    dataDir?: string;
}
export interface ResolvedPresetName {
    name: string;
    source: "argument" | "manifest" | "registry" | "env_default" | "data_dir" | "default";
}
/**
 * Which preset applies. The order runs from the most specific statement of
 * intent to the least: what this call asked for, what the spreadsheet says
 * about itself, what the repo says about this spreadsheet, what `GSHEETS_PRO_DEFAULT_PRESET`
 * says (how the gsheets-pro-local plugin passes a person's own default,
 * configured through `/plugin` rather than written to a file), what this
 * person's own `<data dir>/config.json` says, and finally the neutral
 * default. The environment variable outranks the config file because it
 * reflects this process's own, current configuration; the file is a
 * lower-level, self-hosted mechanism that predates it.
 */
export declare function resolvePresetName(sources?: PresetSources): ResolvedPresetName;
/** A person's own defaults, `<data dir>/config.json`. Absent is the norm. */
export declare function readDataDirDefaults(): {
    preset?: string;
    archetype?: Archetype;
};
/** Archetype follows the same order, then the preset's own default. */
export declare function resolveArchetype(preset: Preset, sources?: {
    argument?: Archetype;
    manifest?: Archetype;
    registry?: Archetype;
}): Archetype;
/** The `SpreadsheetTheme` shape the API takes, all nine pairs. */
export interface SpreadsheetThemeWrite {
    primaryFontFamily: string;
    themeColors: Array<{
        colorType: ThemeSlot;
        color: {
            rgbColor: Color;
        };
    }>;
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
    banding: {
        header?: ColorStyle;
        first: ColorStyle;
        second: ColorStyle;
    };
    /** Whether banding belongs on this archetype at all. */
    bandingApplies: boolean;
    numberFormats: Record<string, NumberFormat>;
    tabColors: Partial<Record<"inputs" | "workings" | "outputs", ColorStyle>>;
    /** True when gridlines should come off on a banded sheet. */
    hideGridlinesWhenBanded: boolean;
    warnings: string[];
}
/** A color token to the ColorStyle a write should carry. */
export declare function tokenToColorStyle(token: string): ColorStyle;
/** The existing theme as the API hands it back, so missing slots can be kept. */
export interface CurrentTheme {
    primaryFontFamily?: string | null;
    themeColors?: Array<{
        colorType?: string | null;
        color?: {
            rgbColor?: {
                red?: number | null;
                green?: number | null;
                blue?: number | null;
            } | null;
        } | null;
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
export declare function compileTheme(preset: Preset, options?: CompileOptions): CompiledTheme;
/**
 * The CellFormat for one role, or a refusal that explains the archetype.
 */
export declare function roleFormat(compiled: CompiledTheme, role: string): CellFormat;
/** The manifest metadata value a theme write records on the spreadsheet. */
export declare function manifestValue(compiled: CompiledTheme, now?: Date): string;
export {};
//# sourceMappingURL=theme.d.ts.map