#!/usr/bin/env node
// PostToolUse on the writing tools: two nudges, each fired at most once.
//
// Every gsheets-pro write returns a `check`, the recalculation-shaped error
// gate over the cells it touched. The failure mode this hook exists for is the
// familiar one: a model reads "wrote 40 cells", counts that as success, and
// keeps building on top of a #REF. So when a write comes back with errors, this
// puts them back in front of the model next to the tool result.
//
// The second nudge is for a session that writes and writes and never runs the
// lint. There is no Stop hook here on purpose. A Stop hook that blocks is a
// loop risk, and the honest place for this reminder is mid-build, while fixing
// is still cheap, rather than at the end when the model has already written its
// summary.

import { readInput, readState, writeState, sheetsTool, emit } from "./state.mjs";

const WRITE_TOOLS = new Set([
  "sheets_write",
  "sheets_table",
  "sheets_settings",
  "sheets_style",
  "sheets_validation",
  "sheets_conditional_format",
  "sheets_structure",
  "sheets_batch",
]);

// After this many writes with no lint, say something. Low enough to catch a
// build going sideways, high enough that a one-call fix is left alone.
const UNCHECKED_WRITE_THRESHOLD = 4;

/**
 * Find the error gate in the tool response.
 *
 * Two shapes carry a status, and both are read here. A write nests its gate
 * under `check`, with `error_summary` as counts keyed on the error type.
 * `sheets_check` puts the same fields at the top level of its own response and
 * gives each entry a `count` and a list of `locations`. `describeErrors` below
 * handles either form, which is what lets one function serve both.
 *
 * The structured fields are the contract; the text scan is a fallback for a
 * transport that flattens the response to prose on the way through.
 */
function readGate(toolResponse) {
  if (!toolResponse) return null;

  const structured =
    toolResponse.structuredContent?.check ??
    toolResponse.check ??
    toolResponse.structuredContent?.result?.check ??
    // sheets_check reports on the whole spreadsheet rather than on one write,
    // so its status sits at the top level with no `check` wrapper.
    (toolResponse.structuredContent?.status ? toolResponse.structuredContent : null);

  if (structured?.status) return structured;

  const text = Array.isArray(toolResponse.content)
    ? toolResponse.content
        .filter((block) => block?.type === "text")
        .map((block) => block.text)
        .join("\n")
    : typeof toolResponse === "string"
      ? toolResponse
      : "";

  if (text.includes("errors_found")) return { status: "errors_found" };
  if (text.includes('"status": "pending"') || text.includes("status: pending")) {
    return { status: "pending" };
  }
  return null;
}

function describeErrors(gate) {
  const summary = gate?.error_summary;
  if (!summary || typeof summary !== "object") return "";

  const parts = [];
  for (const [type, detail] of Object.entries(summary)) {
    const count = detail?.count ?? detail;
    const where = Array.isArray(detail?.locations) ? detail.locations.slice(0, 3).join(", ") : null;
    parts.push(where ? `${type} x${count} at ${where}` : `${type} x${count}`);
  }
  return parts.length > 0 ? ` ${parts.join("; ")}.` : "";
}

async function main() {
  const input = await readInput();

  const tool = sheetsTool(input.tool_name);
  if (!tool) emit(null);

  const state = readState(input.session_id);

  if (tool === "sheets_check") {
    const report = readGate(input.tool_response);
    writeState(input.session_id, { checked: true });

    // The lint having run is not the lint having passed, and a model that reads
    // "tool call succeeded" and moves on is the exact failure this whole hook
    // exists for. So an errors_found report goes back in front of it, with the
    // error types and the first few addresses.
    if (report?.status === "errors_found") {
      emit({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext:
            `sheets_check came back errors_found.${describeErrors(report)} ` +
            `That is a stop, not a warning. Fix those cells and run sheets_check again ` +
            `before doing anything else with this spreadsheet.`,
        },
      });
    }
    emit(null);
  }

  if (!WRITE_TOOLS.has(tool)) emit(null);

  const writes = (state.writes ?? 0) + 1;
  const gate = readGate(input.tool_response);

  if (gate?.status === "errors_found") {
    writeState(input.session_id, { writes, checked: false });
    emit({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          `That write came back with errors_found.${describeErrors(gate)} ` +
          `Fix those cells before writing anything else. A formula error compounds: ` +
          `every later cell that reads a broken one inherits the error, and the final ` +
          `sheets_check will report a cascade instead of the one cell that caused it.`,
      },
    });
  }

  const shouldNudge =
    !state.checked && !state.lint_nudged && writes >= UNCHECKED_WRITE_THRESHOLD;

  writeState(input.session_id, { writes, lint_nudged: state.lint_nudged || shouldNudge });

  if (shouldNudge) {
    emit({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          `${writes} writes into this spreadsheet so far and no sheets_check yet. ` +
          `Run it now rather than at the end. It catches the errors a per-write gate ` +
          `misses, including merges inside a data region, a formula column that stopped ` +
          `being consistent, a missing frozen header, and text that reads as machine ` +
          `output to whoever opens the sheet.`,
      },
    });
  }

  emit(null);
}

main().catch(() => process.exit(0));
