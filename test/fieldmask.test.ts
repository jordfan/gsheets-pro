/**
 * The field mask builder.
 *
 * The stakes here are the reason this is tested hard: a mask that is one level
 * too shallow wipes formatting the plugin never touched.
 */
import { describe, expect, test } from "vitest";

import {
  buildFieldMask,
  fieldMaskPaths,
  isEmptyRequest,
  pruneUndefined,
} from "../src/lib/fieldmask.js";

describe("fieldMaskPaths", () => {
  test("names only the fields that were passed", () => {
    const cell = {
      userEnteredFormat: {
        textFormat: { bold: true },
        horizontalAlignment: "LEFT",
      },
    };
    expect(fieldMaskPaths(cell)).toEqual([
      "userEnteredFormat.textFormat.bold",
      "userEnteredFormat.horizontalAlignment",
    ]);
  });

  test("a mask of the parent would wipe the siblings, so it never emits one", () => {
    const mask = buildFieldMask({ userEnteredFormat: { textFormat: { bold: true } } });
    expect(mask).toBe("userEnteredFormat.textFormat.bold");
    expect(mask).not.toBe("userEnteredFormat");
  });

  test("undefined is skipped, because it means the caller did not pass it", () => {
    const paths = fieldMaskPaths({
      userEnteredFormat: { textFormat: { bold: true, italic: undefined } },
    });
    expect(paths).toEqual(["userEnteredFormat.textFormat.bold"]);
  });

  test("null is masked, because that is how a field gets cleared", () => {
    const paths = fieldMaskPaths({ userEnteredFormat: { backgroundColorStyle: null } });
    expect(paths).toEqual(["userEnteredFormat.backgroundColorStyle"]);
  });

  test("colors are masked whole, never a channel at a time", () => {
    const paths = fieldMaskPaths({
      userEnteredFormat: {
        backgroundColorStyle: { themeColor: "ACCENT1" },
        textFormat: { foregroundColorStyle: { rgbColor: { red: 1, green: 0, blue: 0 } } },
      },
    });
    expect(paths).toEqual([
      "userEnteredFormat.backgroundColorStyle",
      "userEnteredFormat.textFormat.foregroundColorStyle",
    ]);
  });

  test("a number format is masked whole, because type and pattern must agree", () => {
    const paths = fieldMaskPaths({
      userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: '"$"#,##0.00' } },
    });
    expect(paths).toEqual(["userEnteredFormat.numberFormat"]);
  });

  test("a prefix is prepended to every path", () => {
    const paths = fieldMaskPaths({ bold: true, italic: false }, { prefix: "userEnteredFormat.textFormat" });
    expect(paths).toEqual([
      "userEnteredFormat.textFormat.bold",
      "userEnteredFormat.textFormat.italic",
    ]);
  });

  test("an empty object asks for the field, which resets the subtree", () => {
    expect(fieldMaskPaths({ userEnteredFormat: {} })).toEqual(["userEnteredFormat"]);
  });

  test("an all undefined object asks for nothing", () => {
    expect(fieldMaskPaths({ a: undefined, b: { c: undefined } })).toEqual([]);
    expect(isEmptyRequest({ a: undefined })).toBe(true);
  });

  test("arrays are values, not paths to walk", () => {
    const paths = fieldMaskPaths({ condition: { type: "ONE_OF_LIST", values: [{ v: "a" }] } });
    expect(paths).toEqual(["condition"]);
  });

  test("false and zero are real values", () => {
    expect(fieldMaskPaths({ textFormat: { bold: false, fontSize: 0 } })).toEqual([
      "textFormat.bold",
      "textFormat.fontSize",
    ]);
  });

  test("duplicates collapse", () => {
    expect(fieldMaskPaths({ a: { b: 1 }, c: undefined })).toEqual(["a.b"]);
  });

  test("extra leaves can be declared per call", () => {
    const paths = fieldMaskPaths(
      { gridProperties: { rowCount: 10, columnCount: 4 } },
      { extraLeaves: ["gridProperties"] },
    );
    expect(paths).toEqual(["gridProperties"]);
  });

  test("a nested leaf can be named by its full path", () => {
    const paths = fieldMaskPaths(
      { properties: { tabColorStyle: { themeColor: "ACCENT1" }, title: "Tracker" } },
      { extraLeaves: ["properties.title"] },
    );
    expect(paths).toEqual(["properties.tabColorStyle", "properties.title"]);
  });
});

describe("pruneUndefined", () => {
  test("drops undefined so the body matches the mask", () => {
    expect(pruneUndefined({ a: 1, b: undefined, c: { d: undefined, e: 2 } })).toEqual({
      a: 1,
      c: { e: 2 },
    });
  });

  test("keeps null, which is a deliberate clear", () => {
    expect(pruneUndefined({ a: null })).toEqual({ a: null });
  });

  test("walks arrays", () => {
    expect(pruneUndefined({ rows: [{ a: 1, b: undefined }] })).toEqual({ rows: [{ a: 1 }] });
  });
});
