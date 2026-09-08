#!/usr/bin/env node
// PreToolUse on any sheets_* tool: inject the card once per session.
//
// This is the carrier that works everywhere. The skill only loads when the
// model decides the request is spreadsheet shaped, and a server's own
// `instructions` field is capped, unverified for stdio, and dropped entirely by
// some aggregators. A PreToolUse hook fires on the actual call, whatever the
// transport, so the rules land before the first write no matter how the model
// got there.
//
// The matcher in hooks.json keys on the `sheets_<tool>` suffix, so this fires
// for a bundled stdio server, a self-hosted HTTP server, and a Workspace
// connector alike.

import { readInput, readCard, readState, writeState, sheetsTool, emit } from "./state.mjs";

async function main() {
  const input = await readInput();

  const tool = sheetsTool(input.tool_name);
  if (!tool) emit(null);

  const state = readState(input.session_id);
  if (state.card_injected) emit(null);

  const card = readCard();
  if (!card) emit(null);

  // Record it before emitting. If the write fails, the card is injected again
  // on the next call: repetition costs tokens, silence costs correctness, and
  // this is the cheaper failure.
  writeState(input.session_id, { card_injected: true, source: "first-call" });

  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: [
        card,
        "",
        "---",
        "",
        "For a build, a restyle, or work in a spreadsheet other people edit,",
        "invoke the gsheets-pro skill for the full guide, the presets, and two",
        "worked examples.",
      ].join("\n"),
    },
  });
}

main().catch(() => process.exit(0));
