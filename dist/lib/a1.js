/**
 * A1 notation, GridRange conversion, and column/row spans.
 *
 * Pure and dependency free so every case can be tested offline. The Sheets API
 * speaks numeric sheet ids and half open GridRanges; humans speak tab names and
 * A1. Everything in the tool surface is the human form, and this file is the
 * translation layer.
 */
// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------
/** "A" -> 0, "Z" -> 25, "AA" -> 26. Throws on anything else. */
export function columnLetterToIndex(letters) {
    const s = String(letters ?? "").trim().toUpperCase();
    if (!/^[A-Z]{1,3}$/.test(s)) {
        throw new Error(`Not a column letter: "${letters}". Expected A through ZZZ.`);
    }
    let n = 0;
    for (const ch of s)
        n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}
/** 0 -> "A", 26 -> "AA". */
export function columnIndexToLetter(index) {
    if (!Number.isInteger(index) || index < 0) {
        throw new Error(`Not a column index: ${index}`);
    }
    let n = index + 1;
    let out = "";
    while (n > 0) {
        const rem = (n - 1) % 26;
        out = String.fromCharCode(65 + rem) + out;
        n = Math.floor((n - 1) / 26);
    }
    return out;
}
/**
 * Split "'My Sheet'!A1:B2" into its tab name and its A1 body.
 *
 * Quoted names are the hard case: a tab may legitimately contain "!" or ":",
 * and Sheets escapes an apostrophe inside a quoted name by doubling it. So a
 * quoted qualifier is scanned character by character rather than searched for
 * the last "!", which is what a naive split gets wrong on 'Q1!Draft'!A1.
 */
export function splitSheetRange(input) {
    const s = String(input ?? "").trim();
    if (!s)
        return { range: "" };
    if (s.startsWith("'")) {
        let name = "";
        let i = 1;
        let closed = false;
        while (i < s.length) {
            const ch = s[i];
            if (ch === "'") {
                if (s[i + 1] === "'") {
                    name += "'";
                    i += 2;
                    continue;
                }
                closed = true;
                i += 1;
                break;
            }
            name += ch;
            i += 1;
        }
        if (!closed) {
            throw new Error(`Unbalanced quote in range "${input}". A quoted tab name needs a closing '.`);
        }
        const rest = s.slice(i).trim();
        if (rest === "")
            return { sheet: name, range: "" };
        if (!rest.startsWith("!")) {
            throw new Error(`Expected "!" after the tab name in "${input}", for example 'My Sheet'!A1:C10.`);
        }
        return { sheet: name, range: rest.slice(1).trim() };
    }
    const bang = s.indexOf("!");
    if (bang === -1)
        return { range: s };
    return { sheet: s.slice(0, bang).trim(), range: s.slice(bang + 1).trim() };
}
/** Strip a leading sheet qualifier: "'My Sheet'!A1:B2" -> "A1:B2". */
export function stripSheetPrefix(range) {
    return splitSheetRange(range).range;
}
/** Quote a tab name for use in an A1 range: My Sheet -> 'My Sheet'. */
export function quoteSheetName(name) {
    return `'${String(name).replace(/'/g, "''")}'`;
}
/** Build a fully qualified A1 reference: ("My Sheet", "A1:C10") -> "'My Sheet'!A1:C10". */
export function toA1Reference(sheet, range) {
    const body = String(range ?? "").trim();
    return body ? `${quoteSheetName(sheet)}!${body}` : quoteSheetName(sheet);
}
function parseCellRef(part, whole) {
    const s = part.trim().replace(/\$/g, "");
    const m = /^([A-Za-z]{1,3})?([0-9]+)?$/.exec(s);
    if (!s || !m || (m[1] === undefined && m[2] === undefined)) {
        throw new Error(`Could not parse A1 range "${whole}". Expected something like A1, A1:C10, B:B, or 3:3.`);
    }
    const ref = {};
    if (m[1] !== undefined)
        ref.col = columnLetterToIndex(m[1]);
    if (m[2] !== undefined) {
        const row = Number(m[2]);
        if (!Number.isInteger(row) || row < 1) {
            throw new Error(`Row numbers in "${whole}" start at 1.`);
        }
        ref.row = row - 1;
    }
    return ref;
}
/**
 * Convert A1 notation to the row/column half of a GridRange.
 *
 * Bounds are half open the way the Sheets API wants them, and an axis the
 * notation leaves open (the rows of "B:B", the columns of "3:3") is simply
 * absent, which the API reads as "the whole sheet on that axis".
 */
export function parseA1(range) {
    if (typeof range !== "string") {
        throw new Error(`Could not parse A1 range: ${JSON.stringify(range)}`);
    }
    const body = stripSheetPrefix(range).trim();
    if (!body)
        throw new Error("Range is empty. Expected something like A1:C10.");
    const parts = body.split(":");
    if (parts.length > 2) {
        throw new Error(`Could not parse A1 range "${range}". Too many ":" separators.`);
    }
    const start = parseCellRef(parts[0], range);
    const end = parts.length === 2 ? parseCellRef(parts[1], range) : start;
    const bounds = {};
    const cols = [start.col, end.col].filter((v) => v !== undefined);
    if (cols.length) {
        // A single sided ref such as "A1:C" bounds only the side it names.
        if (cols.length === 2) {
            bounds.startColumnIndex = Math.min(cols[0], cols[1]);
            bounds.endColumnIndex = Math.max(cols[0], cols[1]) + 1;
        }
        else if (start.col !== undefined) {
            bounds.startColumnIndex = start.col;
            if (parts.length === 1)
                bounds.endColumnIndex = start.col + 1;
        }
        else {
            bounds.endColumnIndex = end.col + 1;
        }
    }
    const rows = [start.row, end.row].filter((v) => v !== undefined);
    if (rows.length) {
        if (rows.length === 2) {
            bounds.startRowIndex = Math.min(rows[0], rows[1]);
            bounds.endRowIndex = Math.max(rows[0], rows[1]) + 1;
        }
        else if (start.row !== undefined) {
            bounds.startRowIndex = start.row;
            if (parts.length === 1)
                bounds.endRowIndex = start.row + 1;
        }
        else {
            bounds.endRowIndex = end.row + 1;
        }
    }
    return bounds;
}
/** parseA1 plus a sheetId. An absent or empty range means the whole sheet. */
export function a1ToGridRange(range, sheetId) {
    if (range === undefined || range === null || String(range).trim() === "") {
        return { sheetId };
    }
    return { sheetId, ...parseA1(range) };
}
/** Render a GridRange back to A1 for human readable output. */
export function gridRangeToA1(range) {
    const startRowIndex = range.startRowIndex ?? undefined;
    const endRowIndex = range.endRowIndex ?? undefined;
    const startColumnIndex = range.startColumnIndex ?? undefined;
    const endColumnIndex = range.endColumnIndex ?? undefined;
    const hasCols = startColumnIndex !== undefined || endColumnIndex !== undefined;
    const hasRows = startRowIndex !== undefined || endRowIndex !== undefined;
    if (!hasCols && !hasRows)
        return "the whole sheet";
    const c1 = startColumnIndex !== undefined ? columnIndexToLetter(startColumnIndex) : "";
    const c2 = endColumnIndex !== undefined ? columnIndexToLetter(endColumnIndex - 1) : "";
    const r1 = startRowIndex !== undefined ? String(startRowIndex + 1) : "";
    const r2 = endRowIndex !== undefined ? String(endRowIndex) : "";
    const startCell = `${c1}${r1}`;
    const endCell = `${c2}${r2}`;
    // Collapse to one cell only when both axes are bounded to a single cell. A
    // whole column stays "B:B" rather than the ambiguous "B".
    if (hasCols && hasRows && startCell && startCell === endCell)
        return startCell;
    return `${startCell}:${endCell}`;
}
/** How many cells a range covers, or undefined when an axis is unbounded. */
export function rangeCellCount(range) {
    const startRowIndex = range.startRowIndex ?? undefined;
    const endRowIndex = range.endRowIndex ?? undefined;
    const startColumnIndex = range.startColumnIndex ?? undefined;
    const endColumnIndex = range.endColumnIndex ?? undefined;
    if (startRowIndex === undefined ||
        endRowIndex === undefined ||
        startColumnIndex === undefined ||
        endColumnIndex === undefined) {
        return undefined;
    }
    return (endRowIndex - startRowIndex) * (endColumnIndex - startColumnIndex);
}
/**
 * The smallest range covering both inputs, used to build the one masked read
 * that closes a write. Two ranges on different sheets cannot be merged.
 */
export function unionBounds(a, b) {
    const pick = (x, y, fn) => {
        // An absent bound means unbounded, which swallows the other side.
        if (x === null || x === undefined)
            return undefined;
        if (y === null || y === undefined)
            return undefined;
        return fn(x, y);
    };
    const out = {};
    const sr = pick(a.startRowIndex, b.startRowIndex, Math.min);
    const er = pick(a.endRowIndex, b.endRowIndex, Math.max);
    const sc = pick(a.startColumnIndex, b.startColumnIndex, Math.min);
    const ec = pick(a.endColumnIndex, b.endColumnIndex, Math.max);
    if (sr !== undefined)
        out.startRowIndex = sr;
    if (er !== undefined)
        out.endRowIndex = er;
    if (sc !== undefined)
        out.startColumnIndex = sc;
    if (ec !== undefined)
        out.endColumnIndex = ec;
    return out;
}
// ---------------------------------------------------------------------------
// Column and row spans ("A", "B:D", "1", "2:5")
// ---------------------------------------------------------------------------
/** "A" -> 0..1, "B:D" -> 1..4. */
export function parseColumnSpan(spec) {
    const body = stripSheetPrefix(String(spec ?? "")).trim().replace(/\$/g, "");
    const m = /^([A-Za-z]{1,3})(?::([A-Za-z]{1,3}))?$/.exec(body);
    if (!m) {
        throw new Error(`Could not parse column span "${spec}". Expected something like A or B:D.`);
    }
    const a = columnLetterToIndex(m[1]);
    const b = m[2] ? columnLetterToIndex(m[2]) : a;
    return { startIndex: Math.min(a, b), endIndex: Math.max(a, b) + 1 };
}
/** "1" -> 0..1, "2:5" -> 1..5. */
export function parseRowSpan(spec) {
    const body = stripSheetPrefix(String(spec ?? "")).trim().replace(/\$/g, "");
    const m = /^([0-9]+)(?::([0-9]+))?$/.exec(body);
    if (!m) {
        throw new Error(`Could not parse row span "${spec}". Expected something like 1 or 2:5.`);
    }
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < 1)
        throw new Error(`Row numbers in "${spec}" start at 1.`);
    return { startIndex: Math.min(a, b) - 1, endIndex: Math.max(a, b) };
}
/** "1 request" / "3 requests". */
export function pluralize(count, singular, plural) {
    return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}
//# sourceMappingURL=a1.js.map