import { describe, expect, test } from "vitest";

import { columnLetterToIndex } from "../src/lib/a1.js";
import {
  buildContract,
  inferConventions,
  markUiOwned,
  METADATA_KEYS,
  readColumnMetadata,
  readManifest,
  readSheetMetadata,
  toMetadataEntries,
} from "../src/lib/contract.js";
import { parseRegistry } from "../src/lib/registry.js";

const TRACKER_ID = "1AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTt";

const registry = parseRegistry(
  JSON.stringify({
    spreadsheets: {
      [TRACKER_ID]: {
        name: "Vendor Onboarding Tracker",
        owner: "shared",
        writable_columns: ["A:C"],
        colleague_safe_text: true,
      },
    },
  }),
);

function columnMetadata(sheetId: number, index: number, value: object) {
  return {
    metadataKey: METADATA_KEYS.column,
    metadataValue: JSON.stringify(value),
    location: { dimensionRange: { sheetId, dimension: "COLUMNS", startIndex: index } },
  };
}

describe("reading developer metadata", () => {
  test("flattens the three location shapes", () => {
    const entries = toMetadataEntries([
      { metadataKey: METADATA_KEYS.manifest, metadataValue: '{"version":1}', location: {} },
      { metadataKey: METADATA_KEYS.sheet, metadataValue: '{"archetype":"tracker"}', location: { sheetId: 4 } },
      columnMetadata(4, 2, { name: "email", role: "key" }),
    ]);
    expect(entries.map((e) => e.scope)).toEqual(["SPREADSHEET", "SHEET", "COLUMN"]);
    expect(entries[2].dimension).toEqual({ sheetId: 4, type: "COLUMNS", index: 2 });
  });

  test("reads each level back", () => {
    const entries = toMetadataEntries([
      { metadataKey: METADATA_KEYS.manifest, metadataValue: '{"version":1,"preset":"park"}', location: {} },
      {
        metadataKey: METADATA_KEYS.sheet,
        metadataValue: '{"archetype":"tracker","keyColumn":"C"}',
        location: { sheetId: 4 },
      },
      columnMetadata(4, 0, { name: "vendor", role: "input" }),
      columnMetadata(4, 2, { name: "email", role: "key", header: "Email Address" }),
    ]);
    expect(readManifest(entries)).toEqual({ version: 1, preset: "park" });
    expect(readSheetMetadata(entries, 4)).toEqual({ archetype: "tracker", keyColumn: "C" });
    const columns = readColumnMetadata(entries, 4);
    expect(columns.get(0)?.name).toBe("vendor");
    expect(columns.get(2)?.role).toBe("key");
  });

  test("metadata for another tab is ignored", () => {
    const entries = toMetadataEntries([columnMetadata(9, 0, { name: "other" })]);
    expect(readColumnMetadata(entries, 4).size).toBe(0);
  });

  test("unparseable metadata is skipped rather than crashing the open", () => {
    const entries = toMetadataEntries([
      { metadataKey: METADATA_KEYS.column, metadataValue: "not json", location: { dimensionRange: { sheetId: 4, dimension: "COLUMNS", startIndex: 0 } } },
    ]);
    expect(readColumnMetadata(entries, 4).size).toBe(0);
  });

  test("entries with no key or value are dropped", () => {
    expect(toMetadataEntries([{ metadataKey: null, metadataValue: "x" }])).toEqual([]);
  });
});

describe("buildContract", () => {
  test("with neither source it says no contract, out loud", () => {
    const contract = buildContract({ sheet: "Tracker", headers: ["Name", "Email"] });
    expect(contract.source).toBe("none");
    expect(contract.summary).toMatch(/No contract/);
    expect(contract.columns.every((c) => c.writable)).toBe(true);
  });

  test("registry alone marks the columns that are not ours", () => {
    const contract = buildContract({
      sheet: "Tracker",
      headers: ["Vendor", "Instructor", "Email", "ICORI", "Fingerprints"],
      policy: registry.policyFor(TRACKER_ID, "Tracker"),
    });
    expect(contract.source).toBe("registry");
    expect(contract.columns.map((c) => c.writable)).toEqual([true, true, true, false, false]);
    expect(contract.colleagueSafeText).toBe(true);
  });

  test("metadata alone carries roles", () => {
    const entries = toMetadataEntries([
      columnMetadata(4, 0, { name: "vendor", role: "input" }),
      columnMetadata(4, 2, { name: "email", role: "key" }),
    ]);
    const contract = buildContract({
      sheet: "Tracker",
      headers: ["Vendor", "Instructor", "Email"],
      columnMetadata: readColumnMetadata(entries, 4),
    });
    expect(contract.source).toBe("metadata");
    expect(contract.columns[0].role).toBe("input");
    expect(contract.columns[2].role).toBe("key");
  });

  test("both sources are reported as both", () => {
    const contract = buildContract({
      sheet: "Tracker",
      headers: ["Vendor", "Email"],
      policy: registry.policyFor(TRACKER_ID),
      columnMetadata: readColumnMetadata(toMetadataEntries([columnMetadata(4, 0, { name: "vendor" })]), 4),
    });
    expect(contract.source).toBe("registry+metadata");
    expect(contract.summary).toContain("Registry");
    expect(contract.summary).toContain("Metadata");
  });

  test("a renamed header surfaces as drift rather than as silence", () => {
    const entries = toMetadataEntries([
      columnMetadata(4, 1, { name: "email", header: "Email Address", role: "key" }),
    ]);
    const contract = buildContract({
      sheet: "Tracker",
      headers: ["Vendor", "Contact Email"],
      columnMetadata: readColumnMetadata(entries, 4),
    });
    expect(contract.drift).toHaveLength(1);
    expect(contract.drift[0]).toMatch(/Column B/);
    expect(contract.drift[0]).toMatch(/Email Address/);
    expect(contract.columns[1].role).toBe("key");
  });

  test("an unchanged header is not drift", () => {
    const entries = toMetadataEntries([columnMetadata(4, 0, { name: "vendor", header: "Vendor" })]);
    const contract = buildContract({
      sheet: "Tracker",
      headers: ["Vendor"],
      columnMetadata: readColumnMetadata(entries, 4),
    });
    expect(contract.drift).toEqual([]);
  });

  test("a column with metadata past the header row still appears", () => {
    const entries = toMetadataEntries([columnMetadata(4, 5, { name: "check", role: "check" })]);
    const contract = buildContract({
      sheet: "Tracker",
      headers: ["A", "B"],
      columnMetadata: readColumnMetadata(entries, 4),
    });
    expect(contract.columns).toHaveLength(6);
    expect(contract.columns[5].letter).toBe("F");
  });

  test("archetype and preset come from the sheet, then the manifest", () => {
    const fromSheet = buildContract({
      sheet: "Tracker",
      sheetMetadata: { archetype: "model" },
      manifest: { archetype: "tracker", preset: "park" },
    });
    expect(fromSheet.archetype).toBe("model");
    expect(fromSheet.preset).toBe("park");
  });
});

describe("inferConventions", () => {
  const rows = [
    ["Name", "Grade", "Fee"],
    ["Ana", "3", "120"],
    ["Bo", "4", "120"],
    ["Cy", "5", "160"],
  ];

  test("a frozen row is the header", () => {
    const c = inferConventions({ rows, frozenRowCount: 1 });
    expect(c.headerRow).toBe(1);
    expect(c.firstDataRow).toBe(2);
    expect(c.headers).toEqual(["Name", "Grade", "Fee"]);
    expect(c.frozenHeader).toBe(true);
  });

  test("with nothing frozen, the first all text row is the header", () => {
    const c = inferConventions({ rows });
    expect(c.headerRow).toBe(1);
    expect(c.frozenHeader).toBe(false);
    expect(c.notes.some((n) => n.includes("not frozen"))).toBe(true);
  });

  test("a title row above the header is skipped", () => {
    const c = inferConventions({
      rows: [["Fall roster"], ["Name", "Grade"], ["Ana", "3"]],
    });
    expect(c.headerRow).toBe(2);
    expect(c.headers).toEqual(["Name", "Grade"]);
  });

  test("the key column is the first complete and unique one", () => {
    expect(inferConventions({ rows, frozenRowCount: 1 }).keyColumn).toBe("A");
  });

  test("a column with a repeat is not a key", () => {
    const c = inferConventions({
      rows: [
        ["Name", "Grade"],
        ["Ana", "3"],
        ["Ana", "4"],
      ],
      frozenRowCount: 1,
    });
    expect(c.keyColumn).toBe("B");
  });

  test("no key at all is said out loud", () => {
    const c = inferConventions({
      rows: [
        ["Name", "Grade"],
        ["Ana", ""],
        ["Ana", ""],
      ],
      frozenRowCount: 1,
    });
    expect(c.keyColumn).toBeUndefined();
    expect(c.notes.some((n) => n.includes("no obvious key"))).toBe(true);
  });

  test("a blank row splitting the tab is flagged, because appends land wrong there", () => {
    const c = inferConventions({
      rows: [
        ["Name", "Grade"],
        ["Ana", "3"],
        [],
        ["Totals", "1"],
      ],
      frozenRowCount: 1,
    });
    expect(c.multipleBlocks).toBe(true);
    expect(c.notes.some((n) => n.includes("blank row"))).toBe(true);
  });

  test("one block is not flagged", () => {
    expect(inferConventions({ rows, frozenRowCount: 1 }).multipleBlocks).toBe(false);
  });

  test("banding and filters are passed through", () => {
    const c = inferConventions({ rows, frozenRowCount: 1, hasBanding: true, hasFilter: true });
    expect(c.banded).toBe(true);
    expect(c.filtered).toBe(true);
  });

  test("an empty tab yields nothing rather than guessing", () => {
    const c = inferConventions({ rows: [] });
    expect(c.headerRow).toBeUndefined();
    expect(c.headers).toEqual([]);
  });

  test("a numeric first row is not mistaken for a header", () => {
    const c = inferConventions({ rows: [["1", "2"], ["Name", "Grade"], ["Ana", "3"]] });
    expect(c.headerRow).toBe(2);
  });
});

describe("markUiOwned", () => {
  const rule = { column: "D", range: "D:D", values: ["Pending", "Done"], strict: true };

  test("a dropdown on a column the plugin owns is not ui owned", () => {
    const [marked] = markUiOwned([rule], new Set([columnLetterToIndex("D")]), columnLetterToIndex);
    expect(marked.uiOwned).toBe(false);
    expect(marked.note).toBeUndefined();
  });

  test("a dropdown on any other column is the human's", () => {
    const [marked] = markUiOwned([rule], new Set([0, 1]), columnLetterToIndex);
    expect(marked.uiOwned).toBe(true);
    expect(marked.note).toMatch(/chip colours/);
    expect(marked.note).toMatch(/force/);
  });

  test("a rule spanning more than one column has no letter and is treated as the human's", () => {
    const [marked] = markUiOwned(
      [{ range: "D:F", values: [], strict: false }],
      new Set([3, 4, 5]),
      columnLetterToIndex,
    );
    expect(marked.uiOwned).toBe(true);
  });

  test("with no plugin columns at all, every rule is the human's", () => {
    const marked = markUiOwned([rule], new Set(), columnLetterToIndex);
    expect(marked.every((m) => m.uiOwned)).toBe(true);
  });
});
