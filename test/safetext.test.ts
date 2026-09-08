/**
 * The colleague-safe check.
 *
 * The rules that matter here are the ones about what must NOT fire. A check
 * that flags the word "agent" on a recruiting sheet, or a sixteen digit
 * account number on a finance sheet, is a check somebody turns off, and a
 * check that is off protects nothing.
 */
import { describe, expect, test } from "vitest";

import {
  checkText,
  checkTexts,
  colleagueSafeApplies,
  describeFindings,
} from "../src/lib/safetext.js";

const at = (value: unknown) => checkText(value, "Tracker!D4");
const rules = (value: unknown) => at(value).map((f) => f.rule);

describe("what gets refused", () => {
  test("a Gmail style message id", () => {
    expect(rules("Confirmed, see <CAF=abc123@mail.gmail.com>")).toContain("message_id");
  });

  test("a long hex identifier", () => {
    expect(rules("per 18f2a1c9b4d0e77a")).toContain("message_id");
  });

  test("a task marker", () => {
    expect(rules("TODO: chase the background check")).toContain("todo_marker");
    expect(rules("Waiting on HR. FIXME: check with Hadeer")).toContain("todo_marker");
  });

  test("the sheet talking about the thing that wrote it", () => {
    expect(rules("Filled in by the agent")).toContain("agent_self_reference");
    expect(rules("agent run 3")).toContain("agent_self_reference");
    expect(rules("Automatically drafted from the email")).toContain("agent_self_reference");
  });

  test("run vocabulary", () => {
    expect(rules("See the run report")).toContain("run_report");
    expect(rules("Confirmed in the overnight run")).toContain("run_report");
  });

  test("a database table name", () => {
    expect(rules("logged to agent_draft_log")).toContain("internal_log_table");
  });

  test("every refusal carries a fix that says what to write instead", () => {
    for (const finding of at("TODO: ask the agent")) {
      expect(finding.fix.length).toBeGreaterThan(20);
    }
  });
});

describe("what must not be refused", () => {
  test("ordinary text a colleague would write", () => {
    expect(at("Confirmed with Hadeer on Friday, fingerprints still outstanding")).toEqual([]);
    expect(at("Thursday 3:15, Room 14")).toEqual([]);
    expect(at("$480 for the term")).toEqual([]);
  });

  test("a sixteen digit number, which is not a message id", () => {
    expect(rules("4111111111111111")).not.toContain("message_id");
  });

  test("the bare word agent, which a real sheet may legitimately hold", () => {
    expect(rules("Agent Hollis, Northfield Insurance")).not.toContain("agent_self_reference");
    expect(rules("agent")).not.toContain("agent_self_reference");
  });

  test("a date, which is not a machine timestamp", () => {
    expect(rules("2026-09-07")).not.toContain("bare_timestamp");
  });

  test("a single word in a status column", () => {
    expect(rules("Confirmed")).not.toContain("status_code");
  });

  test("anything that is not a string", () => {
    expect(checkText(42, "A1")).toEqual([]);
    expect(checkText(null, "A1")).toEqual([]);
    expect(checkText("   ", "A1")).toEqual([]);
  });
});

describe("the heuristic rules only warn", () => {
  test("a machine timestamp filling the whole cell", () => {
    const found = at("2026-09-07T03:00:15Z");
    expect(found.map((f) => f.rule)).toContain("bare_timestamp");
    expect(found.every((f) => f.severity === "warn")).toBe(true);
  });

  test("an internal status code filling the whole cell", () => {
    const found = at("sent_as_is");
    expect(found.map((f) => f.rule)).toContain("status_code");
    expect(found.find((f) => f.rule === "status_code")?.severity).toBe("warn");
  });

  test("a status code inside a sentence is left alone", () => {
    expect(rules("The status was sent_as_is when we checked")).not.toContain("status_code");
  });
});

describe("the allowlist", () => {
  test("silences a rule this sheet legitimately triggers", () => {
    const found = checkText("Filled in by the agent", "A1", { allowlist: ["the agent"] });
    expect(found.map((f) => f.rule)).not.toContain("agent_self_reference");
  });

  test("a broader allowlist entry covers a narrower match", () => {
    const found = checkText("agent run 3", "A1", { allowlist: ["agent run 3 of the pilot"] });
    expect(found).toEqual([]);
  });

  test("an empty allowlist entry silences nothing", () => {
    expect(checkText("TODO: chase this", "A1", { allowlist: ["", "  "] })).toHaveLength(1);
  });
});

describe("scope", () => {
  test("the check applies to a human or shared sheet", () => {
    expect(colleagueSafeApplies({ owner: "human" })).toBe(true);
    expect(colleagueSafeApplies({ owner: "shared" })).toBe(true);
    expect(colleagueSafeApplies({ owner: "agent" })).toBe(false);
    expect(colleagueSafeApplies(undefined)).toBe(false);
  });

  test("and to any sheet that asks for it explicitly", () => {
    expect(colleagueSafeApplies({ owner: "agent", colleagueSafeText: true })).toBe(true);
  });

  test("a batch keeps every location", () => {
    const found = checkTexts([
      { location: "Tracker!A2", value: "TODO: one" },
      { location: "Tracker!A3", value: "fine" },
      { location: "Tracker!A4", value: "the agent said so" },
    ]);
    expect(found.map((f) => f.location)).toEqual(["Tracker!A2", "Tracker!A4"]);
  });

  test("the summary names the cells and stops counting at the limit", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      location: `Tracker!A${i + 2}`,
      value: "TODO: chase",
    }));
    const text = describeFindings(checkTexts(many), 3);
    expect(text).toContain("Tracker!A2");
    expect(text).toContain("And 6 more");
  });
});
