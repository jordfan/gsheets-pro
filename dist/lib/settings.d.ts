/**
 * The Settings block: the assumptions a spreadsheet runs on, written down.
 *
 * A model whose numbers are typed into the middle of its formulas cannot be
 * checked by anybody, including the person who wrote it. The convention a
 * careful human follows is a block near the top: one row per assumption, with a
 * label, the value, its unit, and where the number came from. Every value cell
 * gets a named range, so the formulas downstream read `FeePerSession * Sessions`
 * rather than `$B$4 * D2`.
 *
 * This file is the layout and the naming, both pure. The tool turns what it
 * returns into one batchUpdate.
 */
import type { SettingsFormat } from "./tablecolors.js";
export interface SettingsItem {
    /** What the assumption is called, in a person's words. */
    label: string;
    /** The value. A string starting with "=" is written as a formula. */
    value?: string | number | boolean;
    /** Dollars, sessions, percent: whatever the number is counted in. */
    unit?: string;
    /** Where the number came from, which is the part everyone forgets. */
    source?: string;
    /** How the value should read. Defaults to text. */
    format?: SettingsFormat;
    /** The named range to create. Derived from the label when omitted. */
    name?: string;
    /** Pass false for a row that should carry no named range. */
    named?: boolean;
    /** A note on the label cell, for anything that needs a sentence. */
    note?: string;
}
export declare const SETTINGS_HEADERS: readonly ["Setting", "Value", "Unit", "Source"];
export interface SettingsLayoutOptions {
    /** One based row the block starts on. Default 1. */
    startRow?: number;
    /** Zero based column the block starts on. Default 0, which is column A. */
    startColumn?: number;
    /** A heading above the block. Omit for no heading. */
    title?: string;
    /** Named range names already in use in the spreadsheet. */
    taken?: Iterable<string>;
}
export interface SettingsRow {
    item: SettingsItem;
    /** One based sheet row. */
    row: number;
    /** A1 of the value cell, without the tab name. */
    valueA1: string;
    /** The named range for the value cell, when the row gets one. */
    namedRange?: string;
}
export interface SettingsLayout {
    /** One based row of the title, when there is one. */
    titleRow?: number;
    headerRow: number;
    firstDataRow: number;
    lastDataRow: number;
    startColumn: number;
    /** Always four: label, value, unit, source. */
    width: number;
    rows: SettingsRow[];
    /** A1 of the whole block, header included, without the tab name. */
    blockA1: string;
    /** A1 of the value column's data cells. */
    valueColumnA1: string;
}
/** True when a name would be read as a cell reference rather than a name. */
export declare function looksLikeReference(name: string): boolean;
/**
 * Turn a label into a name Sheets will accept, and that a person reading a
 * formula will recognise: "Fee per session" becomes `Fee_per_session`.
 *
 * Sheets accepts letters, digits and underscores, will not take a name that
 * starts with a digit, and rejects anything that could be a cell reference.
 */
export declare function sanitizeNamedRange(label: string, taken?: Set<string>): string;
/** Where every part of the block lands, before a single request is built. */
export declare function layoutSettingsBlock(items: SettingsItem[], options?: SettingsLayoutOptions): SettingsLayout;
/** The four cell values of one settings row, in column order. */
export declare function settingsRowValues(item: SettingsItem): Array<string | number | boolean | undefined>;
/** True when a value should be written as a formula rather than as text. */
export declare function isFormula(value: unknown): boolean;
//# sourceMappingURL=settings.d.ts.map