import { describe, expect, test, vi } from "vitest";

import { GsheetsError } from "../src/lib/errors.js";

import {
  SheetCache,
  sheetInfoFromProperties,
  SHEET_PROPERTIES_MASK,
  type SheetInfo,
} from "../src/lib/sheetcache.js";

function tab(title: string, sheetId: number, index = 0): SheetInfo {
  return { sheetId, title, index, sheetType: "GRID", hidden: false };
}

describe("SheetCache", () => {
  test("resolves a tab name to its id, ignoring case", async () => {
    const cache = new SheetCache(async () => [tab("Tracker", 7)]);
    expect((await cache.resolve("s", "Tracker")).sheetId).toBe(7);
    expect((await cache.resolve("s", "tracker")).sheetId).toBe(7);
    expect((await cache.resolve("s", "  TRACKER ")).sheetId).toBe(7);
  });

  test("loads once and serves the rest from cache", async () => {
    const loader = vi.fn(async () => [tab("Tracker", 7), tab("Notes", 8, 1)]);
    const cache = new SheetCache(loader);
    await cache.resolve("s", "Tracker");
    await cache.resolve("s", "Notes");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  test("a miss refreshes once before it gives up, so a tab made a second ago is found", async () => {
    let tabs = [tab("Tracker", 7)];
    const loader = vi.fn(async () => tabs);
    const cache = new SheetCache(loader);
    await cache.resolve("s", "Tracker");

    tabs = [tab("Tracker", 7), tab("Fresh", 9, 1)];
    expect((await cache.resolve("s", "Fresh")).sheetId).toBe(9);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  test("a genuine miss names the tabs that do exist, in the hint", async () => {
    const cache = new SheetCache(async () => [tab("Tracker", 7), tab("Notes", 8, 1)]);
    await expect(cache.resolve("s", "Trackr")).rejects.toThrow(/No tab named "Trackr"/);
    const error = await cache.resolve("s", "Trackr").catch((e: GsheetsError) => e);
    expect(error).toBeInstanceOf(GsheetsError);
    expect((error as GsheetsError).code).toBe("sheet_not_found");
    expect((error as GsheetsError).hint).toMatch(/Tracker, Notes/);
    expect((error as GsheetsError).details).toEqual({ available: ["Tracker", "Notes"] });
  });

  test("an empty tab name is refused with advice, not a lookup", async () => {
    const loader = vi.fn(async () => [tab("Tracker", 7)]);
    const cache = new SheetCache(loader);
    await expect(cache.resolve("s", "  ")).rejects.toThrow(/sheet is required/);
    expect(loader).not.toHaveBeenCalled();
  });

  test("concurrent callers share one load", async () => {
    const loader = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return [tab("Tracker", 7)];
    });
    const cache = new SheetCache(loader);
    const results = await Promise.all([
      cache.resolve("s", "Tracker"),
      cache.resolve("s", "Tracker"),
      cache.resolve("s", "Tracker"),
    ]);
    expect(results.map((r) => r.sheetId)).toEqual([7, 7, 7]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  test("the ttl expires the map", async () => {
    let now = 1000;
    const loader = vi.fn(async () => [tab("Tracker", 7)]);
    const cache = new SheetCache(loader, { ttlMs: 100, now: () => now });
    await cache.list("s");
    now += 50;
    await cache.list("s");
    expect(loader).toHaveBeenCalledTimes(1);
    now += 100;
    await cache.list("s");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  test("invalidate forces the next load", async () => {
    const loader = vi.fn(async () => [tab("Tracker", 7)]);
    const cache = new SheetCache(loader);
    await cache.list("s");
    cache.invalidate("s");
    await cache.list("s");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  test("priming from a response a tool already has spends no read", async () => {
    const loader = vi.fn(async () => {
      throw new Error("should not be called");
    });
    const cache = new SheetCache(loader as never);
    cache.prime("s", [tab("Tracker", 7)]);
    expect((await cache.resolve("s", "Tracker")).sheetId).toBe(7);
    expect(loader).not.toHaveBeenCalled();
  });

  test("resolveId goes the other way", async () => {
    const cache = new SheetCache(async () => [tab("Tracker", 7)]);
    expect((await cache.resolveId("s", 7))?.title).toBe("Tracker");
    expect(await cache.resolveId("s", 999)).toBeUndefined();
  });

  test("titles come back in tab order", async () => {
    const cache = new SheetCache(async () => [tab("A", 1, 0), tab("B", 2, 1), tab("C", 3, 2)]);
    expect((await cache.list("s")).titles).toEqual(["A", "B", "C"]);
  });

  test("two spreadsheets do not share a map", async () => {
    const cache = new SheetCache(async (id) => [tab(id === "one" ? "Alpha" : "Beta", 1)]);
    expect((await cache.list("one")).titles).toEqual(["Alpha"]);
    expect((await cache.list("two")).titles).toEqual(["Beta"]);
  });
});

describe("sheetInfoFromProperties", () => {
  test("maps the fields the mask asks for", () => {
    expect(
      sheetInfoFromProperties({
        sheetId: 3,
        title: "Tracker",
        index: 1,
        sheetType: "GRID",
        hidden: false,
        gridProperties: { rowCount: 100, columnCount: 12, frozenRowCount: 1 },
      }),
    ).toEqual({
      sheetId: 3,
      title: "Tracker",
      index: 1,
      sheetType: "GRID",
      hidden: false,
      rowCount: 100,
      columnCount: 12,
      frozenRowCount: 1,
      frozenColumnCount: undefined,
    });
  });

  test("a sheet id of zero is real, not missing", () => {
    expect(sheetInfoFromProperties({ sheetId: 0, title: "Sheet1" })?.sheetId).toBe(0);
  });

  test("a properties block with no title yields nothing", () => {
    expect(sheetInfoFromProperties({ sheetId: 1 })).toBeUndefined();
    expect(sheetInfoFromProperties({ title: "Tracker" })).toBeUndefined();
  });

  test("the mask names every field the mapper reads", () => {
    for (const field of ["sheetId", "title", "index", "sheetType", "hidden", "frozenRowCount"]) {
      expect(SHEET_PROPERTIES_MASK).toContain(field);
    }
  });
});
