/**
 * Colors: hex, named, and theme slots.
 *
 * Sheets has two ways to say what color a thing is. The old `Color` is literal
 * RGB. The newer `ColorStyle` is either literal RGB or a `themeColor` slot that
 * follows the spreadsheet's theme. We prefer the slot wherever the API accepts
 * a ColorStyle, because it keeps Format > Theme working as the human's knob:
 * they change the theme in the UI and everything the plugin painted follows.
 */
export interface Color {
    red: number;
    green: number;
    blue: number;
}
/** The nine slots a spreadsheet theme defines. All must be set when writing a theme. */
export declare const THEME_SLOTS: readonly ["TEXT", "BACKGROUND", "ACCENT1", "ACCENT2", "ACCENT3", "ACCENT4", "ACCENT5", "ACCENT6", "LINK"];
export type ThemeSlot = (typeof THEME_SLOTS)[number];
export interface ColorStyle {
    rgbColor?: Color;
    themeColor?: ThemeSlot;
}
export declare const COLOR_NAMES: string[];
/** True for "theme:ACCENT1" and for a bare slot name like "ACCENT1". */
export declare function isThemeSlotSpec(input: string): boolean;
/** "theme:ACCENT1", "theme.accent1", or a bare "ACCENT1" -> "ACCENT1". */
export declare function parseThemeSlot(input: string): ThemeSlot | undefined;
/** Accept "#RRGGBB", "RRGGBB", "#RGB", or one of COLOR_NAMES. */
export declare function parseColor(input: string): Color;
/**
 * The ColorStyle form: a theme slot when the caller named one, literal RGB
 * otherwise. This is what every write path should use.
 */
export declare function parseColorStyle(input: string): ColorStyle;
/** Render a Sheets Color back to hex for readable output. */
export declare function colorToHex(color: {
    red?: number | null;
    green?: number | null;
    blue?: number | null;
}): string;
/**
 * Render a ColorStyle the way a person would say it: the slot name when it is a
 * theme color, hex when it is literal. Used in every prose response so the
 * reader can see whether a color follows the theme.
 */
export declare function colorStyleToText(style: {
    rgbColor?: {
        red?: number | null;
        green?: number | null;
        blue?: number | null;
    } | null;
    themeColor?: string | null;
} | null | undefined): string | undefined;
/** WCAG relative luminance of a 0..1 RGB color. */
export declare function relativeLuminance(color: Color): number;
/** WCAG contrast ratio, 1 through 21. Body text wants 4.5 or better. */
export declare function contrastRatio(a: Color, b: Color): number;
//# sourceMappingURL=colors.d.ts.map