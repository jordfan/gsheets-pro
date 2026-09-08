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
import { type ColorStyle, type ThemeSlot } from "./colors.js";
export declare const DEFAULT_PRESET = "neutral";
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
    fonts: {
        primary: string;
        display?: string;
        banned?: string[];
    };
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
        muted_fill: string;
    };
    numbers: {
        currency: string;
        percent: string;
        date: string;
        integer: string;
        decimal?: string;
        multiple?: string;
    };
    tabs?: {
        inputs?: string;
        workings?: string;
        outputs?: string;
    };
    gridlines?: "always_show" | "hide_when_banded";
}
/** The role names a caller may pass anywhere a fill is accepted. */
export declare const FILL_ROLES: readonly ["header", "band1", "band2", "ok", "warn", "flag", "muted"];
export type FillRole = (typeof FILL_ROLES)[number];
/** The four roles that stand in for the chip colors the API cannot set. */
export declare const STATUS_ROLES: readonly ["ok", "warn", "flag", "muted"];
export type StatusRole = (typeof STATUS_ROLES)[number];
/**
 * Where the preset files live. `GSHEETS_PRO_PRESETS` wins, so a host can ship
 * its own palettes; otherwise they come from the plugin directory beside the
 * built code. `src/lib` and `dist/lib` sit at the same depth, so one relative
 * path serves both the tests and the shipped server.
 */
export declare function presetDirectory(): string;
/** Preset names available on this host, in alphabetical order. */
export declare function availablePresets(): string[];
/** Validate the shape we depend on. The JSON schema is the full contract. */
export declare function parsePreset(raw: unknown, name: string): Preset;
/** Load a preset by name, cached at module scope. */
export declare function loadPreset(name?: string): Preset;
/** Forget loaded presets. For tests, and for `doctor` after an edit. */
export declare function resetPresetCache(): void;
/**
 * Turn a fill spec into a ColorStyle. The spec is a role name from the preset,
 * a theme slot, or a hex value, in that order of preference: a role survives a
 * change of preset, a slot survives a change of theme, and hex survives nothing.
 */
export declare function resolveFill(preset: Preset, spec: string): ColorStyle;
export declare function fillHint(preset: Preset): string;
/** The text color for a role's fill, when the preset pairs one with it. */
export declare function resolveHeaderText(preset: Preset): ColorStyle;
/** The font color that marks a cell as a human's input, per the preset. */
export declare function resolveInputText(preset: Preset): ColorStyle | undefined;
/** The text color for secondary content: footnotes, source lines, units. */
export declare function resolveMutedText(preset: Preset): ColorStyle;
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
export declare function tableRowsProperties(preset: Preset): TableRowsProperties;
/** The number format pattern a Table column type should carry, if any. */
export declare function numberFormatForColumnType(preset: Preset, columnType: string | undefined): {
    type: string;
    pattern: string;
} | undefined;
/** The number format for a Settings row, named the way a person would say it. */
export declare const SETTINGS_FORMATS: readonly ["currency", "percent", "date", "integer", "decimal", "multiple", "text"];
export type SettingsFormat = (typeof SETTINGS_FORMATS)[number];
export declare function numberFormatForSettings(preset: Preset, format: SettingsFormat | undefined): {
    type: string;
    pattern: string;
} | undefined;
//# sourceMappingURL=tablecolors.d.ts.map