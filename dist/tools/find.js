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
import { SCOPE_DRIVE_FILE, SCOPE_DRIVE_READONLY } from "../lib/auth.js";
import { withRetry } from "../lib/batch.js";
import { GsheetsError, apiErrorMessage, apiErrorStatus, err } from "../lib/errors.js";
import { count, guarded, lines, ok } from "../lib/result.js";
export const FIND_ACTIONS = ["list", "folders", "share", "copy"];
/** Full Drive. Only ever named in a hint, never requested by default. */
const SCOPE_DRIVE = "https://www.googleapis.com/auth/drive";
const SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
/** Which Drive scope each action needs, and what to say when it is missing. */
export const SCOPE_NEEDS = {
    list: {
        scope: SCOPE_DRIVE_READONLY,
        why: "Searching Drive for a spreadsheet by title reads file names across the account, which drive.file cannot do: it sees only files this app created or the user picked in a Google file picker.",
        fix: "Run `gsheets-pro auth --drive-readonly` to add it. It is a Restricted scope, so add it only if you want the search. Everything else in this plugin works without it, and you can always pass a spreadsheet id straight to sheets_open.",
    },
    folders: {
        scope: SCOPE_DRIVE_READONLY,
        why: "Listing folders reads the shape of the account's Drive. drive.file cannot do it at all: it sees only files this app created or the user picked, and this app never creates a folder, so on that scope the answer is always empty.",
        fix: "Run `gsheets-pro auth --drive-readonly` to add it. It is a Restricted scope, so add it only if you want to browse Drive. If you already know the folder id, from its URL after /folders/, every other action here takes it without this scope.",
    },
    share: {
        scope: SCOPE_DRIVE_FILE,
        why: "Sharing needs write access to the file's permissions.",
        fix: "drive.file is enough for a spreadsheet this app created or that the user picked. For one it has only ever opened by id, Google requires the full drive scope: `gsheets-pro auth` cannot add that on its own, so share it from the Sheets UI instead.",
    },
    copy: {
        scope: SCOPE_DRIVE_FILE,
        why: "Copying a file needs Drive write access.",
        fix: "drive.file is enough for a spreadsheet this app created or that the user picked. For one it has only ever opened by id, Google requires the full drive scope, so make the copy from the Sheets UI instead.",
    },
};
export const findInputSchema = {
    action: z
        .enum(FIND_ACTIONS)
        .describe("list finds spreadsheets by title or folder. folders lists the folders themselves, so you can find the id to scope a list to. share gives a person access. copy duplicates a whole spreadsheet."),
    query: z
        .string()
        .optional()
        .describe("list: return only spreadsheets whose title contains this. folders: only folders whose name contains this. Omit to list the most recent."),
    folder: z
        .string()
        .optional()
        .describe("list: the Drive folder id to look in. folders: the parent folder id, so you get its subfolders. copy: the folder id to put the copy in. Omit for the whole Drive, or for the same folder as the original."),
    limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe(`list and folders: how many to return. Default ${DEFAULT_LIMIT}.`),
    page_token: z
        .string()
        .optional()
        .describe("list and folders: the next_page_token from a previous call, to read the next page. Everything else about the call must stay the same."),
    spreadsheet_id: z
        .string()
        .optional()
        .describe("share and copy: the spreadsheet to act on, the long id from the middle of its URL."),
    email: z.string().optional().describe("share: the person's email address."),
    role: z
        .enum(["reader", "commenter", "writer"])
        .optional()
        .describe("share: what they may do. Default reader."),
    notify: z
        .boolean()
        .optional()
        .describe("share: send them Google's notification email. Default false, so nobody gets an unexpected message from this account."),
    message: z.string().optional().describe("share: a line to put in that email. Needs notify."),
    title: z.string().optional().describe("copy: the new spreadsheet's title. Required."),
    confirm: z
        .string()
        .optional()
        .describe("share: set it to the email address being given access. Sharing reaches a real person and cannot be taken back from anyone who has already opened the link."),
};
const DESCRIPTION = [
    "Find, browse, share and copy whole spreadsheets. This is the Drive side; everything inside a spreadsheet is the other tools.",
    "",
    "list (query, folder, limit, page_token): find spreadsheets by title or by folder. Needs the drive.readonly scope to see a person's own files; without it it sees only files this app created or the user picked.",
    "folders (query, folder, limit, page_token): list folders, so you can find the id to scope a list or a copy to. Pass folder to get one folder's subfolders. Needs drive.readonly.",
    "share (spreadsheet_id, email, role, confirm): give a person access. Sends no notification email unless notify is set.",
    "copy (spreadsheet_id, title, folder): duplicate a whole spreadsheet. The copy keeps formatting, validation and the plugin's own column contract.",
    "",
    "list and folders page: when a response carries next_page_token, call again with page_token set to it and everything else unchanged.",
].join("\n");
export function createFindTool(deps) {
    return {
        name: "sheets_find",
        config: {
            title: "Find, share and copy spreadsheets",
            description: DESCRIPTION,
            inputSchema: findInputSchema,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        handler: guarded(async (raw) => {
            const args = raw;
            const ctx = await deps.getContext();
            const scopes = ctx.auth?.scopes ?? [];
            guardAnyDriveScope(scopes, args.action);
            try {
                if (args.action === "list")
                    return await listSpreadsheets(ctx, args, scopes);
                if (args.action === "folders")
                    return await listFolders(ctx, args, scopes);
                if (args.action === "share")
                    return await shareSpreadsheet(ctx, args);
                return await copySpreadsheet(ctx, args);
            }
            catch (error) {
                throw asScopeError(error, args.action) ?? error;
            }
        }),
    };
}
// ---------------------------------------------------------------------------
// Scope teaching
// ---------------------------------------------------------------------------
/** True when the recorded scopes are usable evidence. An empty list is not. */
function knowsScopes(scopes) {
    return scopes.length > 0;
}
function hasScope(scopes, wanted) {
    return scopes.includes(wanted) || scopes.includes(SCOPE_DRIVE);
}
/** Every action here calls Drive, and Drive needs at least one Drive scope. */
function guardAnyDriveScope(scopes, action) {
    if (!knowsScopes(scopes))
        return;
    const any = hasScope(scopes, SCOPE_DRIVE_FILE) ||
        hasScope(scopes, SCOPE_DRIVE_READONLY) ||
        scopes.includes(SCOPE_DRIVE);
    if (any)
        return;
    const need = SCOPE_NEEDS[action];
    throw scopeError(action, need.scope, "This token carries no Drive scope at all.");
}
function scopeError(action, scope, detail) {
    const need = SCOPE_NEEDS[action];
    return new GsheetsError("permission_denied", `sheets_find ${action} needs the ${short(scope)} scope. ${detail}`, `${need.why} ${need.fix}`, { action, scope, granted_hint: "Run `gsheets-pro doctor` to see which scopes the current token carries." });
}
/** Turn Drive's own scope refusal into the same teaching error. */
function asScopeError(error, action) {
    if (error instanceof GsheetsError)
        return undefined;
    const status = apiErrorStatus(error);
    const message = apiErrorMessage(error);
    if (status !== 403 && status !== 401)
        return undefined;
    if (!/insufficient|scope|permission|forbidden|ACCESS_TOKEN_SCOPE/i.test(message))
        return undefined;
    return scopeError(action, SCOPE_NEEDS[action].scope, `Google refused it: ${message}`);
}
function short(scope) {
    return scope.replace("https://www.googleapis.com/auth/", "");
}
// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------
/** Drive's query language escapes a single quote with a backslash. */
export function escapeDriveQuery(value) {
    return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
/** Build the Drive `q` for a spreadsheet search. Pure, so the cases are testable. */
export function buildDriveQuery(query, folder) {
    return buildMimeQuery(SPREADSHEET_MIME, query, folder);
}
/**
 * The same query for folders. `folder` means the parent here rather than the
 * place to look, which is the only difference worth stating: passing a folder
 * to `folders` gets its children, passing one to `list` gets the spreadsheets
 * inside it.
 */
export function buildFolderQuery(query, parent) {
    return buildMimeQuery(FOLDER_MIME, query, parent);
}
function buildMimeQuery(mimeType, query, parent) {
    const clauses = [`mimeType = '${mimeType}'`, "trashed = false"];
    const name = query?.trim();
    if (name)
        clauses.push(`name contains '${escapeDriveQuery(name)}'`);
    const folder = parent?.trim();
    if (folder)
        clauses.push(`'${escapeDriveQuery(folder)}' in parents`);
    return clauses.join(" and ");
}
async function listSpreadsheets(ctx, args, scopes) {
    const limit = args.limit ?? DEFAULT_LIMIT;
    const q = buildDriveQuery(args.query, args.folder);
    const response = await withRetry(() => ctx.drive.files.list({
        q,
        pageSize: limit,
        orderBy: "modifiedTime desc",
        fields: "nextPageToken,incompleteSearch,files(id,name,modifiedTime,webViewLink,owners(displayName,emailAddress))",
        supportsAllDrives: true,
        ...(args.page_token?.trim() ? { pageToken: args.page_token.trim() } : {}),
    }));
    const files = (response.data.files ?? []).map((file) => ({
        spreadsheet_id: file.id ?? "",
        title: file.name ?? "",
        modified: file.modifiedTime ?? null,
        url: file.webViewLink ?? (file.id ? `https://docs.google.com/spreadsheets/d/${file.id}/edit` : null),
        owner: file.owners?.[0]?.displayName ?? file.owners?.[0]?.emailAddress ?? null,
    }));
    const restricted = knowsScopes(scopes) && !hasScope(scopes, SCOPE_DRIVE_READONLY);
    // An empty result on a token that cannot search is not "no such spreadsheet";
    // it is "this token cannot see them", and saying the first would send the
    // caller looking for a file that is sitting right there.
    if (files.length === 0 && restricted) {
        throw scopeError("list", SCOPE_DRIVE_READONLY, "The search returned nothing, and this token can only see files this app created or the user picked, so a spreadsheet that exists would not appear.");
    }
    const warnings = [];
    if (restricted) {
        warnings.push(`This token has no ${short(SCOPE_DRIVE_READONLY)} scope, so the list covers only spreadsheets this app created or the user picked. Others exist and are not shown.`);
    }
    if (response.data.incompleteSearch) {
        warnings.push("Drive reported the search as incomplete, usually because a shared drive did not answer in time.");
    }
    const nextPageToken = response.data.nextPageToken ?? null;
    const structured = {
        action: "list",
        query: args.query ?? null,
        folder: args.folder ?? null,
        drive_query: q,
        spreadsheets: files,
        scope_limited: restricted,
        next_page_token: nextPageToken,
        warnings,
    };
    const head = args.query
        ? `${count(files.length, "spreadsheet")} with "${args.query}" in the title.`
        : `${count(files.length, "spreadsheet")}, most recently changed first.`;
    return ok(lines(head, ...files.map((f) => `  ${f.title} (${f.spreadsheet_id})${f.owner ? `, owned by ${f.owner}` : ""}`), nextPageToken ? `\nMore to come. Call again with page_token set to next_page_token.` : undefined, warnings.length ? `\nWorth knowing:\n${warnings.map((w) => `- ${w}`).join("\n")}` : undefined), structured, { maxResultSizeChars: 60_000 });
}
// ---------------------------------------------------------------------------
// folders
// ---------------------------------------------------------------------------
/**
 * Folders, so a person who knows where a spreadsheet lives but not what it is
 * called can get there. This replaces the old `list_folders` from the Python
 * server, which is why it exists as its own action rather than as a flag on
 * `list`: a folder is not a spreadsheet, its result carries a folder id rather
 * than a spreadsheet id, and returning the two shapes from one action would
 * mean the caller had to work out which they got.
 */
async function listFolders(ctx, args, scopes) {
    const limit = args.limit ?? DEFAULT_LIMIT;
    const q = buildFolderQuery(args.query, args.folder);
    const response = await withRetry(() => ctx.drive.files.list({
        q,
        pageSize: limit,
        orderBy: "name",
        fields: "nextPageToken,incompleteSearch,files(id,name,modifiedTime,webViewLink,parents)",
        supportsAllDrives: true,
        ...(args.page_token?.trim() ? { pageToken: args.page_token.trim() } : {}),
    }));
    const folders = (response.data.files ?? []).map((file) => ({
        folder_id: file.id ?? "",
        name: file.name ?? "",
        modified: file.modifiedTime ?? null,
        url: file.webViewLink ?? (file.id ? `https://drive.google.com/drive/folders/${file.id}` : null),
        parent: file.parents?.[0] ?? null,
    }));
    const restricted = knowsScopes(scopes) && !hasScope(scopes, SCOPE_DRIVE_READONLY);
    // drive.file never sees a folder, because this app does not create folders.
    // An empty answer there means the scope, not an empty Drive, and reporting it
    // as an empty Drive would be simply false.
    if (folders.length === 0 && restricted) {
        throw scopeError("folders", SCOPE_DRIVE_READONLY, "No folders came back, and on this token none ever would.");
    }
    const nextPageToken = response.data.nextPageToken ?? null;
    const warnings = [];
    if (response.data.incompleteSearch) {
        warnings.push("Drive reported the search as incomplete, usually because a shared drive did not answer in time.");
    }
    const structured = {
        action: "folders",
        query: args.query ?? null,
        parent: args.folder ?? null,
        drive_query: q,
        folders,
        scope_limited: restricted,
        next_page_token: nextPageToken,
        warnings,
    };
    const head = args.folder
        ? `${count(folders.length, "folder")} inside ${args.folder}.`
        : args.query
            ? `${count(folders.length, "folder")} with "${args.query}" in the name.`
            : `${count(folders.length, "folder")}, by name.`;
    return ok(lines(head, ...folders.map((f) => `  ${f.name} (${f.folder_id})`), nextPageToken ? `\nMore to come. Call again with page_token set to next_page_token.` : undefined, folders.length
        ? "\nA folder_id goes straight into folder on list, to see the spreadsheets in it, or on copy, to put a copy there."
        : undefined, warnings.length ? `\nWorth knowing:\n${warnings.map((w) => `- ${w}`).join("\n")}` : undefined), structured, { maxResultSizeChars: 60_000 });
}
// ---------------------------------------------------------------------------
// share
// ---------------------------------------------------------------------------
async function shareSpreadsheet(ctx, args) {
    const fileId = required(args.spreadsheet_id, "share needs spreadsheet_id.", "Pass the spreadsheet to share.");
    const email = required(args.email, "share needs email.", "Pass the address of the person to give access to.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        throw err.invalid(`"${email}" does not look like an email address.`, "Pass one address per call.");
    }
    const given = args.confirm?.trim().toLowerCase();
    if (given !== email.toLowerCase()) {
        throw new GsheetsError("needs_confirmation", given ? `confirm was "${args.confirm}" and this share is for "${email}".` : "share needs confirm.", `Pass confirm: "${email}" to say this is deliberate. Sharing reaches a real person, and access cannot be taken back from someone who has already opened the file. Nothing has been shared.`, { email });
    }
    const role = args.role ?? "reader";
    const notify = args.notify === true;
    const response = await withRetry(() => ctx.drive.permissions.create({
        fileId,
        sendNotificationEmail: notify,
        ...(notify && args.message ? { emailMessage: args.message } : {}),
        supportsAllDrives: true,
        fields: "id,type,role,emailAddress",
        requestBody: { type: "user", role, emailAddress: email },
    }));
    const structured = {
        action: "share",
        spreadsheet_id: fileId,
        email,
        role,
        notified: notify,
        permission_id: response.data.id ?? null,
        warnings: notify
            ? []
            : ["No notification email was sent. The person has access but does not know about it yet."],
    };
    return ok(lines(`${email} can now ${role === "reader" ? "read" : role === "commenter" ? "comment on" : "edit"} the spreadsheet.`, notify
        ? "Google sent them its notification email."
        : "No email was sent, so tell them yourself, or run this again with notify set."), structured);
}
// ---------------------------------------------------------------------------
// copy
// ---------------------------------------------------------------------------
async function copySpreadsheet(ctx, args) {
    const fileId = required(args.spreadsheet_id, "copy needs spreadsheet_id.", "Pass the spreadsheet to copy.");
    const title = required(args.title, "copy needs title.", 'Name the copy. Google would otherwise call it "Copy of ...", which nobody wants in a folder.');
    const requestBody = { name: title };
    if (args.folder?.trim())
        requestBody["parents"] = [args.folder.trim()];
    const response = await withRetry(() => ctx.drive.files.copy({
        fileId,
        supportsAllDrives: true,
        fields: "id,name,webViewLink",
        requestBody,
    }));
    const newId = response.data.id ?? "";
    const warnings = [
        "The copy carries the original's formatting, validation rules and developer metadata, so a copied tracker keeps its column contract.",
        "It is a different spreadsheet id, so no registry entry covers it. Writable column limits and positional row protections from the original do not apply to the copy until someone adds it to .claude/gsheets-pro.json.",
        "Only the person who ran this can see the copy. Sharing does not come along with it.",
    ];
    const structured = {
        action: "copy",
        source_spreadsheet_id: fileId,
        spreadsheet_id: newId,
        title: response.data.name ?? title,
        url: response.data.webViewLink ?? (newId ? `https://docs.google.com/spreadsheets/d/${newId}/edit` : null),
        warnings,
    };
    return ok(lines(`Copied it to "${response.data.name ?? title}" (${newId}).`, `\nWorth knowing:\n${warnings.map((w) => `- ${w}`).join("\n")}`), structured);
}
function required(value, message, hint) {
    const v = value?.trim();
    if (!v)
        throw err.invalid(message, hint);
    return v;
}
//# sourceMappingURL=find.js.map