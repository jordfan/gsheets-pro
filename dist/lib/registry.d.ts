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
import { z } from "zod";
export declare const REGISTRY_FILENAME = "gsheets-pro.json";
export declare const REGISTRY_RELATIVE_PATH: string;
export type Owner = "human" | "shared" | "agent";
declare const sheetPolicySchema: z.ZodObject<{
    owner: z.ZodOptional<z.ZodEnum<{
        human: "human";
        shared: "shared";
        agent: "agent";
    }>>;
    read_only: z.ZodOptional<z.ZodBoolean>;
    writable_columns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    positional_rows: z.ZodOptional<z.ZodBoolean>;
    colleague_safe_text: z.ZodOptional<z.ZodBoolean>;
    allowlist: z.ZodOptional<z.ZodArray<z.ZodString>>;
    preset: z.ZodOptional<z.ZodString>;
    archetype: z.ZodOptional<z.ZodEnum<{
        tracker: "tracker";
        model: "model";
    }>>;
    note: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
declare const spreadsheetEntrySchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    sheets: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        owner: z.ZodOptional<z.ZodEnum<{
            human: "human";
            shared: "shared";
            agent: "agent";
        }>>;
        read_only: z.ZodOptional<z.ZodBoolean>;
        writable_columns: z.ZodOptional<z.ZodArray<z.ZodString>>;
        positional_rows: z.ZodOptional<z.ZodBoolean>;
        colleague_safe_text: z.ZodOptional<z.ZodBoolean>;
        allowlist: z.ZodOptional<z.ZodArray<z.ZodString>>;
        preset: z.ZodOptional<z.ZodString>;
        archetype: z.ZodOptional<z.ZodEnum<{
            tracker: "tracker";
            model: "model";
        }>>;
        note: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
    owner: z.ZodOptional<z.ZodEnum<{
        human: "human";
        shared: "shared";
        agent: "agent";
    }>>;
    read_only: z.ZodOptional<z.ZodBoolean>;
    writable_columns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    positional_rows: z.ZodOptional<z.ZodBoolean>;
    colleague_safe_text: z.ZodOptional<z.ZodBoolean>;
    allowlist: z.ZodOptional<z.ZodArray<z.ZodString>>;
    preset: z.ZodOptional<z.ZodString>;
    archetype: z.ZodOptional<z.ZodEnum<{
        tracker: "tracker";
        model: "model";
    }>>;
    note: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const registrySchema: z.ZodObject<{
    $schema: z.ZodOptional<z.ZodString>;
    version: z.ZodOptional<z.ZodNumber>;
    defaults: z.ZodOptional<z.ZodObject<{
        owner: z.ZodOptional<z.ZodEnum<{
            human: "human";
            shared: "shared";
            agent: "agent";
        }>>;
        read_only: z.ZodOptional<z.ZodBoolean>;
        writable_columns: z.ZodOptional<z.ZodArray<z.ZodString>>;
        positional_rows: z.ZodOptional<z.ZodBoolean>;
        colleague_safe_text: z.ZodOptional<z.ZodBoolean>;
        allowlist: z.ZodOptional<z.ZodArray<z.ZodString>>;
        preset: z.ZodOptional<z.ZodString>;
        archetype: z.ZodOptional<z.ZodEnum<{
            tracker: "tracker";
            model: "model";
        }>>;
        note: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    spreadsheets: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        sheets: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            owner: z.ZodOptional<z.ZodEnum<{
                human: "human";
                shared: "shared";
                agent: "agent";
            }>>;
            read_only: z.ZodOptional<z.ZodBoolean>;
            writable_columns: z.ZodOptional<z.ZodArray<z.ZodString>>;
            positional_rows: z.ZodOptional<z.ZodBoolean>;
            colleague_safe_text: z.ZodOptional<z.ZodBoolean>;
            allowlist: z.ZodOptional<z.ZodArray<z.ZodString>>;
            preset: z.ZodOptional<z.ZodString>;
            archetype: z.ZodOptional<z.ZodEnum<{
                tracker: "tracker";
                model: "model";
            }>>;
            note: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>>;
        owner: z.ZodOptional<z.ZodEnum<{
            human: "human";
            shared: "shared";
            agent: "agent";
        }>>;
        read_only: z.ZodOptional<z.ZodBoolean>;
        writable_columns: z.ZodOptional<z.ZodArray<z.ZodString>>;
        positional_rows: z.ZodOptional<z.ZodBoolean>;
        colleague_safe_text: z.ZodOptional<z.ZodBoolean>;
        allowlist: z.ZodOptional<z.ZodArray<z.ZodString>>;
        preset: z.ZodOptional<z.ZodString>;
        archetype: z.ZodOptional<z.ZodEnum<{
            tracker: "tracker";
            model: "model";
        }>>;
        note: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
}, z.core.$strict>;
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
/** Walk up from a directory looking for `.claude/gsheets-pro.json`. */
export declare function findRegistryPath(startDir?: string): string | undefined;
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
export declare function loadRegistry(options?: LoadRegistryOptions): Registry | undefined;
/** Parse registry JSON that is already in hand. Exported for tests. */
export declare function parseRegistry(text: string, file?: string): Registry;
export interface ColumnWritability {
    writable: boolean;
    /** Why not, in a sentence a person would say. */
    reason?: string;
}
/**
 * May the plugin write this column? A column is identified by its letter and,
 * when we have read the header row, by its header text, because a registry
 * written by a person is far more likely to say "Notes" than "K".
 */
export declare function isColumnWritable(policy: Policy | undefined, column: {
    letter?: string;
    header?: string;
}): ColumnWritability;
/** "The Background Check Tracker" or "This spreadsheet", for use in a sentence. */
export declare function describeSheet(policy: Policy): string;
/** A one line summary for `sheets_open`. */
export declare function describePolicy(policy: Policy): string;
/** One sentence saying this sheet is not ours, for a refusal message. */
export declare function readOnlyReason(policy: Policy): string;
/**
 * Refuse a write to a read-only sheet.
 *
 * Every writing tool calls this before it does anything, because `read_only`
 * has to stop a banding, a sort or a raw batchUpdate as surely as it stops a
 * value write, and those tools never look at a column at all.
 */
export declare function assertWritable(policy: Policy | undefined, options: {
    tool: string;
    force?: boolean;
}): void;
/** True when a structure change that moves rows is forbidden here. */
export declare function refusesRowMoves(policy: Policy | undefined): boolean;
export {};
//# sourceMappingURL=registry.d.ts.map