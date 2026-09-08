#!/usr/bin/env node
// PreToolUse: stop a call that could damage a spreadsheet somebody else owns.
//
// The server already refuses the clearest cases on its own, with a `confirm`
// string and a formula guard. This hook covers what the server cannot see: the
// repository registry, which marks known spreadsheets as human owned, shared,
// or row-order sensitive without any metadata being written into the sheet.
// That is what lets a fresh clone in a cloud session refuse a write into a
// colleague's columns on the very first call.
//
// The hook decides between asking and denying by working out whether anybody
// is there to answer, which `isUnattended` in state.mjs does from the
// environment rather than from `permission_mode`. When a person is present,
// asking is right: they know things the registry does not. When nobody is, an
// ask stalls the run, so the answer is a denial that explains itself and
// carries the card, making the retry an informed one rather than the same call
// again.

import {
  readInput,
  readCard,
  readRegistry,
  registryEntryFor,
  sheetsTool,
  isUnattended,
  emit,
} from "./state.mjs";

const PROTECTED_OWNERS = new Set(["human", "shared"]);

// Structural actions that change what is already in a sheet, as opposed to
// adding to it. These are the ones a colleague notices.
const DESTRUCTIVE_ACTIONS = new Set([
  "delete_tab",
  "delete_sheet",
  "delete_rows",
  "delete_columns",
  "move_rows",
  "move_columns",
  "move_tab",
  "sort",
  "find_replace",
  "dedupe",
  "trim",
  "unprotect",
  "rename_tab",
]);

// Structural actions that reorder or renumber rows. On a spreadsheet whose rows
// are referenced by position, these break other people's formulas and printed
// copies, so they are refused rather than asked about.
const ROW_ORDER_ACTIONS = new Set([
  "sort",
  "delete_rows",
  "insert_rows",
  "move_rows",
  "dedupe",
]);

// The sheets_style arguments that change how a spreadsheet looks for everyone
// rather than adding to one range. There is no separate `theme` argument: a
// preset with no range is what writes the workbook theme.
const RESTYLE_KEYS = ["preset", "banding", "clear"];

/**
 * Decide whether this call needs a human in the loop.
 * Returns a sentence naming the sheet and the specific concern, or null.
 */
function assess(tool, input, entry) {
  const sheetName = entry?.name ?? "this spreadsheet";
  const owner = entry?.owner;
  const isProtected = PROTECTED_OWNERS.has(owner);
  const action = input?.action;

  if (tool === "sheets_structure") {
    if (entry?.positional_rows && ROW_ORDER_ACTIONS.has(action)) {
      return (
        `"${action}" would change the row order of ${sheetName}, and the registry marks ` +
        `its row order as load bearing. Other people's formulas and printed copies point ` +
        `at those row numbers. Append at the bottom instead, and leave existing rows where ` +
        `they are.`
      );
    }
    if (DESTRUCTIVE_ACTIONS.has(action)) {
      return isProtected
        ? `"${action}" changes existing structure in ${sheetName}, which the registry marks as ${owner} owned.`
        : `"${action}" removes or reorders existing structure. Confirm this is what was asked for.`;
    }
    return null;
  }

  if (!isProtected) return null;

  if (tool === "sheets_style" && RESTYLE_KEYS.some((key) => input?.[key] !== undefined)) {
    return (
      `This restyles ${sheetName}, which the registry marks as ${owner} owned. ` +
      `Applying a theme or banding to somebody else's spreadsheet changes how every ` +
      `tab looks, including the parts nobody asked about.`
    );
  }

  if (tool === "sheets_table" && (input?.action === "create" || input?.action === "delete")) {
    return (
      `Converting a range in ${sheetName} to a native Table, or removing one, restructures ` +
      `a spreadsheet the registry marks as ${owner} owned. It changes filters, banding, and ` +
      `how existing formulas address the range.`
    );
  }

  if (tool === "sheets_write" && input?.force === true) {
    return (
      `This write passes force, which overrides the formula guard and the writable-column ` +
      `contract on ${sheetName}. Something in the target range is a formula or a column ` +
      `somebody else owns.`
    );
  }

  if (tool === "sheets_batch") {
    return (
      `sheets_batch sends raw requests to ${sheetName}, which the registry marks as ${owner} ` +
      `owned. The escape hatch skips the checks the named tools apply, so nothing here is ` +
      `verifying which columns are yours.`
    );
  }

  if (tool === "sheets_validation" && input?.force === true) {
    return (
      `Rewriting a validation rule in ${sheetName} with force discards any chip colors set ` +
      `in the Sheets interface. The API cannot read those back, so they cannot be restored.`
    );
  }

  return null;
}

async function main() {
  const input = await readInput();

  const tool = sheetsTool(input.tool_name);
  if (!tool) emit(null);

  const registry = readRegistry(input.cwd);
  const entry = registryEntryFor(registry, input.tool_input);
  const concern = assess(tool, input.tool_input ?? {}, entry);
  if (!concern) emit(null);

  const unattended = isUnattended(input);
  const decision = unattended ? "deny" : "ask";

  const reason = [concern];

  if (unattended) {
    // A deny reason reaches the model as the tool's error text, so this is
    // read, not discarded. Say what to do instead, then attach the card, since
    // an unattended run may not have loaded the skill.
    reason.push(
      "",
      "Nobody is watching this run, so this is a denial rather than a question. " +
        "Do not retry it. Either take the narrower action that leaves what somebody " +
        "else owns alone, or finish the rest of the work and say plainly in your " +
        "summary what you did not do and why, so a person can run it themselves.",
    );
    const card = readCard();
    if (card) reason.push("", "---", "", card);
  } else {
    reason.push("", "Confirm before this runs.");
  }

  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason.join("\n"),
    },
  });
}

main().catch(() => process.exit(0));
