/**
 * Credentials.
 *
 * Three ways in, tried in order, because the three audiences are genuinely
 * different people.
 *
 * Path A, a stranger on a laptop: their own GCP project, a Desktop OAuth
 * client, and a loopback PKCE sign in that writes a token under the plugin's
 * data directory. It is the most setup and it is the only path that works for
 * someone with no Google Cloud experience beyond making a project.
 *
 * Path B, anyone who already has gcloud: Application Default Credentials, with
 * no OAuth client to create at all. `gcloud auth application-default login
 * --scopes=...` and they are done.
 *
 * Hosted: a token file the deployment already writes, in the shape Python's
 * `google.oauth2.credentials.Credentials.to_json()` produces, plus an optional
 * bearer that the HTTP transport enforces on every request.
 *
 * One thing worth stating plainly: while the OAuth consent screen is in
 * Testing, Google expires the refresh token after seven days. `doctor` checks
 * for it because otherwise the failure arrives as a bewildering 401 a week
 * after everything worked.
 */
import { GoogleAuth, OAuth2Client, type Credentials } from "google-auth-library";
/** Read and write cells and formatting. Sensitive, and exempt for personal use. */
export declare const SCOPE_SPREADSHEETS = "https://www.googleapis.com/auth/spreadsheets";
/** Files this app created or the user picked. Cannot open an existing sheet by id. */
export declare const SCOPE_DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
/** Restricted. Only needed to search Drive for a spreadsheet by title. */
export declare const SCOPE_DRIVE_READONLY = "https://www.googleapis.com/auth/drive.readonly";
export declare const DEFAULT_SCOPES: string[];
/** How long a Testing mode refresh token lives. */
export declare const TESTING_TOKEN_LIFETIME_MS: number;
export type AuthSource = "oauth_token_file" | "application_default" | "explicit_client";
export interface AuthState {
    client: OAuth2Client | GoogleAuth;
    source: AuthSource;
    /** Where the credential came from, for `doctor` to print. */
    location: string;
    scopes: string[];
    /** When the stored token was last written, for the seven day warning. */
    tokenWrittenAt?: Date;
    /** The access token's own expiry, which is an hour and not interesting. */
    accessTokenExpiry?: Date;
    hasRefreshToken: boolean;
}
/**
 * The plugin's data directory, in the order Claude Code makes one available.
 * `GSHEETS_PRO_DATA` is a plain alias of `GSHEETS_PRO_DATA_DIR`: it is what
 * the gsheets-pro-local plugin's `.mcp.json` passes (`${CLAUDE_PLUGIN_DATA}`,
 * unmodified) so the server lands on exactly the directory Claude Code
 * already gives that plugin, `~/.claude/plugins/data/gsheets-pro-local/` on a
 * normal install, with no `gsheets-pro` subfolder appended, matching what
 * `SECURITY.md` documents. Falling back to the temp directory is deliberate:
 * a token that vanishes on reboot is better than a crash in an environment
 * with no writable home.
 */
export declare function dataDir(): string;
export declare function tokenPath(): string;
export declare function clientSecretPath(): string;
/**
 * Both shapes we accept. Python's `Credentials.to_json()` uses `token` and
 * snake_case; the Node library uses `access_token` and `expiry_date`. The
 * hosted deployment writes the Python shape, so tolerating it is not a nicety.
 */
export interface StoredToken {
    token?: string | null;
    access_token?: string | null;
    refresh_token?: string;
    token_uri?: string;
    client_id?: string;
    client_secret?: string;
    scopes?: string[];
    scope?: string;
    expiry?: string;
    expiry_date?: number;
    /** Written by us, so `doctor` can age the refresh token. */
    saved_at?: string;
    /** Some writers nest the real token one level down. */
    tokens?: StoredToken;
}
export interface NormalizedToken {
    refreshToken?: string;
    accessToken?: string;
    clientId?: string;
    clientSecret?: string;
    scopes: string[];
    expiryDate?: number;
    savedAt?: Date;
}
/** Flatten either shape into one. */
export declare function normalizeToken(raw: StoredToken): NormalizedToken;
export interface OAuthClientFile {
    installed?: {
        client_id?: string;
        client_secret?: string;
        redirect_uris?: string[];
    };
    web?: {
        client_id?: string;
        client_secret?: string;
        redirect_uris?: string[];
    };
}
export interface OAuthClientInfo {
    clientId: string;
    clientSecret: string;
    redirectUris: string[];
    kind: "installed" | "web";
}
/** Pull the client id and secret out of a downloaded Desktop client JSON. */
export declare function readOAuthClient(file: OAuthClientFile, where?: string): OAuthClientInfo;
/**
 * The OAuth client, id and secret, from a file first and the environment
 * second. A file is the deliberate, explicit choice: Path A's downloaded
 * Desktop client JSON, or a hosted deployment's mounted secret. The
 * environment pair, `GSHEETS_PRO_CLIENT_ID` and `GSHEETS_PRO_CLIENT_SECRET`,
 * is how the gsheets-pro-local plugin supplies one instead, through its own
 * `/plugin` configuration (stored in the system keychain, not a file) rather
 * than a downloaded JSON on disk. Returns undefined when neither is there, so
 * callers can build their own error naming the actual next step.
 */
export declare function resolveOAuthClientInfo(clientFile?: string): OAuthClientInfo | undefined;
export declare function saveToken(credentials: Credentials, client: OAuthClientInfo, file?: string): void;
export interface ResolveAuthOptions {
    scopes?: string[];
    /** Read this token file instead of the default location. */
    tokenFile?: string;
    /** Read this OAuth client file instead of the default location. */
    clientFile?: string;
    /** Skip Application Default Credentials, which `doctor` wants to do. */
    skipAdc?: boolean;
}
/**
 * Find a usable credential. Order matters: an explicit token file is the
 * deliberate choice, ADC is the convenient one, and a helpful error beats a
 * mystery 401.
 */
export declare function resolveAuth(options?: ResolveAuthOptions): Promise<AuthState>;
export interface AuthFlowOptions {
    scopes?: string[];
    clientFile?: string;
    tokenFile?: string;
    /** Loopback port. 0 asks the OS for a free one, which is the default. */
    port?: number;
    /** Called with the URL to open. Defaults to printing it. */
    onUrl?: (url: string) => void;
    timeoutMs?: number;
}
/**
 * Run the sign in and write the token. Loopback with PKCE is what Google
 * documents for a Desktop client, and it means no client secret ever has to
 * travel through a browser.
 */
export declare function runAuthFlow(options?: AuthFlowOptions): Promise<{
    tokenFile: string;
    scopes: string[];
}>;
/** The shared secret the HTTP transport requires, when one is configured. */
export declare function expectedBearer(): string | undefined;
/**
 * Constant time compare, so a wrong bearer cannot be discovered a byte at a
 * time by timing the rejection.
 */
export declare function bearerMatches(presented: string | undefined, expected: string): boolean;
/** Pull the bearer out of an Authorization header. */
export declare function readBearer(header: string | string[] | undefined): string | undefined;
//# sourceMappingURL=auth.d.ts.map