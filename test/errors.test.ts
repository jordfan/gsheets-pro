/**
 * Structured errors and their hints.
 *
 * The hints are the product here, so they are asserted rather than assumed.
 */
import { describe, expect, test } from "vitest";

import {
  apiErrorMessage,
  apiErrorStatus,
  err,
  ERROR_CODES,
  errorToText,
  GsheetsError,
  toStructuredError,
} from "../src/lib/errors.js";

function apiError(status: number, message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), {
    response: { status, data: { error: { message, code: status } } },
    ...extra,
  });
}

describe("toStructuredError", () => {
  test("a 404 blames the whole URL, which is what it almost always is", () => {
    const e = toStructuredError(apiError(404, "Requested entity was not found."));
    expect(e.code).toBe("not_found");
    expect(e.hint).toMatch(/long id in the middle of the sheet's URL/);
  });

  test("a 403 separates a quota problem from an access problem", () => {
    expect(toStructuredError(apiError(403, "Quota exceeded for quota metric")).code).toBe(
      "quota_exceeded",
    );
    expect(toStructuredError(apiError(403, "The caller does not have permission")).code).toBe(
      "permission_denied",
    );
  });

  test("a 401 names the seven day Testing expiry", () => {
    const e = toStructuredError(apiError(401, "Request had invalid authentication credentials."));
    expect(e.code).toBe("unauthenticated");
    expect(e.hint).toMatch(/seven days/);
  });

  test("a 429 says the retries are already spent", () => {
    const e = toStructuredError(apiError(429, "Too many requests"));
    expect(e.code).toBe("rate_limited");
    expect(e.hint).toMatch(/already retried/);
  });

  test("a 400 points at the range and the tab name", () => {
    expect(toStructuredError(apiError(400, "Unable to parse range")).code).toBe("invalid_argument");
  });

  test("a refused token refresh is an auth problem, not a range problem", () => {
    // This arrives as a 400 from the OAuth endpoint. Falling through to the
    // generic 400 branch would tell the reader to check their A1 ranges.
    const e = toStructuredError(
      apiError(400, '{"error":"invalid_grant","error_description":"reauth related error (invalid_rapt)"}'),
    );
    expect(e.code).toBe("auth_expired");
    expect(e.hint).toMatch(/gcloud auth application-default login/);
    expect(e.hint).not.toMatch(/A1 ranges/);
  });

  test("a revoked refresh token names the seven day Testing expiry", () => {
    const e = toStructuredError(apiError(400, '{"error":"invalid_grant"}'));
    expect(e.code).toBe("auth_expired");
    expect(e.hint).toMatch(/seven days/);
  });

  test("a 500 is called transient", () => {
    const e = toStructuredError(apiError(503, "backend error"));
    expect(e.code).toBe("unavailable");
    expect(e.hint).toMatch(/try the same call again/);
  });

  test("an ordinary Error becomes internal, not a mystery", () => {
    const e = toStructuredError(new Error("something broke"));
    expect(e.code).toBe("internal");
    expect(e.message).toBe("something broke");
  });

  test("a GsheetsError passes through with its own hint", () => {
    const original = new GsheetsError("formula_guard", "B4 holds a formula.", "Pass force.");
    expect(toStructuredError(original)).toEqual({
      code: "formula_guard",
      message: "B4 holds a formula.",
      hint: "Pass force.",
    });
  });

  test("a status only in the data payload is still found", () => {
    const bare = { response: { data: { error: { code: 404, message: "not found" } } } };
    expect(apiErrorStatus(bare)).toBe(404);
    expect(toStructuredError(bare).code).toBe("not_found");
  });

  test("the API message is preferred over the wrapper's", () => {
    const wrapped = Object.assign(new Error("Request failed"), {
      response: { status: 400, data: { error: { message: "Unable to parse range: Sheet1!ZZ" } } },
    });
    expect(apiErrorMessage(wrapped)).toBe("Unable to parse range: Sheet1!ZZ");
  });

  test("every code in the enum is a valid ErrorCode", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });
});

describe("the hand raised errors", () => {
  test("a bad range teaches the four A1 shapes", () => {
    const e = err.badRange("banana").toStructured();
    expect(e.code).toBe("bad_range");
    expect(e.hint).toMatch(/whole column/);
  });

  test("a missing tab lists the tabs that exist", () => {
    const e = err.sheetNotFound("Trackr", ["Tracker", "Notes"]).toStructured();
    expect(e.code).toBe("sheet_not_found");
    expect(e.hint).toMatch(/Tracker, Notes/);
    expect(e.details).toEqual({ available: ["Tracker", "Notes"] });
  });

  test("a spreadsheet with no readable tabs says so instead of listing nothing", () => {
    expect(err.sheetNotFound("Tracker", []).hint).toMatch(/no readable tabs/);
  });

  test("missing auth names both paths", () => {
    expect(err.authMissing("no token").hint).toMatch(/gsheets-pro auth/);
  });
});

describe("errorToText", () => {
  test("puts the hint on its own paragraph", () => {
    const text = errorToText({ code: "not_found", message: "Gone.", hint: "Check the id." });
    expect(text).toBe("Error (not_found): Gone.\n\nCheck the id.");
  });

  test("omits the paragraph when there is no hint", () => {
    expect(errorToText({ code: "internal", message: "Gone." })).toBe("Error (internal): Gone.");
  });
});
