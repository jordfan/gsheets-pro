/**
 * Rows as records.
 *
 * A grid of cells is what the API returns and almost never what the caller
 * wants. `[["Ana","3"],["Bo","4"]]` forces the model to remember that column 2
 * is the grade; `{ name: "Ana", grade: "3", _row: 2 }` does not. So reads hand
 * back records keyed by header.
 *
 * Every record carries `_row`, the real one based row number in the sheet. It
 * is the difference between "update Ana's grade" working and quietly writing to
 * the wrong line after someone sorted the tab. Filtering never renumbers it.
 */
import { columnIndexToLetter, columnLetterToIndex } from "./a1.js";
import { err } from "./errors.js";
/**
 * Turn header text into stable keys: blanks become their column letter,
 * duplicates get a numeric suffix, so no column is silently lost.
 */
export function normalizeHeaders(headers, width) {
    const target = Math.max(width ?? 0, headers.length);
    const out = [];
    const seen = new Map();
    for (let i = 0; i < target; i += 1) {
        const raw = String(headers[i] ?? "").trim();
        let key = raw || columnIndexToLetter(i);
        const count = seen.get(key.toLowerCase()) ?? 0;
        seen.set(key.toLowerCase(), count + 1);
        if (count > 0)
            key = `${key} (${count + 1})`;
        out.push(key);
    }
    return out;
}
/** Zip a grid of values against headers, stamping the true row number on each. */
export function toRecords(rows, headers, options) {
    const skipBlank = options.skipBlank !== false;
    const out = [];
    for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i] ?? [];
        if (skipBlank && row.every((cell) => cell === null || cell === undefined || cell === "")) {
            continue;
        }
        const record = { _row: options.firstDataRow + i };
        for (let c = 0; c < headers.length; c += 1) {
            const value = row[c];
            record[headers[c]] = value === undefined ? "" : value;
        }
        out.push(record);
    }
    return out;
}
// ---------------------------------------------------------------------------
// where
// ---------------------------------------------------------------------------
export const WHERE_OPERATORS = [
    "eq",
    "ne",
    "contains",
    "not_contains",
    "starts_with",
    "ends_with",
    "gt",
    "gte",
    "lt",
    "lte",
    "blank",
    "not_blank",
    "in",
];
function valueFor(record, column, headers) {
    if (column in record)
        return record[column];
    const lower = column.trim().toLowerCase();
    const byHeader = headers.find((h) => h.toLowerCase() === lower);
    if (byHeader)
        return record[byHeader];
    // A column letter is a legitimate way to name a column that has no header.
    if (/^[A-Za-z]{1,3}$/.test(column.trim())) {
        const index = columnLetterToIndex(column);
        const key = headers[index];
        if (key !== undefined)
            return record[key];
    }
    throw err.invalid(`No column named "${column}".`, headers.length
        ? `The columns on this tab are: ${headers.join(", ")}. A column letter such as C works too.`
        : "This tab has no header row, so filter by column letter instead.");
}
const asText = (v) => (v === null || v === undefined ? "" : String(v));
function asNumber(v) {
    if (typeof v === "number")
        return v;
    if (typeof v === "boolean")
        return v ? 1 : 0;
    const text = asText(v).replace(/[$,%\s]/g, "");
    if (text === "")
        return undefined;
    const n = Number(text);
    return Number.isFinite(n) ? n : undefined;
}
/** Compare one record against one clause. Text compares ignore case. */
export function matchesClause(record, clause, headers) {
    const raw = valueFor(record, clause.column, headers);
    const text = asText(raw).trim();
    const lower = text.toLowerCase();
    const target = clause.value;
    const targetText = target === undefined || target === null ? "" : String(target).trim();
    const targetLower = targetText.toLowerCase();
    switch (clause.op) {
        case "blank":
            return text === "";
        case "not_blank":
            return text !== "";
        case "eq":
            return lower === targetLower;
        case "ne":
            return lower !== targetLower;
        case "contains":
            return lower.includes(targetLower);
        case "not_contains":
            return !lower.includes(targetLower);
        case "starts_with":
            return lower.startsWith(targetLower);
        case "ends_with":
            return lower.endsWith(targetLower);
        case "in": {
            const list = Array.isArray(target) ? target : [target];
            return list.some((v) => String(v ?? "").trim().toLowerCase() === lower);
        }
        case "gt":
        case "gte":
        case "lt":
        case "lte": {
            const a = asNumber(raw);
            const b = asNumber(Array.isArray(target) ? (target[0] ?? null) : (target ?? null));
            if (a === undefined || b === undefined) {
                // Fall back to text ordering so date strings and names still compare.
                const cmp = lower.localeCompare(targetLower);
                if (clause.op === "gt")
                    return cmp > 0;
                if (clause.op === "gte")
                    return cmp >= 0;
                if (clause.op === "lt")
                    return cmp < 0;
                return cmp <= 0;
            }
            if (clause.op === "gt")
                return a > b;
            if (clause.op === "gte")
                return a >= b;
            if (clause.op === "lt")
                return a < b;
            return a <= b;
        }
        default:
            throw err.invalid(`Unknown filter operator "${String(clause.op)}".`, `Use one of: ${WHERE_OPERATORS.join(", ")}.`);
    }
}
/** All clauses must match, which is what a person means by a filter. */
export function applyWhere(records, clauses, headers) {
    if (!clauses || clauses.length === 0)
        return records;
    return records.filter((record) => clauses.every((clause) => matchesClause(record, clause, headers)));
}
/** Search one tab's grid. Pure, so `find` across tabs is just a loop. */
export function findInGrid(sheet, rows, options, headers) {
    const limit = options.limit ?? 100;
    const hits = [];
    let test;
    if (options.regex) {
        let re;
        try {
            re = new RegExp(options.query, options.matchCase ? "" : "i");
        }
        catch (error) {
            throw err.invalid(`"${options.query}" is not a valid regular expression: ${error.message}`, "Drop the regex option to search for the text literally.");
        }
        test = (value) => re.test(value);
    }
    else {
        const needle = options.matchCase ? options.query : options.query.toLowerCase();
        test = (value) => {
            const haystack = options.matchCase ? value : value.toLowerCase();
            return options.wholeCell ? haystack.trim() === needle.trim() : haystack.includes(needle);
        };
    }
    for (let r = 0; r < rows.length && hits.length < limit; r += 1) {
        const row = rows[r] ?? [];
        for (let c = 0; c < row.length && hits.length < limit; c += 1) {
            const value = asText(row[c]);
            if (value === "" || !test(value))
                continue;
            const letter = columnIndexToLetter(c);
            const hit = {
                sheet,
                cell: `${letter}${r + 1}`,
                row: r + 1,
                column: letter,
                value,
            };
            const header = headers?.[c];
            if (header)
                hit.header = header;
            hits.push(hit);
        }
    }
    return hits;
}
export function paginate(items, offset = 0, limit = 200) {
    const start = Math.max(0, Math.floor(offset));
    const size = Math.max(1, Math.floor(limit));
    const slice = items.slice(start, start + size);
    const page = { items: slice, offset: start, limit: size, total: items.length };
    if (start + slice.length < items.length)
        page.nextOffset = start + slice.length;
    return page;
}
//# sourceMappingURL=records.js.map