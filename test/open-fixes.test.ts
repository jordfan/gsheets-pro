/**
 * Two behaviours of `sheets_open` worth pinning down separately.
 *
 * The "no contract" paragraph is long, and it used to repeat on every tab of a
 * spreadsheet that has no contract, which is every spreadsheet a person built.
 * Six tabs of it buried the tabs that did have one. It is said once.
 *
 * And a pasted URL is what a person actually has in hand, so it is read rather
 * than refused with a lesson about where the id lives.
 */
import { describe, expect, test } from "vitest";

import { isFailure } from "../src/lib/result.js";
import { createOpenTool } from "../src/tools/open.js";
import { FAKE_SPREADSHEET_ID, makeFakeContext, type FakeSpreadsheet } from "./helpers/fakeContext.js";

const THREE_TABS: FakeSpreadsheet = {
  title: "Autumn Clubs",
  tabs: [
    {
      title: "Roster",
      sheetId: 0,
      index: 0,
      frozenRowCount: 1,
      values: [
        ["Student", "Grade"],
        ["Ana Reyes", "3"],
      ],
    },
    {
      title: "Vendors",
      sheetId: 1,
      index: 1,
      frozenRowCount: 1,
      values: [
        ["Vendor", "Contact"],
        ["Clay Studio", "hello@example.invalid"],
      ],
    },
    {
      title: "Notes",
      sheetId: 2,
      index: 2,
      values: [["A line of notes"]],
    },
  ],
};

function tool(spreadsheet: FakeSpreadsheet = THREE_TABS, registryJson?: string) {
  const fake = makeFakeContext(spreadsheet, registryJson);
  return { ...fake, run: createOpenTool({ getContext: async () => fake.context }).handler };
}

const countOf = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("the no-contract paragraph", () => {
  test("is said once for the spreadsheet, not once per tab", async () => {
    const { run } = tool();
    const response = await run({ spreadsheet_id: FAKE_SPREADSHEET_ID });
    const text = response.content[0].text;

    expect(countOf(text, "No contract")).toBe(1);
    expect(text).toContain("no registry entry and no plugin metadata");
    expect(countOf(text, "nothing is protected beyond the formula guard")).toBe(1);
  });

  test("each tab still carries its own contract in the structured result", async () => {
    const { run } = tool();
    const response = await run({ spreadsheet_id: FAKE_SPREADSHEET_ID });
    const tabs = (response.structuredContent as { tabs: Array<{ contract: { source: string } }> }).tabs;
    expect(tabs).toHaveLength(3);
    expect(tabs.every((t) => t.contract.source === "none")).toBe(true);
  });

  test("when only some tabs lack a contract, the paragraph names them", async () => {
    const registry = JSON.stringify({
      spreadsheets: {
        [FAKE_SPREADSHEET_ID]: {
          name: "Autumn Clubs",
          sheets: { Roster: { owner: "shared", writable_columns: ["A:B"] } },
        },
      },
    });
    const { run } = tool(THREE_TABS, registry);
    const response = await run({ spreadsheet_id: FAKE_SPREADSHEET_ID });
    const text = response.content[0].text;

    // The registry entry covers the whole spreadsheet, so every tab has a
    // contract and the paragraph does not appear at all.
    expect(text).not.toContain("No contract");
    expect(text).toContain("Contract:");
  });

  test("a tab with a contract still shows its summary on its own line", async () => {
    const registry = JSON.stringify({
      spreadsheets: { [FAKE_SPREADSHEET_ID]: { name: "Autumn Clubs", owner: "shared" } },
    });
    const { run } = tool(THREE_TABS, registry);
    const response = await run({ spreadsheet_id: FAKE_SPREADSHEET_ID });
    expect(countOf(response.content[0].text, "Contract: Registry")).toBe(3);
  });
});

describe("a pasted URL", () => {
  test("opens the spreadsheet the URL names", async () => {
    const { run, calls } = tool();
    const response = await run({
      spreadsheet_id: `https://docs.google.com/spreadsheets/d/${FAKE_SPREADSHEET_ID}/edit?gid=0#gid=0`,
    });

    expect(isFailure(response)).toBe(false);
    const spreadsheet = (response.structuredContent as { spreadsheet: { id: string; url: string } })
      .spreadsheet;
    expect(spreadsheet.id).toBe(FAKE_SPREADSHEET_ID);
    expect(spreadsheet.url).toBe(
      `https://docs.google.com/spreadsheets/d/${FAKE_SPREADSHEET_ID}/edit`,
    );
    expect((calls.get[0] as { spreadsheetId: string }).spreadsheetId).toBe(FAKE_SPREADSHEET_ID);
  });

  test("the description says a URL works", () => {
    const fake = makeFakeContext(THREE_TABS);
    const definition = createOpenTool({ getContext: async () => fake.context });
    const description = definition.config.inputSchema.spreadsheet_id.description ?? "";
    expect(description).toContain("A full URL works too");
  });

  test("something that is neither is refused with a hint about tab names", async () => {
    const { run } = tool();
    const response = await run({ spreadsheet_id: "Roster" });
    expect(isFailure(response)).toBe(true);
  });
});
