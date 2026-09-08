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
export const THEME_SLOTS = [
  "TEXT",
  "BACKGROUND",
  "ACCENT1",
  "ACCENT2",
  "ACCENT3",
  "ACCENT4",
  "ACCENT5",
  "ACCENT6",
  "LINK",
] as const;

export type ThemeSlot = (typeof THEME_SLOTS)[number];

export interface ColorStyle {
  rgbColor?: Color;
  themeColor?: ThemeSlot;
}

const NAMED_COLORS: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
  red: "#ff0000",
  green: "#00b050",
  blue: "#0070c0",
  yellow: "#ffff00",
  orange: "#ff9900",
  gray: "#808080",
  grey: "#808080",
  lightgray: "#d9d9d9",
  lightgrey: "#d9d9d9",
  lightblue: "#cfe2f3",
  lightgreen: "#d9ead3",
  lightyellow: "#fff2cc",
};

export const COLOR_NAMES = Object.keys(NAMED_COLORS).sort();

function normalizeKey(input: string): string {
  return input.trim().toLowerCase().replace(/[\s_-]/g, "");
}

/** True for "theme:ACCENT1" and for a bare slot name like "ACCENT1". */
export function isThemeSlotSpec(input: string): boolean {
  return parseThemeSlot(input) !== undefined;
}

/** "theme:ACCENT1", "theme.accent1", or a bare "ACCENT1" -> "ACCENT1". */
export function parseThemeSlot(input: string): ThemeSlot | undefined {
  if (typeof input !== "string") return undefined;
  const body = input.trim().replace(/^theme\s*[:.]\s*/i, "");
  const wanted = body.trim().toUpperCase().replace(/[\s_-]/g, "");
  return (THEME_SLOTS as readonly string[]).includes(wanted) ? (wanted as ThemeSlot) : undefined;
}

/** Accept "#RRGGBB", "RRGGBB", "#RGB", or one of COLOR_NAMES. */
export function parseColor(input: string): Color {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error(`Could not parse color: ${JSON.stringify(input)}`);
  }
  const raw = input.trim();
  if (parseThemeSlot(raw)) {
    throw new Error(
      `"${input}" is a theme slot, which only fits fields that take a ColorStyle. Use a hex color like #RRGGBB here.`,
    );
  }
  const named = NAMED_COLORS[normalizeKey(raw)];
  const hex = (named ?? raw).replace(/^#/, "");

  let full: string;
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    full = hex;
  } else if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    full = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  } else {
    throw new Error(
      `Could not parse color "${input}". Use #RRGGBB, a theme slot like theme:ACCENT1, or one of: ${COLOR_NAMES.join(", ")}.`,
    );
  }

  return {
    red: parseInt(full.slice(0, 2), 16) / 255,
    green: parseInt(full.slice(2, 4), 16) / 255,
    blue: parseInt(full.slice(4, 6), 16) / 255,
  };
}

/**
 * The ColorStyle form: a theme slot when the caller named one, literal RGB
 * otherwise. This is what every write path should use.
 */
export function parseColorStyle(input: string): ColorStyle {
  const slot = parseThemeSlot(input);
  if (slot) return { themeColor: slot };
  return { rgbColor: parseColor(input) };
}

/** Render a Sheets Color back to hex for readable output. */
export function colorToHex(color: {
  red?: number | null;
  green?: number | null;
  blue?: number | null;
}): string {
  const byte = (v?: number | null) =>
    Math.round(Math.min(1, Math.max(0, v ?? 0)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${byte(color.red)}${byte(color.green)}${byte(color.blue)}`;
}

/**
 * Render a ColorStyle the way a person would say it: the slot name when it is a
 * theme color, hex when it is literal. Used in every prose response so the
 * reader can see whether a color follows the theme.
 */
export function colorStyleToText(style: {
  rgbColor?: { red?: number | null; green?: number | null; blue?: number | null } | null;
  themeColor?: string | null;
} | null | undefined): string | undefined {
  if (!style) return undefined;
  if (style.themeColor) return `theme:${style.themeColor}`;
  if (style.rgbColor) return colorToHex(style.rgbColor);
  return undefined;
}

// ---------------------------------------------------------------------------
// Contrast, for the preset validator
// ---------------------------------------------------------------------------

function channelLuminance(v: number): number {
  const c = Math.min(1, Math.max(0, v));
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of a 0..1 RGB color. */
export function relativeLuminance(color: Color): number {
  return (
    0.2126 * channelLuminance(color.red) +
    0.7152 * channelLuminance(color.green) +
    0.0722 * channelLuminance(color.blue)
  );
}

/** WCAG contrast ratio, 1 through 21. Body text wants 4.5 or better. */
export function contrastRatio(a: Color, b: Color): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return (light + 0.05) / (dark + 0.05);
}
