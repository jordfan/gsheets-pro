# Security

## What this server stores, and where

**A Google credential.** Depending on which auth path you set up (see
`plugins/gsheets-pro/skills/setup/SKILL.md`), that is either an OAuth refresh
token the server obtained on your behalf, or nothing at all if you are using
Application Default Credentials from the gcloud CLI. Either way it lives on
disk under the server's data directory, by default:

- `~/.claude/plugins/data/gsheets-pro-local/token.json` on a normal plugin
  install
- wherever `GSHEETS_PRO_DATA_DIR` points, if you set it (a hosted deployment
  typically points this at a mounted secrets volume)

The OAuth client secret, if you are running Path A, lives in your system
keychain when it was configured through `/plugin`, or in the file
`GSHEETS_PRO_OAUTH_CLIENT` points at (default
`credentials.json` beside the token) for a self-hosted server. Deleting the
token file signs the server out; nothing else needs cleaning up.

**The bearer token.** A hosted server (`gsheets-pro serve --http`) is
protected by a single shared secret, `GSHEETS_PRO_TOKEN`, that every MCP
request must send as `Authorization: Bearer <token>`. The server holds this
value in memory only, read from the environment at startup. It is never
written to disk by the server itself. If you inject it as
`GSHEETS_PRO_TOKEN_JSON`/`GSHEETS_PRO_OAUTH_JSON` environment variables
instead of mounting files (see `docs/hosting.md`), the container's entrypoint
writes the corresponding files to disk once at startup, at file mode 600, and
logs only how many bytes it wrote, never the contents.

Running a hosted server with `GSHEETS_PRO_TOKEN` unset means it accepts
unauthenticated requests. `gsheets-pro doctor` warns about this. Only do it
if the host is genuinely unreachable from outside its own private network.

**Rendered images.** `sheets_render` writes a PNG to disk: locally, beside
the token under the data directory's `renders/` folder; hosted, under
whatever `renderDir` the HTTP transport was started with, served back only
through a signed, time-limited URL (`src/lib/rendersign.ts`, default TTL a
few minutes) rather than a public path. There is no directory listing at
`/renders/`: a request with no filename, or the wrong signature, gets a 404
indistinguishable from a render that was never generated. Nothing else about
a spreadsheet's contents is written to disk by the server.

**Logs.** The server does not log tool call arguments, cell values, formulas,
or spreadsheet contents anywhere, at any level. What a deployment's own
process supervisor or reverse proxy captures (request method, path, status
code, timing) is metadata about traffic, not the data inside a sheet, and it
is the operator's own logging stack, not something this project writes. If
you add logging in a fork or a PR, keep it that way: metadata only, never a
cell value, a formula, a spreadsheet id, or a token.

**Nothing about your spreadsheets is sent anywhere except Google.** There is
no telemetry, no analytics, no third-party service this server talks to.

## Reporting a vulnerability

Please do not open a public GitHub issue for a security problem.

Use GitHub's private vulnerability reporting instead: on the repository,
Security tab, "Report a vulnerability." That reaches the maintainer directly
without disclosing the issue publicly, and GitHub's own advisory workflow is
the mechanism this project relies on to track and respond.

If you cannot use that path for some reason, open an issue that says only
"security issue, please contact me" with no details and no reproduction
steps, and the maintainer will follow up to arrange a private channel.

When reporting, please include:

- What you found, and how you found it
- Whether it requires a specific auth path (Path A, Path B, hosted bearer) to
  reproduce
- The smallest reproduction you have, ideally against a disposable
  spreadsheet rather than a description that requires guessing

There is no bug bounty. You will get a response, credit in the fix's
changelog entry and commit message if you want it, and the maintainer's
thanks.

## Scope

In scope: the server (`src/`), the CLI, the Docker image, the hooks and
skills that ship in `plugins/`, and the release tooling in `scripts/`.

Out of scope: your own Google account security, your own OAuth consent
screen configuration, and any hosting environment you build yourself
(a misconfigured reverse proxy that drops the bearer check, for instance, is
a deployment issue to fix in your own setup, though a report about it is
still welcome if it points at something this project's docs got wrong).
