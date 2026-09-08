#!/usr/bin/env node
// SessionStart: inject the card up front in a repository that already knows
// about specific spreadsheets.
//
// The signal is `.claude/gsheets-pro.json`, the registry. A repository that has
// one is a repository where spreadsheet work is routine and some of those
// spreadsheets belong to other people, so the rules are worth the tokens before
// the first prompt rather than after the first call. Everywhere else this hook
// stays quiet and first-call.mjs carries the card instead.
//
// Injecting here also tells the model which spreadsheets are protected and why,
// which is the part that cannot be recovered later from a refusal message
// alone.

import { readInput, readCard, readRegistry, writeState, emit } from "./state.mjs";

const PROTECTED_OWNERS = new Set(["human", "shared"]);

function describeRegistry(registry) {
  const entries = Object.entries(registry);
  if (entries.length === 0) return null;

  const lines = [];
  for (const [id, entry] of entries) {
    const name = entry?.name ?? "unnamed spreadsheet";
    const owner = entry?.owner ?? "unknown owner";
    const parts = [`- ${name} (${owner})`];

    if (Array.isArray(entry?.writable_columns) && entry.writable_columns.length > 0) {
      parts.push(`writable columns ${entry.writable_columns.join(", ")}`);
    } else if (PROTECTED_OWNERS.has(owner)) {
      parts.push("no writable columns declared, so treat every column as someone else's");
    }
    if (entry?.positional_rows) {
      parts.push("row order is load bearing, so no sorting, inserting, or deleting rows");
    }
    if (entry?.colleague_safe_text) {
      parts.push("text here is read by colleagues");
    }
    lines.push(`${parts.join(". ")}.`);
    lines.push(`  id ${id}`);
  }

  return [
    "This repository registers spreadsheets with gsheets-pro. The tools enforce these,",
    "and a refusal on one of them is the design working, not a bug to route around:",
    "",
    ...lines,
  ].join("\n");
}

async function main() {
  const input = await readInput();
  const registry = readRegistry(input.cwd);
  const summary = describeRegistry(registry);

  // No registry means no reason to spend the tokens here.
  if (!summary) emit(null);

  const card = readCard();
  const context = card ? `${card}\n\n---\n\n${summary}` : summary;

  // Tell first-call.mjs the card is already in context. If this write fails the
  // card gets injected a second time on the first spreadsheet call, which is a
  // token cost rather than a correctness problem.
  writeState(input.session_id, { card_injected: Boolean(card), source: "session-start" });

  emit({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  });
}

main().catch(() => process.exit(0));
