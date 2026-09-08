/**
 * Native Tables: the typed columns, the contract metadata that rides them, and
 * the status fills that stand in for chip colors.
 *
 * Everything here is pure. The tool assembles requests from these functions and
 * sends them in one batchUpdate; the functions themselves never touch the API,
 * so every rule below is tested offline.
 *
 * Three findings from spike 3 are encoded here rather than left to the caller:
 *
 * - A Table's DROPDOWN validation lives on the Table's column properties, not
 *   on the cells. Anything looking for a dropdown has to read `sheets.tables`
 *   as well as cell validation or it will report a typed column as having none.
 * - `appendCells` with a `tableId` returns success and writes an empty row. Row
 *   values go in through `values.append`, which is `sheets_write`'s job, not
 *   this file's.
 * - A cell that a person filled by hand keeps its fill and overrides the band
 *   color, so adopting a Table over hand-colored data looks patchy. `adopt`
 *   reports those cells rather than quietly clearing them.
 */
import { columnIndexToLetter } from "./a1.js";
import { METADATA_KEYS, } from "./contract.js";
import { GsheetsError } from "./errors.js";
import { STATUS_ROLES } from "./tablecolors.js";
/**
 * The column types the API accepts, minus the unspecified member. Verified
 * against the discovery document, revision 20260831.
 */
export const TABLE_COLUMN_TYPES = [
    "DOUBLE",
    "CURRENCY",
    "PERCENT",
    "DATE",
    "TIME",
    "DATE_TIME",
    "TEXT",
    "BOOLEAN",
    "DROPDOWN",
    "FILES_CHIP",
    "PEOPLE_CHIP",
    "FINANCE_CHIP",
    "PLACE_CHIP",
    "RATINGS_CHIP",
];
/** Build the Table's column properties from the caller's column specs. */
export function buildColumnProperties(columns) {
    return columns.map((column, index) => {
        const name = String(column.name ?? "").trim();
        if (!name) {
            throw new GsheetsError("invalid_argument", `Column ${index + 1} has no name.`, "Every column needs a name, which becomes both the header text and the Table column's name.");
        }
        const properties = { columnIndex: index, columnName: name };
        if (column.type) {
            if (!TABLE_COLUMN_TYPES.includes(column.type)) {
                throw new GsheetsError("invalid_argument", `"${column.type}" is not a Table column type.`, `The types are: ${TABLE_COLUMN_TYPES.join(", ")}.`);
            }
            properties.columnType = column.type;
        }
        if (column.type === "DROPDOWN") {
            if (column.options?.length) {
                properties.dataValidationRule = {
                    condition: {
                        type: "ONE_OF_LIST",
                        values: column.options.map((v) => ({ userEnteredValue: String(v) })),
                    },
                };
            }
            else if (column.options_range) {
                const range = column.options_range.trim();
                properties.dataValidationRule = {
                    condition: {
                        type: "ONE_OF_RANGE",
                        values: [{ userEnteredValue: range.startsWith("=") ? range : `=${range}` }],
                    },
                };
            }
            else {
                throw new GsheetsError("invalid_argument", `The DROPDOWN column "${name}" has no options.`, 'Pass options, for example options: ["Confirmed", "Pending"], or options_range to point at a list elsewhere in the workbook.');
            }
        }
        else if (column.options?.length || column.options_range) {
            throw new GsheetsError("invalid_argument", `The column "${name}" has options but is typed ${column.type ?? "TEXT"}.`, "Options belong to a DROPDOWN column. Set type: DROPDOWN, or drop the options.");
        }
        return properties;
    });
}
/**
 * A Table needs a bounded range: it has to know where its last row and column
 * are. An open ended reference like A:E would be accepted by A1 parsing and
 * then rejected by the API with a message about the grid, so it is caught here.
 */
export function requireBoundedRange(range, reference) {
    const missing = [];
    if (range.startRowIndex === undefined)
        missing.push("a first row");
    if (range.endRowIndex === undefined)
        missing.push("a last row");
    if (range.startColumnIndex === undefined)
        missing.push("a first column");
    if (range.endColumnIndex === undefined)
        missing.push("a last column");
    if (missing.length) {
        throw new GsheetsError("bad_range", `A Table needs a range with ${missing.join(" and ")}, and "${reference}" has none.`, "Give the whole block including the header row, for example A1:F40. A Table cannot cover an open ended range like A:F.");
    }
    return range;
}
/** The header row of a Table's range, as its own GridRange. */
export function headerRangeOf(range) {
    return {
        sheetId: range.sheetId,
        startRowIndex: range.startRowIndex,
        endRowIndex: range.startRowIndex + 1,
        startColumnIndex: range.startColumnIndex,
        endColumnIndex: range.endColumnIndex,
    };
}
/** The data rows of a Table's range, header excluded. */
export function dataRangeOf(range) {
    return {
        sheetId: range.sheetId,
        startRowIndex: range.startRowIndex + 1,
        endRowIndex: range.endRowIndex,
        startColumnIndex: range.startColumnIndex,
        endColumnIndex: range.endColumnIndex,
    };
}
/** One column of a Table's data rows, by position within the Table. */
export function columnRangeOf(range, columnIndex) {
    const start = range.startColumnIndex + columnIndex;
    return {
        sheetId: range.sheetId,
        startRowIndex: range.startRowIndex + 1,
        endRowIndex: range.endRowIndex,
        startColumnIndex: start,
        endColumnIndex: start + 1,
    };
}
/** The sheet column letter for a Table column, which may not start at A. */
export function columnLetterOf(range, columnIndex) {
    return columnIndexToLetter(range.startColumnIndex + columnIndex);
}
/** How many columns one call will record provenance for. */
export const MAX_RECORDED_COLUMNS = 12;
/**
 * Create or update one developer metadata entry.
 *
 * Visibility is PROJECT: the contract is the plugin's own bookkeeping, not
 * something every add-on that opens the file should read. Spike 5 confirmed
 * PROJECT metadata written on a column rides the column through an insert to
 * its left and survives `drive.files.copy` intact, so a duplicated tracker
 * keeps its contract.
 *
 * An update goes through a location lookup rather than a metadata id, because
 * the id is not knowable without a second read and the location is.
 */
export function metadataRequest(write) {
    const metadataValue = typeof write.value === "string" ? write.value : JSON.stringify(write.value);
    const location = write.location;
    if (!write.exists) {
        return {
            createDeveloperMetadata: {
                developerMetadata: {
                    metadataKey: write.key,
                    metadataValue,
                    location,
                    visibility: "PROJECT",
                },
            },
        };
    }
    return {
        updateDeveloperMetadata: {
            dataFilters: [
                {
                    developerMetadataLookup: {
                        metadataKey: write.key,
                        metadataLocation: location,
                        locationMatchingStrategy: "EXACT_LOCATION",
                        visibility: "PROJECT",
                    },
                },
            ],
            developerMetadata: { metadataKey: write.key, metadataValue },
            fields: "metadataValue",
        },
    };
}
/** The `gsheets.column` entry for one column of a Table. */
export function columnMetadataWrite(input) {
    const value = { header: input.column.name };
    if (input.column.key)
        value.name = input.column.key;
    if (input.column.role)
        value.role = input.column.role;
    if (input.column.owner)
        value.owner = input.column.owner;
    const type = input.type ?? input.column.type;
    if (type)
        value.type = type;
    return {
        key: METADATA_KEYS.column,
        value,
        location: {
            dimensionRange: {
                sheetId: input.sheetId,
                dimension: "COLUMNS",
                startIndex: input.columnIndex,
                endIndex: input.columnIndex + 1,
            },
        },
        exists: input.exists,
    };
}
// ---------------------------------------------------------------------------
// Status fills: the chip colors the API cannot set
// ---------------------------------------------------------------------------
/**
 * Which role a status option should be painted in, or nothing.
 *
 * The API has no color field on any validation rule, so a dropdown's chips can
 * only be colored by hand in the UI. Where a person would reach for chips, the
 * plugin paints the same meaning with conditional format rules, and this is the
 * reading of what each option means. It is a guess made explicit: every rule it
 * produces is reported back by name so a wrong one is visible.
 *
 * An option this does not recognise gets `undefined`, and no rule at all. It
 * used to get `muted`, which painted every unfamiliar status in a colour that
 * asserted something the plugin did not know. A status with no recognised
 * meaning has no colour: an unpainted row reads as "no state claimed", which
 * is the truth, and a five-option dropdown does not end up in five colours
 * three of which mean nothing. `muted` is still available as an explicit
 * override for a status genuinely meant to look inactive.
 */
export function defaultStatusRole(option) {
    const text = String(option ?? "").trim().toLowerCase();
    if (/^(confirmed|complete|completed|done|approved|paid|signed|yes|active|enrolled|received|ok)\b/.test(text)) {
        return "ok";
    }
    if (/^(pending|in progress|in review|waiting|waitlist|sent|requested|scheduled|draft|maybe|hold|on hold|tentative)\b/.test(text)) {
        return "warn";
    }
    if (/^(declined|cancelled|canceled|overdue|late|blocked|failed|rejected|no|dropped|missing|expired)\b/.test(text)) {
        return "flag";
    }
    return undefined;
}
/**
 * Pair each dropdown option with the role that paints it.
 *
 * Options with no recognised meaning are dropped rather than given a colour,
 * so the caller generates no rule for them. Name one in `overrides` to paint
 * it anyway.
 */
export function statusFillSpecs(options, overrides = {}) {
    return options.flatMap((option) => {
        const override = overrides[option] ?? overrides[option.toLowerCase()];
        if (override) {
            if (!STATUS_ROLES.includes(override)) {
                throw new GsheetsError("invalid_argument", `"${override}" is not a status role.`, `The status roles are: ${STATUS_ROLES.join(", ")}.`);
            }
            return [{ option, role: override }];
        }
        const role = defaultStatusRole(option);
        return role ? [{ option, role }] : [];
    });
}
/**
 * May this sheet carry plugin owned status fills?
 *
 * Only sheets the plugin created. On a sheet a person built, a set of
 * conditional rules the plugin can later rewrite is a set of rules that will
 * one day overwrite the person's own. The gate reads the sheet's own metadata
 * rather than trusting the call, so it holds across sessions and clients.
 */
export function statusFillGate(input) {
    if (input.registryOwner === "human" || input.registryOwner === "shared") {
        return {
            allowed: false,
            reason: `The registry says this spreadsheet is ${input.registryOwner} owned, so the plugin does not paint status fills on it. Ask for them by hand, or change the registry entry.`,
        };
    }
    if (input.origin === "plugin")
        return { allowed: true };
    if (input.origin === "adopted") {
        return {
            allowed: false,
            reason: "This Table was adopted from a sheet somebody else built, so its conditional formats are theirs. Status fills are only painted on sheets the plugin created.",
        };
    }
    if (input.creatingNow) {
        if ((input.existingRuleCount ?? 0) > 0) {
            return {
                allowed: false,
                reason: `This tab already carries ${input.existingRuleCount} conditional format rule(s) that the plugin did not write, so it is somebody else's sheet. Status fills are only painted on sheets the plugin created.`,
            };
        }
        return { allowed: true };
    }
    return {
        allowed: false,
        reason: "This tab carries no plugin metadata, so there is no evidence the plugin created it. Status fills are only painted on sheets the plugin created.",
    };
}
// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
/** "Instructors covers A1:E12, 5 columns, 11 data rows." */
export function describeTableRange(name, range, a1) {
    const columns = range.endColumnIndex - range.startColumnIndex;
    const rows = Math.max(0, range.endRowIndex - range.startRowIndex - 1);
    return `${name} covers ${a1}: ${columns} column${columns === 1 ? "" : "s"}, ${rows} data row${rows === 1 ? "" : "s"}.`;
}
//# sourceMappingURL=tables.js.map