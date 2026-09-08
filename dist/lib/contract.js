/**
 * The contract: what this spreadsheet expects of whoever writes to it.
 *
 * Three sources, in decreasing order of confidence.
 *
 * 1. The repo registry. A person wrote it down. It wins.
 * 2. Developer metadata the plugin wrote when it built or adopted the sheet.
 *    Column metadata rides the dimension, so it survives inserts and moves; a
 *    header renamed underneath it shows up as drift rather than as silence.
 * 3. Inference from the sheet itself. This is a reading, not an authority, and
 *    `sheets_open` labels it as such. Guessing a contract and then enforcing it
 *    would be worse than having none, so inference only ever produces advice.
 *
 * When there is no registry entry and no metadata, the honest answer is "no
 * contract", and that is what we say.
 */
import { columnIndexToLetter } from "./a1.js";
import { describePolicy, isColumnWritable, } from "./registry.js";
export const METADATA_KEYS = {
    manifest: "gsheets.manifest",
    sheet: "gsheets.sheet",
    column: "gsheets.column",
};
export const COLUMN_ROLES = [
    "key",
    "input",
    "formula",
    "status",
    "log",
    "check",
];
// ---------------------------------------------------------------------------
// Reading metadata
// ---------------------------------------------------------------------------
function parseJsonValue(value) {
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
/** Flatten `spreadsheets.developerMetadata.search` results into our shape. */
export function toMetadataEntries(raw) {
    const out = [];
    for (const item of raw) {
        const key = item.metadataKey;
        const value = item.metadataValue;
        if (!key || value === undefined || value === null)
            continue;
        const location = item.location ?? {};
        const dimensionRange = location.dimensionRange;
        if (dimensionRange && dimensionRange.sheetId !== undefined && dimensionRange.sheetId !== null) {
            const type = dimensionRange.dimension === "ROWS" ? "ROWS" : "COLUMNS";
            out.push({
                key,
                value,
                scope: type === "ROWS" ? "ROW" : "COLUMN",
                sheetId: dimensionRange.sheetId,
                dimension: {
                    sheetId: dimensionRange.sheetId,
                    type,
                    index: dimensionRange.startIndex ?? 0,
                },
            });
            continue;
        }
        if (location.sheetId !== undefined && location.sheetId !== null) {
            out.push({ key, value, scope: "SHEET", sheetId: location.sheetId });
            continue;
        }
        out.push({ key, value, scope: "SPREADSHEET" });
    }
    return out;
}
export function readManifest(entries) {
    const hit = entries.find((e) => e.key === METADATA_KEYS.manifest && e.scope === "SPREADSHEET");
    return hit ? parseJsonValue(hit.value) : undefined;
}
export function readSheetMetadata(entries, sheetId) {
    const hit = entries.find((e) => e.key === METADATA_KEYS.sheet && e.scope === "SHEET" && e.sheetId === sheetId);
    return hit ? parseJsonValue(hit.value) : undefined;
}
/** Column metadata for one tab, keyed by zero based column index. */
export function readColumnMetadata(entries, sheetId) {
    const out = new Map();
    for (const entry of entries) {
        if (entry.key !== METADATA_KEYS.column)
            continue;
        if (entry.scope !== "COLUMN" || entry.dimension?.sheetId !== sheetId)
            continue;
        const parsed = parseJsonValue(entry.value);
        if (parsed)
            out.set(entry.dimension.index, parsed);
    }
    return out;
}
export function buildContract(input) {
    const { sheet, policy, sheetMetadata, manifest } = input;
    const headers = input.headers ?? [];
    const columnMetadata = input.columnMetadata ?? new Map();
    const hasMetadata = columnMetadata.size > 0 || sheetMetadata !== undefined;
    const source = policy && hasMetadata
        ? "registry+metadata"
        : policy
            ? "registry"
            : hasMetadata
                ? "metadata"
                : "none";
    const width = Math.max(headers.length, ...[...columnMetadata.keys()].map((i) => i + 1), 0);
    const columns = [];
    const drift = [];
    for (let index = 0; index < width; index += 1) {
        const letter = columnIndexToLetter(index);
        const header = headers[index]?.trim() || undefined;
        const meta = columnMetadata.get(index);
        const writability = isColumnWritable(policy, { letter, header });
        const column = {
            letter,
            index,
            writable: writability.writable,
        };
        if (header)
            column.header = header;
        if (meta?.name)
            column.name = meta.name;
        if (meta?.role)
            column.role = meta.role;
        if (meta?.owner)
            column.owner = meta.owner;
        if (meta?.type)
            column.type = meta.type;
        if (meta?.header && header && meta.header !== header) {
            column.drift = `header is now "${header}", metadata recorded "${meta.header}"`;
            drift.push(`Column ${letter}: ${column.drift}.`);
        }
        columns.push(column);
    }
    const contract = {
        sheet,
        source,
        positionalRows: policy?.positionalRows === true,
        colleagueSafeText: policy?.colleagueSafeText === true,
        columns,
        drift,
        summary: "",
    };
    if (policy?.owner)
        contract.owner = policy.owner;
    if (policy?.path)
        contract.registryPath = policy.path;
    const archetype = sheetMetadata?.archetype ?? manifest?.archetype;
    if (archetype)
        contract.archetype = archetype;
    const preset = sheetMetadata?.preset ?? manifest?.preset;
    if (preset)
        contract.preset = preset;
    if (sheetMetadata?.headerRow)
        contract.headerRow = sheetMetadata.headerRow;
    if (sheetMetadata?.keyColumn)
        contract.keyColumn = sheetMetadata.keyColumn;
    contract.summary = summarize(contract, policy);
    return contract;
}
function summarize(contract, policy) {
    if (contract.source === "none") {
        return "No contract. This spreadsheet has no registry entry and no plugin metadata, so nothing here is protected beyond the formula guard. Treat every column as someone else's until told otherwise.";
    }
    const parts = [];
    if (policy)
        parts.push(`Registry (${describePolicy(policy)})`);
    if (contract.source !== "registry") {
        const locked = contract.columns.filter((c) => !c.writable).map((c) => c.letter);
        const roles = contract.columns.filter((c) => c.role).length;
        const bits = [];
        if (roles)
            bits.push(`${roles} of ${contract.columns.length} columns carry a role`);
        if (locked.length)
            bits.push(`columns ${locked.join(", ")} are not ours`);
        if (contract.archetype)
            bits.push(`archetype ${contract.archetype}`);
        parts.push(`Metadata (${bits.join("; ") || "present"})`);
    }
    if (contract.drift.length)
        parts.push(`${contract.drift.length} drift note(s)`);
    return parts.join(". ") + ".";
}
const looksNumeric = (v) => v !== "" && Number.isFinite(Number(v.replace(/[$,%\s]/g, "")));
/**
 * Read the tab the way a person would: find the header row, notice whether the
 * first column is a key, notice whether the tab is one block or several.
 */
export function inferConventions(input) {
    const rows = input.rows ?? [];
    const notes = [];
    let headerIndex;
    if (input.frozenRowCount && input.frozenRowCount > 0) {
        headerIndex = input.frozenRowCount - 1;
    }
    else {
        for (let i = 0; i < Math.min(rows.length, 10); i += 1) {
            const row = rows[i] ?? [];
            const filled = row.filter((c) => String(c ?? "").trim() !== "");
            if (filled.length < 2)
                continue;
            if (filled.every((c) => !looksNumeric(String(c)))) {
                headerIndex = i;
                break;
            }
        }
    }
    const headers = headerIndex !== undefined
        ? (rows[headerIndex] ?? []).map((c) => String(c ?? "").trim())
        : [];
    const firstDataIndex = headerIndex !== undefined ? headerIndex + 1 : 0;
    const dataRows = rows.slice(firstDataIndex).filter((r) => r.some((c) => String(c ?? "").trim()));
    // A blank row between filled rows means the tab holds more than one block,
    // which is the single most common reason an append lands in the wrong place.
    let multipleBlocks = false;
    let sawData = false;
    let sawGap = false;
    for (let i = firstDataIndex; i < rows.length; i += 1) {
        const filled = (rows[i] ?? []).some((c) => String(c ?? "").trim() !== "");
        if (filled) {
            if (sawData && sawGap) {
                multipleBlocks = true;
                break;
            }
            sawData = true;
        }
        else if (sawData) {
            sawGap = true;
        }
    }
    if (multipleBlocks) {
        notes.push("A blank row separates two blocks of data on this tab, so an append has to land at the end of the first block rather than at the end of the sheet.");
    }
    let keyColumn;
    const width = Math.max(headers.length, ...dataRows.map((r) => r.length), 0);
    for (let col = 0; col < Math.min(width, 8); col += 1) {
        const values = dataRows.map((r) => String(r[col] ?? "").trim());
        if (values.length === 0)
            break;
        if (values.some((v) => v === ""))
            continue;
        if (new Set(values.map((v) => v.toLowerCase())).size !== values.length)
            continue;
        keyColumn = columnIndexToLetter(col);
        break;
    }
    if (!keyColumn && dataRows.length > 0) {
        notes.push("No column has a complete and unique value in every row, so there is no obvious key to match rows on. An upsert needs one.");
    }
    const result = {
        headers,
        multipleBlocks,
        frozenHeader: (input.frozenRowCount ?? 0) > 0,
        banded: input.hasBanding === true,
        filtered: input.hasFilter === true,
        notes,
    };
    if (headerIndex !== undefined) {
        result.headerRow = headerIndex + 1;
        result.firstDataRow = headerIndex + 2;
    }
    if (keyColumn)
        result.keyColumn = keyColumn;
    if (!result.frozenHeader && headerIndex !== undefined) {
        notes.push("The header row is not frozen, so it scrolls out of view. Freezing it is one call and is what a person would have done.");
    }
    return result;
}
/**
 * Decide whether a dropdown belongs to the UI.
 *
 * The API has no colour field on a validation rule, so the chip colours a
 * person picked in the UI cannot be read and cannot be written back. Rewriting
 * such a rule with an identical condition still discards them. So any rule the
 * plugin did not create is treated as the human's, reported rather than
 * touched, and changed only with `force`.
 */
export function markUiOwned(rules, pluginColumns, letterToIndex) {
    return rules.map((rule) => {
        const index = rule.column ? safeIndex(rule.column, letterToIndex) : undefined;
        const uiOwned = index === undefined || !pluginColumns.has(index);
        const out = { ...rule, uiOwned };
        if (uiOwned) {
            out.note =
                "Set in the Sheets UI, or by someone else. Its chip colours cannot be read through the API and would be lost on a rewrite, so it is left alone unless you pass force.";
        }
        return out;
    });
}
function safeIndex(letter, letterToIndex) {
    try {
        return letterToIndex(letter);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=contract.js.map