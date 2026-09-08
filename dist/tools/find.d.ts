/**
 * `sheets_find`: the Drive side of working with spreadsheets.
 *
 * Everything else in this plugin takes a spreadsheet id and works inside it.
 * This is the tool for the four things that happen outside one: finding a
 * spreadsheet when all you have is its name, browsing the folders it might be
 * in, giving a colleague access, and making a copy.
 *
 * Drive scopes are the whole difficulty here and the reason this is its own
 * tool rather than an action bolted onto `sheets_open`. The default install
 * asks for `drive.file`, which sees only the files this app created or the user
 * explicitly picked. Searching a person's Drive by title needs `drive.readonly`,
 * which Google classes as Restricted and which most people should not grant
 * without deciding to. So every action here says which scope it needs, and a
 * search that comes back empty on a token without the scope says why instead of
 * reporting, wrongly, that the spreadsheet does not exist.
 */
import { z } from "zod";
import type { ToolDefinition, ToolDeps } from "./types.js";
export declare const FIND_ACTIONS: readonly ["list", "folders", "share", "copy"];
export type FindAction = (typeof FIND_ACTIONS)[number];
/** Which Drive scope each action needs, and what to say when it is missing. */
export declare const SCOPE_NEEDS: Record<FindAction, {
    scope: string;
    why: string;
    fix: string;
}>;
export declare const findInputSchema: {
    action: z.ZodEnum<{
        list: "list";
        folders: "folders";
        share: "share";
        copy: "copy";
    }>;
    query: z.ZodOptional<z.ZodString>;
    folder: z.ZodOptional<z.ZodString>;
    limit: z.ZodOptional<z.ZodNumber>;
    page_token: z.ZodOptional<z.ZodString>;
    spreadsheet_id: z.ZodOptional<z.ZodString>;
    email: z.ZodOptional<z.ZodString>;
    role: z.ZodOptional<z.ZodEnum<{
        reader: "reader";
        commenter: "commenter";
        writer: "writer";
    }>>;
    notify: z.ZodOptional<z.ZodBoolean>;
    message: z.ZodOptional<z.ZodString>;
    title: z.ZodOptional<z.ZodString>;
    confirm: z.ZodOptional<z.ZodString>;
};
export declare function createFindTool(deps: ToolDeps): ToolDefinition<typeof findInputSchema>;
/** Drive's query language escapes a single quote with a backslash. */
export declare function escapeDriveQuery(value: string): string;
/** Build the Drive `q` for a spreadsheet search. Pure, so the cases are testable. */
export declare function buildDriveQuery(query?: string, folder?: string): string;
/**
 * The same query for folders. `folder` means the parent here rather than the
 * place to look, which is the only difference worth stating: passing a folder
 * to `folders` gets its children, passing one to `list` gets the spreadsheets
 * inside it.
 */
export declare function buildFolderQuery(query?: string, parent?: string): string;
//# sourceMappingURL=find.d.ts.map