/**
 * L14, a write outside the columns that are ours.
 *
 * This rule is about history, not about the sheet as it stands. A value in
 * somebody else's column proves nothing, because they almost certainly typed
 * it. What matters is whether this session put it there, so the rule reads the
 * ledger of ranges the process wrote and asks the contract whether each column
 * was ours.
 *
 * Two sources say a column is not ours, and both are somebody's stated
 * intention rather than a guess: the repo registry's `writable_columns`, and
 * column metadata whose owner is `human`. Inference never feeds this rule. A
 * warning that a write "may have" landed somewhere it should not is exactly the
 * kind of finding that teaches people to skim past findings.
 *
 * The severity is warning rather than error on purpose. By the time the lint
 * runs the write has already happened, and the useful response is to undo it,
 * which the fix string says. Calling it an error would stop a build over
 * something that stopping cannot repair.
 */
import { columnIndexToLetter, parseA1, splitSheetRange } from "../a1.js";
import { lintLocation, } from "./types.js";
export const l14WriteOutsideColumns = {
    id: "L14",
    severity: "warning",
    title: "A write landed in a column somebody else owns",
    run(ctx) {
        const writes = (ctx.writes ?? []).filter((write) => matchesSheet(write, ctx.title));
        if (writes.length === 0)
            return [];
        const contract = ctx.contract;
        const policy = ctx.policy;
        if (!contract && !policy)
            return [];
        const findings = [];
        const reported = new Set();
        for (const write of writes) {
            const span = columnSpan(write.range);
            if (!span)
                continue;
            const offenders = [];
            for (let index = span.startColumn; index < span.endColumn; index += 1) {
                const letter = columnIndexToLetter(index);
                const column = contract?.columns.find((c) => c.index === index);
                const header = column?.header;
                if (column && column.writable === false) {
                    const entry = {
                        index,
                        letter,
                        reason: `the registry at ${contract?.registryPath ?? ".claude/gsheets-pro.json"} does not list it among the writable columns`,
                    };
                    if (header)
                        entry.header = header;
                    offenders.push(entry);
                    continue;
                }
                if (column?.owner === "human") {
                    const entry = {
                        index,
                        letter,
                        reason: "its column metadata marks it as a human's",
                    };
                    if (header)
                        entry.header = header;
                    offenders.push(entry);
                }
            }
            if (offenders.length === 0)
                continue;
            const rows = rowSpanText(write.range);
            for (const offender of offenders) {
                const range = rows
                    ? `${offender.letter}${rows.first}:${offender.letter}${rows.last}`
                    : `${offender.letter}:${offender.letter}`;
                const where = lintLocation(ctx.title, range);
                if (reported.has(where))
                    continue;
                reported.add(where);
                const named = offender.header ? `"${offender.header}" (column ${offender.letter})` : `column ${offender.letter}`;
                findings.push({
                    rule: "L14",
                    severity: "warning",
                    location: where,
                    message: `This session wrote ${write.range} on ${ctx.title}, which covers ${named}, and ${offender.reason}. That column belongs to somebody else and they will not expect it to have changed.`,
                    fix: `Undo it: sheets_read the column first to see what is there now, then restore what was there before. If the column really is ours, add it to writable_columns in the registry rather than writing past the contract again.`,
                });
            }
        }
        return findings;
    },
};
function matchesSheet(write, title) {
    const wanted = title.trim().toLowerCase();
    if (write.sheet)
        return write.sheet.trim().toLowerCase() === wanted;
    try {
        const split = splitSheetRange(write.range);
        return (split.sheet ?? "").trim().toLowerCase() === wanted;
    }
    catch {
        return false;
    }
}
/** The half open column span a written range covers, or undefined for whole rows. */
function columnSpan(range) {
    try {
        const bounds = parseA1(range);
        if (bounds.startColumnIndex === undefined || bounds.endColumnIndex === undefined)
            return undefined;
        return { startColumn: bounds.startColumnIndex, endColumn: bounds.endColumnIndex };
    }
    catch {
        return undefined;
    }
}
function rowSpanText(range) {
    try {
        const bounds = parseA1(range);
        if (bounds.startRowIndex === undefined || bounds.endRowIndex === undefined)
            return undefined;
        return { first: bounds.startRowIndex + 1, last: bounds.endRowIndex };
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=l14-write-outside-columns.js.map