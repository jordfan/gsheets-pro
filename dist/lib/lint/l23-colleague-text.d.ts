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
import { type LintRule } from "./types.js";
/** How many findings this rule reports on one tab before it summarises. */
export declare const MAX_TEXT_FINDINGS = 20;
export declare const l23ColleagueText: LintRule;
//# sourceMappingURL=l23-colleague-text.d.ts.map