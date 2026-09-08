/**
 * L04, a merge inside a data region.
 *
 * A merged cell in the middle of a table is the single most expensive piece of
 * decoration in spreadsheets. Sorting refuses to run across it, a filter drops
 * the rows underneath it, and a formula that crosses it reads a blank where a
 * person sees a value. It always looks fine and it always breaks later.
 *
 * What counts as a data region: the header row and everything below it, out to
 * the last column and row carrying anything, plus any native Table's own range.
 * A merged title above the header row is not in the region and is not flagged,
 * because that is the arrangement the fix recommends.
 */
import { boundsA1, dataRegion, gridRangeA1, lintLocation, rangesOverlap, } from "./types.js";
export const l04MergeInData = {
    id: "L04",
    severity: "error",
    title: "A merged range sits inside the data",
    run(ctx) {
        const merges = ctx.sheet.merges ?? [];
        if (merges.length === 0)
            return [];
        const region = dataRegion(ctx);
        const tables = (ctx.sheet.tables ?? [])
            .map((table) => ({ table, range: table?.range }))
            .filter((entry) => Boolean(entry.range));
        const findings = [];
        for (const merge of merges) {
            if (!merge)
                continue;
            const where = lintLocation(ctx.title, gridRangeA1(merge));
            const table = tables.find((entry) => rangesOverlap(merge, entry.range));
            if (table) {
                const name = table.table.name ? `the Table "${table.table.name}"` : "a native Table";
                findings.push({
                    rule: "L04",
                    severity: "error",
                    location: where,
                    message: `${where} is merged and overlaps ${name}. A merge inside a Table breaks its sorting and filtering, and the Table's own column references stop covering every row.`,
                    fix: `sheets_style with sheet: "${ctx.title}", range: "${gridRangeA1(merge)}", unmerge: true. To centre a title, put it in a row above the Table instead.`,
                });
                continue;
            }
            if (region.empty)
                continue;
            const dataBox = {
                startRowIndex: region.headerRow ?? region.firstDataRow,
                endRowIndex: region.lastDataRow + 1,
                startColumnIndex: region.firstColumn,
                endColumnIndex: region.lastColumn + 1,
            };
            if (!rangesOverlap(merge, dataBox))
                continue;
            const crossesHeader = region.headerRow !== undefined &&
                (merge.startRowIndex ?? 0) <= region.headerRow &&
                (merge.endRowIndex ?? 1) > region.headerRow;
            const reason = crossesHeader
                ? "It covers the header row, so sorting and filtering will not run and a lookup by header name finds a blank."
                : "It sits in the rows the data occupies, so sorting refuses to run across it and a formula reading down the column finds a blank where you see a value.";
            findings.push({
                rule: "L04",
                severity: "error",
                location: where,
                message: `${where} is merged inside the data on ${ctx.title} (${lintLocation(ctx.title, boundsA1(dataBox.startRowIndex ?? 0, dataBox.endRowIndex ?? 1, dataBox.startColumnIndex ?? 0, dataBox.endColumnIndex ?? 1))}). ${reason}`,
                fix: `sheets_style with sheet: "${ctx.title}", range: "${gridRangeA1(merge)}", unmerge: true. Centre across the columns instead, or move the label to a title row above the header.`,
            });
        }
        return findings;
    },
};
//# sourceMappingURL=l04-merge-in-data.js.map