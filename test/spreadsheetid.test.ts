/**
 * Spreadsheet ids and the URLs people paste instead of them.
 * Every id here is invented.
 */
import { describe, expect, test } from "vitest";

import { looksLikeUrl, resolveSpreadsheetId } from "../src/lib/spreadsheetid.js";

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-x";

describe("resolveSpreadsheetId", () => {
  test("a bare id passes through", () => {
    expect(resolveSpreadsheetId(ID)).toBe(ID);
    expect(resolveSpreadsheetId(`  ${ID}  `)).toBe(ID);
  });

  test("the URL a person copies out of the address bar", () => {
    expect(resolveSpreadsheetId(`https://docs.google.com/spreadsheets/d/${ID}/edit`)).toBe(ID);
  });

  test("with a tab fragment and a query", () => {
    expect(
      resolveSpreadsheetId(`https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing#gid=1874`),
    ).toBe(ID);
  });

  test("a Drive file link", () => {
    expect(resolveSpreadsheetId(`https://drive.google.com/file/d/${ID}/view`)).toBe(ID);
  });

  test("the older ?id= form", () => {
    expect(resolveSpreadsheetId(`https://docs.google.com/spreadsheets?id=${ID}`)).toBe(ID);
  });

  test("an empty argument says what to pass", () => {
    try {
      resolveSpreadsheetId("");
      throw new Error("should have refused");
    } catch (error) {
      expect((error as { hint?: string }).hint).toContain("paste the whole URL");
    }
  });

  test("a URL with no spreadsheet in it says so specifically", () => {
    try {
      resolveSpreadsheetId("https://drive.google.com/drive/folders/abc");
      throw new Error("should have refused");
    } catch (error) {
      expect((error as Error).message).toContain("No spreadsheet id");
      expect((error as { hint?: string }).hint).toContain("/spreadsheets/d/");
    }
  });

  test("a tab name is refused, and the refusal says where tab names go", () => {
    try {
      resolveSpreadsheetId("Tracker");
      throw new Error("should have refused");
    } catch (error) {
      expect((error as { hint?: string }).hint).toContain("sheet argument");
    }
  });

  test("looksLikeUrl is not fooled by a long id", () => {
    expect(looksLikeUrl(ID)).toBe(false);
    expect(looksLikeUrl("https://docs.google.com/x")).toBe(true);
  });
});
