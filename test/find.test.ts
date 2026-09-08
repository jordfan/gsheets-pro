/**
 * `sheets_find`, exercised against a fake Drive client.
 *
 * All ids, names and addresses here are invented.
 */
import { describe, expect, test } from "vitest";

import { errorOf, isFailure } from "../src/lib/result.js";
import {
  buildDriveQuery,
  buildFolderQuery,
  createFindTool,
  escapeDriveQuery,
} from "../src/tools/find.js";
import { makeMutationContext, type FakeMutationOptions } from "./helpers/fakeMutations.js";

const SPREADSHEETS = "https://www.googleapis.com/auth/spreadsheets";
const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_READONLY = "https://www.googleapis.com/auth/drive.readonly";

const FILES = [
  { id: "1RoStErSpReAdShEeTiDaBcDeFgHiJkLmNoPq", name: "Fall Enrichment Roster" },
  { id: "1BuDgEtSpReAdShEeTiDaBcDeFgHiJkLmNoPqR", name: "Fall Enrichment Budget" },
];

const FOLDERS = [
  { id: "0AEnRiChMeNtFoLdErIdAbCdEf", name: "Enrichment" },
  { id: "0AMuSiClEsSoNsFoLdErIdAbCd", name: "Music Lessons" },
];

function tool(options: FakeMutationOptions = {}) {
  const { context, calls } = makeMutationContext({ tabs: [{ title: "Sheet1", sheetId: 0 }] }, options);
  return { find: createFindTool({ getContext: async () => context }), calls };
}

describe("the Drive query", () => {
  test("always filters to spreadsheets that are not in the trash", () => {
    expect(buildDriveQuery()).toBe(
      "mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
    );
  });

  test("adds a title filter and a folder filter", () => {
    const q = buildDriveQuery("Roster", "folder-1");
    expect(q).toContain("name contains 'Roster'");
    expect(q).toContain("'folder-1' in parents");
  });

  test("escapes a quote in a title so the query is not broken by an apostrophe", () => {
    expect(escapeDriveQuery("Jordan's sheet")).toBe("Jordan\\'s sheet");
    expect(buildDriveQuery("Jordan's sheet")).toContain("name contains 'Jordan\\'s sheet'");
  });

  test("the folder query asks for folders and treats folder as the parent", () => {
    expect(buildFolderQuery()).toBe(
      "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    );
    const q = buildFolderQuery("Music", "0AParentIdAbCdEf");
    expect(q).toContain("name contains 'Music'");
    expect(q).toContain("'0AParentIdAbCdEf' in parents");
  });
});

describe("list", () => {
  test("returns spreadsheets with their ids", async () => {
    const t = tool({ scopes: [SPREADSHEETS, DRIVE_READONLY], driveFiles: FILES });
    const response = await t.find.handler({ action: "list", query: "Fall" });
    expect(isFailure(response)).toBe(false);
    const structured = response.structuredContent as { spreadsheets: Array<{ title: string }> };
    expect(structured.spreadsheets.map((s) => s.title)).toEqual([
      "Fall Enrichment Roster",
      "Fall Enrichment Budget",
    ]);
    expect(response.content[0].text).toContain("1RoStErSpReAdShEeTiDaBcDeFgHiJkLmNoPq");
  });

  test("warns when the token cannot see the whole Drive but still found something", async () => {
    const t = tool({ scopes: [SPREADSHEETS, DRIVE_FILE], driveFiles: FILES });
    const response = await t.find.handler({ action: "list" });
    expect(isFailure(response)).toBe(false);
    expect((response.structuredContent as { scope_limited: boolean }).scope_limited).toBe(true);
    expect(response.content[0].text).toContain("drive.readonly");
  });

  test("an empty result without the scope is a teaching error, not 'no such sheet'", async () => {
    const t = tool({ scopes: [SPREADSHEETS, DRIVE_FILE], driveFiles: [] });
    const response = await t.find.handler({ action: "list", query: "Roster" });
    expect(isFailure(response)).toBe(true);
    const error = errorOf(response);
    expect(error?.code).toBe("permission_denied");
    expect(error?.message).toContain("drive.readonly");
    expect(error?.hint).toContain("gsheets-pro auth --drive-readonly");
  });

  test("an empty result with the scope is simply empty", async () => {
    const t = tool({ scopes: [SPREADSHEETS, DRIVE_READONLY], driveFiles: [] });
    const response = await t.find.handler({ action: "list", query: "Nothing" });
    expect(isFailure(response)).toBe(false);
    expect(response.content[0].text).toContain("0 spreadsheets");
  });

  test("a token with no Drive scope at all is refused before the call", async () => {
    const t = tool({ scopes: [SPREADSHEETS] });
    const response = await t.find.handler({ action: "list" });
    expect(errorOf(response)?.code).toBe("permission_denied");
    expect(t.calls.driveList).toHaveLength(0);
  });

  test("Drive's own scope refusal becomes the same teaching error", async () => {
    const t = tool({
      scopes: [],
      driveError: { status: 403, message: "Request had insufficient authentication scopes." },
    });
    const response = await t.find.handler({ action: "list" });
    expect(errorOf(response)?.code).toBe("permission_denied");
    expect(errorOf(response)?.hint).toContain("Restricted scope");
  });
});

describe("folders", () => {
  test("returns folders with their ids, and says what a folder id is for", async () => {
    const t = tool({ scopes: [SPREADSHEETS, DRIVE_READONLY], driveFolders: FOLDERS });
    const response = await t.find.handler({ action: "folders" });
    expect(isFailure(response)).toBe(false);
    const structured = response.structuredContent as {
      folders: Array<{ folder_id: string; name: string; url: string }>;
    };
    expect(structured.folders.map((f) => f.name)).toEqual(["Enrichment", "Music Lessons"]);
    expect(structured.folders[0].folder_id).toBe("0AEnRiChMeNtFoLdErIdAbCdEf");
    expect(structured.folders[0].url).toContain("drive.google.com/drive/folders/");
    expect(response.content[0].text).toContain("goes straight into folder on list");
  });

  test("asks Drive for folders, not spreadsheets", async () => {
    const t = tool({ scopes: [SPREADSHEETS, DRIVE_READONLY], driveFolders: FOLDERS });
    await t.find.handler({ action: "folders", query: "Music" });
    const params = t.calls.driveList[0] as { q: string; orderBy: string };
    expect(params.q).toContain("apps.folder");
    expect(params.q).not.toContain("apps.spreadsheet");
    expect(params.q).toContain("name contains 'Music'");
    expect(params.orderBy).toBe("name");
  });

  test("a parent folder is passed through as an in parents clause", async () => {
    const t = tool({ scopes: [SPREADSHEETS, DRIVE_READONLY], driveFolders: FOLDERS });
    const response = await t.find.handler({ action: "folders", folder: "0AParentIdAbCdEf" });
    expect((t.calls.driveList[0] as { q: string }).q).toContain("'0AParentIdAbCdEf' in parents");
    expect(response.content[0].text).toContain("inside 0AParentIdAbCdEf");
  });

  test("an empty result without the scope is a teaching error, since folders are never app-created", async () => {
    const t = tool({ scopes: [SPREADSHEETS, DRIVE_FILE], driveFolders: [] });
    const response = await t.find.handler({ action: "folders" });
    expect(isFailure(response)).toBe(true);
    const error = errorOf(response);
    expect(error?.code).toBe("permission_denied");
    expect(error?.message).toContain("drive.readonly");
    expect(error?.hint).toContain("this app never creates a folder");
  });

  test("an empty result with the scope is simply empty", async () => {
    const t = tool({ scopes: [SPREADSHEETS, DRIVE_READONLY], driveFolders: [] });
    const response = await t.find.handler({ action: "folders" });
    expect(isFailure(response)).toBe(false);
    expect(response.content[0].text).toContain("0 folders");
  });

  test("a token with no Drive scope at all is refused before the call", async () => {
    const t = tool({ scopes: [SPREADSHEETS] });
    const response = await t.find.handler({ action: "folders" });
    expect(errorOf(response)?.code).toBe("permission_denied");
    expect(t.calls.driveList).toHaveLength(0);
  });

  test("Drive's own scope refusal becomes the same teaching error", async () => {
    const t = tool({
      scopes: [],
      driveError: { status: 403, message: "Request had insufficient authentication scopes." },
    });
    const response = await t.find.handler({ action: "folders" });
    expect(errorOf(response)?.code).toBe("permission_denied");
    expect(errorOf(response)?.hint).toContain("Restricted scope");
  });
});

describe("paging", () => {
  test("folders carries the next page token back and says how to use it", async () => {
    const t = tool({
      scopes: [SPREADSHEETS, DRIVE_READONLY],
      driveFolders: FOLDERS,
      driveNextPageToken: "token-2",
    });
    const response = await t.find.handler({ action: "folders" });
    expect((response.structuredContent as { next_page_token: string }).next_page_token).toBe("token-2");
    expect(response.content[0].text).toContain("page_token");
  });

  test("a page token is passed through to Drive", async () => {
    const t = tool({ scopes: [SPREADSHEETS, DRIVE_READONLY], driveFolders: FOLDERS });
    await t.find.handler({ action: "folders", page_token: "token-2" });
    expect(t.calls.driveList[0]).toMatchObject({ pageToken: "token-2" });
  });

  test("list pages the same way", async () => {
    const t = tool({
      scopes: [SPREADSHEETS, DRIVE_READONLY],
      driveFiles: FILES,
      driveNextPageToken: "token-2",
    });
    const first = await t.find.handler({ action: "list" });
    expect((first.structuredContent as { next_page_token: string }).next_page_token).toBe("token-2");
    await t.find.handler({ action: "list", page_token: "token-2" });
    expect(t.calls.driveList[1]).toMatchObject({ pageToken: "token-2" });
  });

  test("no page token means none is sent and none is reported", async () => {
    const t = tool({ scopes: [SPREADSHEETS, DRIVE_READONLY], driveFiles: FILES });
    const response = await t.find.handler({ action: "list" });
    expect((response.structuredContent as { next_page_token: null }).next_page_token).toBeNull();
    expect(t.calls.driveList[0]).not.toHaveProperty("pageToken");
  });
});

describe("share", () => {
  test("refuses without confirm and shares nothing", async () => {
    const t = tool();
    const response = await t.find.handler({
      action: "share",
      spreadsheet_id: "1RoStErSpReAdShEeTiDaBcDeFgHiJkLmNoPq",
      email: "colleague@example.org",
    });
    expect(errorOf(response)?.code).toBe("needs_confirmation");
    expect(t.calls.drivePermissions).toHaveLength(0);
  });

  test("confirm must be the address being shared with", async () => {
    const t = tool();
    const response = await t.find.handler({
      action: "share",
      spreadsheet_id: "1RoStErSpReAdShEeTiDaBcDeFgHiJkLmNoPq",
      email: "colleague@example.org",
      confirm: "yes",
    });
    expect(errorOf(response)?.code).toBe("needs_confirmation");
    expect(t.calls.drivePermissions).toHaveLength(0);
  });

  test("sends no notification email unless asked", async () => {
    const t = tool();
    const response = await t.find.handler({
      action: "share",
      spreadsheet_id: "1RoStErSpReAdShEeTiDaBcDeFgHiJkLmNoPq",
      email: "colleague@example.org",
      confirm: "colleague@example.org",
    });
    expect(isFailure(response)).toBe(false);
    expect(t.calls.drivePermissions[0]).toMatchObject({
      sendNotificationEmail: false,
      requestBody: { type: "user", role: "reader", emailAddress: "colleague@example.org" },
    });
    expect(response.content[0].text).toContain("No email was sent");
  });

  test("passes the role through and reports it in words", async () => {
    const t = tool();
    const response = await t.find.handler({
      action: "share",
      spreadsheet_id: "1RoStErSpReAdShEeTiDaBcDeFgHiJkLmNoPq",
      email: "colleague@example.org",
      role: "writer",
      confirm: "colleague@example.org",
    });
    expect(t.calls.drivePermissions[0]).toMatchObject({ requestBody: { role: "writer" } });
    expect(response.content[0].text).toContain("can now edit");
  });

  test("a malformed address is caught before Drive sees it", async () => {
    const t = tool();
    const response = await t.find.handler({
      action: "share",
      spreadsheet_id: "1RoStErSpReAdShEeTiDaBcDeFgHiJkLmNoPq",
      email: "not-an-address",
      confirm: "not-an-address",
    });
    expect(errorOf(response)?.code).toBe("invalid_argument");
    expect(t.calls.drivePermissions).toHaveLength(0);
  });
});

describe("copy", () => {
  test("names the copy and reports the new id", async () => {
    const t = tool();
    const response = await t.find.handler({
      action: "copy",
      spreadsheet_id: "1RoStErSpReAdShEeTiDaBcDeFgHiJkLmNoPq",
      title: "Fall Enrichment Roster, working copy",
      folder: "folder-9",
    });
    expect(isFailure(response)).toBe(false);
    expect(t.calls.driveCopy[0]).toMatchObject({
      requestBody: { name: "Fall Enrichment Roster, working copy", parents: ["folder-9"] },
    });
    const structured = response.structuredContent as { spreadsheet_id: string; warnings: string[] };
    expect(structured.spreadsheet_id).toBe("1CoPiEdSpReAdShEeTiDaBcDeFgHiJkLmNoPq");
    expect(structured.warnings.join(" ")).toContain("no registry entry covers it");
  });

  test("insists on a title rather than leaving Google to name it", async () => {
    const t = tool();
    const response = await t.find.handler({
      action: "copy",
      spreadsheet_id: "1RoStErSpReAdShEeTiDaBcDeFgHiJkLmNoPq",
    });
    expect(errorOf(response)?.code).toBe("invalid_argument");
    expect(t.calls.driveCopy).toHaveLength(0);
  });
});
