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
import { columnIndexToLetter } from "./a1.js";
import { GsheetsError } from "./errors.js";
export const SETTINGS_HEADERS = ["Setting", "Value", "Unit", "Source"];
// ---------------------------------------------------------------------------
// Named ranges
// ---------------------------------------------------------------------------
const RESERVED = new Set(["true", "false"]);
/** True when a name would be read as a cell reference rather than a name. */
export function looksLikeReference(name) {
    return /^[A-Za-z]{1,3}[0-9]+$/.test(name) || /^[Rr][0-9]+[Cc][0-9]+$/.test(name);
}
/**
 * Turn a label into a name Sheets will accept, and that a person reading a
 * formula will recognise: "Fee per session" becomes `Fee_per_session`.
 *
 * Sheets accepts letters, digits and underscores, will not take a name that
 * starts with a digit, and rejects anything that could be a cell reference.
 */
export function sanitizeNamedRange(label, taken = new Set()) {
    const base = String(label ?? "").trim();
    if (!base) {
        throw new GsheetsError("invalid_argument", "A settings row needs a label.", "The label is what the row is called, and it is also where the named range's name comes from.");
    }
    let name = base
        .normalize("NFKD")
        .replace(/[^A-Za-z0-9]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    if (!name)
        name = "Setting";
    if (/^[0-9]/.test(name))
        name = `_${name}`;
    if (looksLikeReference(name) || RESERVED.has(name.toLowerCase()))
        name = `${name}_`;
    if (name.length > 250)
        name = name.slice(0, 250);
    const lower = new Set([...taken].map((t) => t.toLowerCase()));
    if (!lower.has(name.toLowerCase()))
        return name;
    for (let n = 2; n < 1000; n += 1) {
        const candidate = `${name}_${n}`;
        if (!lower.has(candidate.toLowerCase()))
            return candidate;
    }
    throw new GsheetsError("invalid_argument", `Could not find a free named range based on "${label}".`, "Pass name explicitly on that settings row.");
}
// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
/** Where every part of the block lands, before a single request is built. */
export function layoutSettingsBlock(items, options = {}) {
    if (!items.length) {
        throw new GsheetsError("invalid_argument", "A settings block needs at least one row.", 'Pass items, for example items: [{ label: "Fee per session", value: 55, unit: "dollars", source: "2026-27 vendor agreement" }].');
    }
    const startRow = options.startRow ?? 1;
    const startColumn = options.startColumn ?? 0;
    const titleRow = options.title ? startRow : undefined;
    const headerRow = titleRow ? startRow + 1 : startRow;
    const firstDataRow = headerRow + 1;
    const taken = new Set(options.taken ?? []);
    const rows = items.map((item, index) => {
        const row = firstDataRow + index;
        const valueA1 = `${columnIndexToLetter(startColumn + 1)}${row}`;
        const entry = { item, row, valueA1 };
        if (item.named !== false) {
            const name = item.name?.trim() ? sanitizeNamedRange(item.name, taken) : sanitizeNamedRange(item.label, taken);
            taken.add(name);
            entry.namedRange = name;
        }
        return entry;
    });
    const lastDataRow = firstDataRow + items.length - 1;
    const firstLetter = columnIndexToLetter(startColumn);
    const lastLetter = columnIndexToLetter(startColumn + 3);
    const valueLetter = columnIndexToLetter(startColumn + 1);
    const layout = {
        headerRow,
        firstDataRow,
        lastDataRow,
        startColumn,
        width: SETTINGS_HEADERS.length,
        rows,
        blockA1: `${firstLetter}${headerRow}:${lastLetter}${lastDataRow}`,
        valueColumnA1: `${valueLetter}${firstDataRow}:${valueLetter}${lastDataRow}`,
    };
    if (titleRow)
        layout.titleRow = titleRow;
    return layout;
}
/** The four cell values of one settings row, in column order. */
export function settingsRowValues(item) {
    return [item.label, item.value, item.unit, item.source];
}
/** True when a value should be written as a formula rather than as text. */
export function isFormula(value) {
    return typeof value === "string" && value.trim().startsWith("=");
}
//# sourceMappingURL=settings.js.map