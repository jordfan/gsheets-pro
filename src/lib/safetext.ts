/**
 * Text in a shared spreadsheet reads as a colleague wrote it.
 *
 * Somebody opens a shared sheet with no idea an agent touched it. A cell
 * reading "TODO: confirm per 18f2a1c9b4d0e77a" or "agent run 2026-09-07T03:00"
 * tells them nothing and makes the sheet look like a log file. So every string
 * a write puts into a spreadsheet whose owner is a person, or which the
 * registry marks as shared, goes past this first.
 *
 * The rules match on patterns, not on bare words. A spreadsheet tracking
 * software work will legitimately contain "agent", and a recruiting sheet will
 * legitimately contain "TODO" in a column of its own. Matching the bare word
 * would make the check something people turn off, and a check that gets turned
 * off protects nothing. Each pattern here needs a shape that a colleague would
 * not have typed, and a sheet can carry its own allowlist in the registry.
 *
 * Two severities. `refuse` blocks the write and names the cell, because the
 * pattern is unambiguous. `warn` is reported and written, because the pattern
 * is a heuristic and a false positive would be worse than the miss.
 */

export type SafeTextSeverity = "refuse" | "warn";

export interface SafeTextRule {
  id: string;
  severity: SafeTextSeverity;
  pattern: RegExp;
  /** What a colleague would have written instead. */
  fix: string;
  /** Only applied when the whole cell matches, not to a substring. */
  wholeCellOnly?: boolean;
}

/**
 * Every rule is anchored on a shape rather than a vocabulary word.
 */
export const SAFE_TEXT_RULES: readonly SafeTextRule[] = [
  {
    id: "message_id",
    severity: "refuse",
    // The hex clause requires at least one letter, so a sixteen digit account
    // number in a finance sheet is not mistaken for a message id.
    pattern:
      /<[^\s<>]+@[^\s<>]+>|\b(?:msg|message|thread|draft)[\s._-]?id\b|\b(?=[0-9a-f]{16,}\b)[0-9a-f]*[a-f][0-9a-f]*\b/i,
    fix: "Drop the identifier. Say who wrote and when in ordinary words, or leave the cell as the fact itself.",
  },
  {
    id: "todo_marker",
    severity: "refuse",
    pattern: /(^|\s)(TODO|FIXME|QUESTION|NOTE TO SELF)\s*:/,
    fix: "A shared sheet is not a task list for one person. Either write the actual status in the cell, or keep the task somewhere it belongs to you.",
  },
  {
    id: "agent_self_reference",
    severity: "refuse",
    pattern:
      /\b(?:the|this|an?|my|our)\s+agent\b|\bagent[\s_-](?:run|log|draft|note|report|session|state)\b|\b(?:auto|automatically)[- ]?(?:drafted|generated|written)\b|\bdrafted by\b/i,
    fix: "Write it as the fact rather than as a note about how the fact got here. Nobody reading the sheet needs to know what wrote the row.",
  },
  {
    id: "run_report",
    severity: "refuse",
    pattern:
      /\brun report\b|\b(?:scheduled|overnight|morning|afternoon|nightly)\s+run\b|\bper (?:the|last night's) run\b/i,
    fix: "Name the day and what happened, the way a colleague would in a status column.",
  },
  {
    id: "internal_log_table",
    severity: "refuse",
    pattern: /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)*_(?:log|table|row|record)\b/i,
    fix: "That is a name from a database, not from this spreadsheet. Say what the row means here.",
  },
  {
    id: "bare_timestamp",
    severity: "warn",
    pattern: /^\s*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?\s*$/,
    fix: "A date column wants a date. If the time genuinely matters, format the cell as a date and time rather than storing a machine timestamp as text.",
    wholeCellOnly: true,
  },
  {
    id: "status_code",
    severity: "warn",
    pattern: /^\s*(?:[a-z]+(?:_[a-z0-9]+)+|[A-Z]+(?:_[A-Z0-9]+)+)\s*$/,
    fix: "Status columns read better with real words. Write \"Sent as written\" rather than an internal code.",
    wholeCellOnly: true,
  },
];

export interface SafeTextFinding {
  /** Where the string was going, for example "Tracker!D14". */
  location: string;
  rule: string;
  severity: SafeTextSeverity;
  /** The exact text that matched, so the fix is unambiguous. */
  matched: string;
  value: string;
  fix: string;
}

export interface SafeTextOptions {
  /** Phrases legitimate on this sheet, from the registry entry. */
  allowlist?: string[];
}

/**
 * An allowlist entry silences a match when the two overlap in either
 * direction: "Agent Report" in the allowlist covers a match on "agent report",
 * and an allowlist of "agent" covers every match containing it. The looser
 * reading is deliberate. Somebody writing an allowlist is telling us this
 * vocabulary is normal here, and second-guessing that produces exactly the
 * nagging that gets a check disabled.
 */
function allowed(matched: string, allowlist: string[]): boolean {
  const needle = matched.trim().toLowerCase();
  if (!needle) return true;
  return allowlist.some((raw) => {
    const entry = String(raw ?? "").trim().toLowerCase();
    if (!entry) return false;
    return needle.includes(entry) || entry.includes(needle);
  });
}

/** Check one string. Pure, so the lint and the write gate share it. */
export function checkText(
  value: unknown,
  location: string,
  options: SafeTextOptions = {},
): SafeTextFinding[] {
  if (typeof value !== "string") return [];
  const text = value;
  if (!text.trim()) return [];
  const allowlist = options.allowlist ?? [];
  const out: SafeTextFinding[] = [];

  for (const rule of SAFE_TEXT_RULES) {
    // A whole cell rule is anchored, so it is tested against the trimmed value
    // rather than against a cell that happens to carry trailing spaces.
    const match = rule.pattern.exec(rule.wholeCellOnly ? text.trim() : text);
    if (!match) continue;
    const matched = (match[0] ?? "").trim();
    if (allowed(matched, allowlist)) continue;
    out.push({
      location,
      rule: rule.id,
      severity: rule.severity,
      matched,
      value: text,
      fix: rule.fix,
    });
  }
  return out;
}

export interface SafeTextTarget {
  location: string;
  value: unknown;
}

/** Check a batch of cells, returning findings in the order they were given. */
export function checkTexts(
  targets: SafeTextTarget[],
  options: SafeTextOptions = {},
): SafeTextFinding[] {
  return targets.flatMap((t) => checkText(t.value, t.location, options));
}

/** True when this sheet's text is read by people other than whoever wrote it. */
export function colleagueSafeApplies(policy: {
  owner?: string;
  colleagueSafeText?: boolean;
} | undefined): boolean {
  if (!policy) return false;
  if (policy.colleagueSafeText === true) return true;
  return policy.owner === "human" || policy.owner === "shared";
}

/** One sentence naming what has to change, for a refusal message. */
export function describeFindings(findings: SafeTextFinding[], limit = 5): string {
  const shown = findings.slice(0, limit);
  const parts = shown.map((f) => `${f.location} contains "${f.matched}" (${f.rule}). ${f.fix}`);
  if (findings.length > shown.length) {
    parts.push(`And ${findings.length - shown.length} more like these.`);
  }
  return parts.join(" ");
}
