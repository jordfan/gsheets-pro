/**
 * L23, text that does not read as a colleague's.
 *
 * Somebody opens a shared spreadsheet with no idea an agent ever touched it. A
 * cell reading "TODO: confirm per 18f2a1c9b4d0e77a", a note saying "written by
 * the agent on the overnight run", a status column full of `sent_as_is`: none
 * of that is wrong, exactly, and all of it makes the sheet look like a log file
 * somebody left in the shared drive.
 *
 * The patterns live in `src/lib/safetext.ts`, which the write path uses to
 * refuse before the text lands. This rule is the same check run after the fact,
 * over cells, notes, and validation help text, so a sheet that was written by
 * hand or by an older tool still gets read. Sharing the module is the point:
 * two lists of patterns would drift, and the day they drift is the day a write
 * is refused for something the lint says is fine.
 *
 * It runs only where text is read by somebody other than whoever wrote it: a
 * sheet the registry marks human or shared, or one that sets
 * `colleague_safe_text`. On a sheet the agent owns outright there is nobody to
 * surprise. The registry's per sheet allowlist is honoured, because a sheet
 * that legitimately tracks software work will contain the word "agent" and
 * nagging about it is how a check gets switched off.
 */
import { checkText, colleagueSafeApplies, } from "../safetext.js";
import { cellA1, eachCell, lintLocation, } from "./types.js";
/** How many findings this rule reports on one tab before it summarises. */
export const MAX_TEXT_FINDINGS = 20;
export const l23ColleagueText = {
    id: "L23",
    severity: "warning",
    title: "Text that does not read as a colleague's",
    run(ctx) {
        const policy = ctx.policy;
        const applies = policy
            ? colleagueSafeApplies({
                owner: policy.owner,
                colleagueSafeText: policy.colleagueSafeText,
            })
            : colleagueSafeApplies({
                ...(ctx.contract?.owner ? { owner: ctx.contract.owner } : {}),
                colleagueSafeText: ctx.contract?.colleagueSafeText === true,
            });
        if (!applies)
            return [];
        const options = { allowlist: policy?.allowlist ?? [] };
        const hits = [];
        eachCell(ctx.sheet, ({ row, column, cell }) => {
            const where = lintLocation(ctx.title, cellA1(row, column));
            const entered = cell.userEnteredValue?.stringValue;
            const displayed = typeof entered === "string" ? entered : cell.formattedValue;
            if (typeof displayed === "string") {
                for (const hit of checkText(displayed, where, options))
                    hits.push({ ...hit, what: "cell" });
            }
            if (typeof cell.note === "string") {
                for (const hit of checkText(cell.note, where, options))
                    hits.push({ ...hit, what: "note" });
            }
            const help = cell.dataValidation?.inputMessage;
            if (typeof help === "string") {
                for (const hit of checkText(help, where, options)) {
                    hits.push({ ...hit, what: "validation help text" });
                }
            }
        });
        // The FORMULA render carries text the masked read may not have reached,
        // and a string typed into a cell is the commonest case of all.
        if (ctx.formulas) {
            for (let row = 0; row < ctx.formulas.length; row += 1) {
                const line = ctx.formulas[row] ?? [];
                for (let column = 0; column < line.length; column += 1) {
                    const value = line[column];
                    if (typeof value !== "string" || value.startsWith("="))
                        continue;
                    const where = lintLocation(ctx.title, cellA1(row, column));
                    for (const hit of checkText(value, where, options)) {
                        if (hits.some((existing) => existing.location === where && existing.rule === hit.rule))
                            continue;
                        hits.push({ ...hit, what: "cell" });
                    }
                }
            }
        }
        const shown = hits.slice(0, MAX_TEXT_FINDINGS);
        const findings = shown.map((hit) => ({
            rule: "L23",
            severity: "warning",
            location: hit.location,
            message: `The ${hit.what} at ${hit.location} contains "${hit.matched}", which reads as machine output rather than as something a colleague wrote (${hit.rule}). ${hit.fix}`,
            fix: fixFor(hit, ctx.title),
        }));
        if (hits.length > shown.length) {
            findings.push({
                rule: "L23",
                severity: "warning",
                location: lintLocation(ctx.title),
                message: `And ${hits.length - shown.length} more cell(s) or note(s) on ${ctx.title} carrying text of the same kind.`,
                fix: `sheets_read with include: ["notes"] over ${ctx.title} and rewrite them together. If this vocabulary is legitimate here, add it to the sheet's allowlist in the registry rather than rewriting it every run.`,
            });
        }
        return findings;
    },
};
function fixFor(hit, title) {
    if (hit.what === "note") {
        return `sheets_write with a note on ${hit.location} that says the same thing in a sentence. If the phrase is legitimate on this sheet, add it to the allowlist for ${title} in .claude/gsheets-pro.json.`;
    }
    if (hit.what === "validation help text") {
        return `sheets_validation on ${hit.location} with help_text a person would find useful. Help text is read by whoever clicks the cell, so it is the last place for internal vocabulary.`;
    }
    return `sheets_write with the sentence a colleague would have typed into ${hit.location}. If the phrase is legitimate on this sheet, add it to the allowlist for ${title} in .claude/gsheets-pro.json.`;
}
//# sourceMappingURL=l23-colleague-text.js.map