/**
 * What this process has written, so the lint can ask where the writes landed.
 *
 * One lint rule (L14) is about history rather than about the current state of
 * the spreadsheet: a value sitting in a human's column is not evidence of
 * anything, because the human probably typed it. What matters is whether *we*
 * put it there. Nothing in the sheet records that, so the server keeps a small
 * ledger of its own.
 *
 * It lives at module scope for the same reason the Google client does: in HTTP
 * mode the SDK builds a fresh transport and McpServer per request, but the
 * module stays loaded, so the ledger survives across the calls of one session.
 * It is deliberately not durable. A ledger written to disk would outlive the
 * session it describes and start reporting last week's writes as this session's,
 * which is worse than having none.
 *
 * The ring is small and time bounded. A finding about a write from two hours
 * ago is not actionable, and holding every range of a long build costs memory
 * for no benefit.
 */

import { splitSheetRange } from "./a1.js";
import type { WriteRecord } from "./lint/types.js";

/** How many writes the ledger remembers before dropping the oldest. */
export const MAX_WRITES_REMEMBERED = 250;

/** Writes older than this are not worth reporting on. Two hours. */
export const WRITE_MEMORY_MS = 2 * 60 * 60 * 1000;

interface StoredWrite extends WriteRecord {
  spreadsheetId: string;
}

let ledger: StoredWrite[] = [];

export interface RecordWriteInput {
  spreadsheetId: string;
  /** Fully qualified A1 where possible, for example "'Roster'!D2:D40". */
  range: string;
  /** The tab, when the caller knows it and the range does not carry it. */
  sheet?: string;
  tool?: string;
  /** Injectable for tests. */
  at?: number;
}

/**
 * Record one written range. Called by the writing tools; safe to call with a
 * range that names its own tab, a bare range plus a sheet, or either alone.
 */
export function recordWrite(input: RecordWriteInput): void {
  const range = String(input.range ?? "").trim();
  if (!input.spreadsheetId || !range) return;

  let sheet = input.sheet;
  try {
    const split = splitSheetRange(range);
    if (split.sheet) sheet = split.sheet;
  } catch {
    // A range we cannot split is still worth remembering by its text.
  }

  const entry: StoredWrite = {
    spreadsheetId: input.spreadsheetId,
    range,
    at: input.at ?? Date.now(),
  };
  if (sheet) entry.sheet = sheet;
  if (input.tool) entry.tool = input.tool;

  ledger.push(entry);
  if (ledger.length > MAX_WRITES_REMEMBERED) {
    ledger = ledger.slice(ledger.length - MAX_WRITES_REMEMBERED);
  }
}

export interface WritesForOptions {
  sheet?: string;
  /** Ignore writes older than this many milliseconds. Default two hours. */
  withinMs?: number;
  /** Injectable for tests. */
  now?: number;
}

/** The writes this process made to one spreadsheet, newest last. */
export function writesFor(spreadsheetId: string, options: WritesForOptions = {}): WriteRecord[] {
  const now = options.now ?? Date.now();
  const within = options.withinMs ?? WRITE_MEMORY_MS;
  const wanted = options.sheet?.trim().toLowerCase();

  return ledger
    .filter((entry) => entry.spreadsheetId === spreadsheetId)
    .filter((entry) => now - entry.at <= within)
    .filter((entry) => !wanted || (entry.sheet ?? "").trim().toLowerCase() === wanted)
    .map(({ spreadsheetId: _id, ...rest }) => rest);
}

/** Forget everything. For tests, and for `doctor`. */
export function clearWrites(): void {
  ledger = [];
}

/** How many writes are remembered right now, for the tool's own prose. */
export function writeCount(): number {
  return ledger.length;
}
