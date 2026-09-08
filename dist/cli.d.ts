#!/usr/bin/env node
/**
 * The command line.
 *
 *   gsheets-pro stdio          speak MCP over stdin and stdout
 *   gsheets-pro serve --http   the stateless HTTP server, for cloud and hosting
 *   gsheets-pro auth           sign in and write a token
 *   gsheets-pro doctor         say what is wrong, in the order it will bite
 *   gsheets-pro card           regenerate the skill card
 *   gsheets-pro vendor         copy the guide into a repository's .claude/
 *
 * `doctor` is line one of the README because Path A setup is the top support
 * cost of any Google plugin, and because the seven day Testing expiry produces
 * a 401 a week after everything worked, which is not a failure anyone diagnoses
 * on their own.
 */
export declare function main(argv?: string[]): Promise<number>;
interface Check {
    name: string;
    status: "ok" | "warn" | "fail";
    detail: string;
    fix?: string;
}
export declare function collectChecks(): Promise<Check[]>;
export {};
//# sourceMappingURL=cli.d.ts.map