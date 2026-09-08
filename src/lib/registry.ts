/**
 * The repo registry: `.claude/gsheets-pro.json`.
 *
 * A spreadsheet shared with colleagues needs protecting whether or not anyone
 * ever ran a plugin tool against it. Developer metadata cannot help there,
 * because a sheet a person built by hand carries none at all. So the registry
 * is the contract that needs nothing from the sheet itself. A repo names the
 * spreadsheets its agents touch, says who owns each one and which columns are
 * ours to write, and every client and every cloud session that opens the repo
 * honours it.
 *
 * Metadata written by the plugin does survive `drive.files.copy` (spike 5), so
 * a duplicated sheet keeps its contract. The registry exists for the sheets
 * that never had one.
 *
 * The file is found by walking up from the working directory, so it applies to
 * the whole repo rather than only to the directory a command happened to run in.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { columnLetterToIndex, parseColumnSpan, type Span } from "./a1.js";
import { GsheetsError } from "./errors.js";

export const REGISTRY_FILENAME = "gsheets-pro.json";
export const REGISTRY_RELATIVE_PATH = path.join(".claude", REGISTRY_FILENAME);

export type Owner = "human" | "shared" | "agent";

const policyShape = {
  owner: z.enum(["human", "shared", "agent"]).optional(),
  /**
   * Nothing here is ours to change. Every writing tool refuses without force.
   *
   * This is not the same statement as an empty `writable_columns`, and that is
   * why it exists: an absent or empty list reads as "no restriction stated",
   * so a reference sheet of term dates, or a finished historical tab, had no
   * way to say "never write here" at all. `read_only` says it in one word and
   * does not depend on knowing the columns.
   */
  read_only: z.boolean().optional(),
  /**
   * Columns the plugin may write. Each entry is a column letter or span
   * ("A", "B:D") or a header name matched without regard to case. Absent means
   * every column is writable.
   */
  writable_columns: z.array(z.string().min(1)).optional(),
  /** Rows are referred to by position elsewhere, so never sort, insert, or delete. */
  positional_rows: z.boolean().optional(),
  /** Text written here is read by colleagues, so the colleague safe lint applies. */
  colleague_safe_text: z.boolean().optional(),
  /** Phrases the colleague safe lint should not flag on this sheet. */
  allowlist: z.array(z.string()).optional(),
  /**
   * The preset this spreadsheet is styled with. A repo that says so here means
   * a styling call does not have to be told, and a colleague's sheet keeps the
   * palette it already has rather than acquiring ours.
   */
  preset: z.string().optional(),
  /** `tracker` or `model`, when the repo knows which this spreadsheet is. */
  archetype: z.enum(["tracker", "model"]).optional(),
  /** Free text shown in `sheets_open`, for example who maintains the sheet. */
  note: z.string().optional(),
};

const sheetPolicySchema = z.object(policyShape).strict();

const spreadsheetEntrySchema = z
  .object({
    ...policyShape,
    name: z.string().optional(),
    /** Per tab overrides, keyed by tab name. */
    sheets: z.record(z.string(), sheetPolicySchema).optional(),
  })
  .strict();

export const registrySchema = z
  .object({
    $schema: z.string().optional(),
    version: z.number().int().positive().optional(),
    /** Applied to every spreadsheet in this registry unless overridden. */
    defaults: z.object(policyShape).strict().optional(),
    spreadsheets: z.record(z.string().min(1), spreadsheetEntrySchema).default({}),
  })
  .strict();

export type RegistryFile = z.infer<typeof registrySchema>;
export type SpreadsheetEntry = z.infer<typeof spreadsheetEntrySchema>;
export type SheetPolicyFile = z.infer<typeof sheetPolicySchema>;

/** A resolved policy: defaults, then the spreadsheet, then the tab. */
export interface Policy {
  source: "registry";
  path: string;
  spreadsheetId: string;
  name?: string;
  sheet?: string;
  owner: Owner;
  writableColumns?: string[];
  positionalRows: boolean;
  colleagueSafeText: boolean;
  /** Nothing on this sheet is ours to change. */
  readOnly: boolean;
  allowlist: string[];
  note?: string;
  /** The preset the repo says this spreadsheet uses, when it says. */
  preset?: string;
  archetype?: "tracker" | "model";
}

export interface Registry {
  /** Where the file was read from. */
  path: string;
  file: RegistryFile;
  /** Spreadsheet ids the registry knows about. */
  ids: string[];
  policyFor(spreadsheetId: string, sheet?: string): Policy | undefined;
}

// ---------------------------------------------------------------------------
// Finding and loading
// ---------------------------------------------------------------------------

/** Walk up from a directory looking for `.claude/gsheets-pro.json`. */
export function findRegistryPath(startDir: string = process.cwd()): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, REGISTRY_RELATIVE_PATH);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface LoadRegistryOptions {
  /** Read this exact file instead of searching. */
  file?: string;
  /** Where the upward search starts. Default `process.cwd()`. */
  cwd?: string;
  /** Consult `GSHEETS_PRO_REGISTRY`. Default true. */
  useEnv?: boolean;
}

/**
 * Load the registry, or undefined when the repo has none. A malformed file
 * throws rather than being ignored: silently dropping the protections on a
 * shared sheet is the one failure mode worth being loud about.
 */
export function loadRegistry(options: LoadRegistryOptions = {}): Registry | undefined {
  const fromEnv = options.useEnv === false ? undefined : process.env.GSHEETS_PRO_REGISTRY;
  const file = options.file ?? fromEnv ?? findRegistryPath(options.cwd);
  if (!file) return undefined;
  if (!fs.existsSync(file)) {
    if (options.file || fromEnv) {
      throw new GsheetsError(
        "invalid_argument",
        `No registry file at ${file}.`,
        "Point GSHEETS_PRO_REGISTRY at a readable file, or remove it to fall back to the repo's .claude/gsheets-pro.json.",
      );
    }
    return undefined;
  }
  return parseRegistry(fs.readFileSync(file, "utf8"), file);
}

/** Parse registry JSON that is already in hand. Exported for tests. */
export function parseRegistry(text: string, file = REGISTRY_RELATIVE_PATH): Registry {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new GsheetsError(
      "invalid_argument",
      `${file} is not valid JSON: ${(error as Error).message}`,
      "Fix the file, or delete it. A registry that cannot be read is treated as a hard error, because it is what protects shared sheets from being written to.",
    );
  }

  const parsed = registrySchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new GsheetsError(
      "invalid_argument",
      `${file} does not match the registry schema: ${issues}`,
      'Each entry under "spreadsheets" is keyed by spreadsheet id and may set owner, writable_columns, positional_rows, colleague_safe_text, allowlist, note, and per tab overrides under "sheets".',
    );
  }

  return buildRegistry(parsed.data, file);
}

function buildRegistry(fileData: RegistryFile, filePath: string): Registry {
  const ids = Object.keys(fileData.spreadsheets ?? {});
  return {
    path: filePath,
    file: fileData,
    ids,
    policyFor(spreadsheetId: string, sheet?: string): Policy | undefined {
      const entry = fileData.spreadsheets?.[spreadsheetId];
      if (!entry) return undefined;

      const tabPolicy = sheet ? findTabPolicy(entry, sheet) : undefined;
      const layered = [fileData.defaults, entry, tabPolicy].filter(Boolean) as SheetPolicyFile[];

      const pick = <K extends keyof SheetPolicyFile>(key: K): SheetPolicyFile[K] | undefined => {
        for (let i = layered.length - 1; i >= 0; i -= 1) {
          const value = layered[i][key];
          if (value !== undefined) return value;
        }
        return undefined;
      };

      const policy: Policy = {
        source: "registry",
        path: filePath,
        spreadsheetId,
        owner: (pick("owner") as Owner) ?? "shared",
        positionalRows: pick("positional_rows") === true,
        colleagueSafeText: pick("colleague_safe_text") === true,
        readOnly: pick("read_only") === true,
        allowlist: layered.flatMap((layer) => layer.allowlist ?? []),
      };
      if (entry.name) policy.name = entry.name;
      if (sheet && tabPolicy) policy.sheet = sheet;
      const writable = pick("writable_columns");
      if (writable) policy.writableColumns = writable;
      const note = pick("note");
      if (note) policy.note = note;
      const preset = pick("preset");
      if (preset) policy.preset = preset;
      const archetype = pick("archetype");
      if (archetype) policy.archetype = archetype;
      return policy;
    },
  };
}

function findTabPolicy(entry: SpreadsheetEntry, sheet: string): SheetPolicyFile | undefined {
  if (!entry.sheets) return undefined;
  const wanted = sheet.trim().toLowerCase();
  for (const [name, policy] of Object.entries(entry.sheets)) {
    if (name.trim().toLowerCase() === wanted) return policy;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Asking the policy a question
// ---------------------------------------------------------------------------

export interface ColumnWritability {
  writable: boolean;
  /** Why not, in a sentence a person would say. */
  reason?: string;
}

interface ResolvedWritable {
  spans: Span[];
  headers: string[];
}

function resolveWritable(entries: string[]): ResolvedWritable {
  const spans: Span[] = [];
  const headers: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    if (/^[A-Za-z]{1,3}(:[A-Za-z]{1,3})?$/.test(entry)) {
      spans.push(parseColumnSpan(entry));
    } else {
      headers.push(entry.toLowerCase());
    }
  }
  return { spans, headers };
}

/**
 * May the plugin write this column? A column is identified by its letter and,
 * when we have read the header row, by its header text, because a registry
 * written by a person is far more likely to say "Notes" than "K".
 */
export function isColumnWritable(
  policy: Policy | undefined,
  column: { letter?: string; header?: string },
): ColumnWritability {
  // read_only outranks the column list, and is checked before it, because the
  // whole point of the flag is to say something an empty column list cannot.
  if (policy?.readOnly) {
    return { writable: false, reason: readOnlyReason(policy) };
  }
  if (!policy || !policy.writableColumns || policy.writableColumns.length === 0) {
    return { writable: true };
  }
  const { spans, headers } = resolveWritable(policy.writableColumns);

  if (column.letter) {
    let index: number | undefined;
    try {
      index = columnLetterToIndex(column.letter);
    } catch {
      index = undefined;
    }
    if (index !== undefined && spans.some((s) => index! >= s.startIndex && index! < s.endIndex)) {
      return { writable: true };
    }
  }
  if (column.header && headers.includes(column.header.trim().toLowerCase())) {
    return { writable: true };
  }

  const named = policy.writableColumns.join(", ");
  const which = column.header
    ? `"${column.header}"${column.letter ? ` (column ${column.letter})` : ""}`
    : `column ${column.letter ?? "?"}`;
  return {
    writable: false,
    reason: `${which} is not ours to write. ${describeSheet(policy)} lists ${named} as the writable columns.`,
  };
}

/** "The Background Check Tracker" or "This spreadsheet", for use in a sentence. */
export function describeSheet(policy: Policy): string {
  if (policy.name && policy.sheet) return `${policy.name}, tab ${policy.sheet},`;
  if (policy.name) return `The registry entry for ${policy.name}`;
  return "The registry";
}

/** A one line summary for `sheets_open`. */
export function describePolicy(policy: Policy): string {
  const parts: string[] = [`owner: ${policy.owner}`];
  if (policy.writableColumns?.length) {
    parts.push(`writable columns: ${policy.writableColumns.join(", ")}`);
  }
  if (policy.positionalRows) parts.push("rows are positional, so never sort, insert, or delete");
  if (policy.colleagueSafeText) parts.push("text here is read by colleagues");
  if (policy.note) parts.push(policy.note);
  return parts.join("; ");
}

/** One sentence saying this sheet is not ours, for a refusal message. */
export function readOnlyReason(policy: Policy): string {
  return `${describeSheet(policy)} marks this spreadsheet read only, so nothing here is ours to change.${
    policy.note ? ` ${policy.note}` : ""
  }`;
}

/**
 * Refuse a write to a read-only sheet.
 *
 * Every writing tool calls this before it does anything, because `read_only`
 * has to stop a banding, a sort or a raw batchUpdate as surely as it stops a
 * value write, and those tools never look at a column at all.
 */
export function assertWritable(
  policy: Policy | undefined,
  options: { tool: string; force?: boolean },
): void {
  if (!policy?.readOnly || options.force === true) return;
  throw new GsheetsError(
    "contract_violation",
    `${options.tool} was called on a spreadsheet the registry marks read only. ${readOnlyReason(policy)}`,
    "Nothing on this sheet is ours to change, whatever its columns say. If the registry is out of date, fix the registry rather than passing force; if a person has genuinely asked for this one change, force is how you say so.",
    { read_only: true, registry: policy.path },
  );
}

/** True when a structure change that moves rows is forbidden here. */
export function refusesRowMoves(policy: Policy | undefined): boolean {
  return policy?.positionalRows === true;
}
