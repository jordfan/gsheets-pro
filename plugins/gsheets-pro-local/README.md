# gsheets-pro-local

This plugin does one thing: it starts the bundled gsheets-pro MCP server over
stdio on your own machine. Everything that shapes the output, the skill, the
presets, the hooks, and the reviewer, lives in the `gsheets-pro` plugin. Enable
both.

```
/plugin marketplace add jordfan/gsheets-pro
/plugin install gsheets-pro
/plugin install gsheets-pro-local
```

Then run `/gsheets-pro:setup` for the Google authentication walkthrough.

## Where the server binary comes from

`.mcp.json` points at `${CLAUDE_PLUGIN_ROOT}/bin/start.mjs`, a small
dependency-free bootstrap, not at a built `dist/cli.js` directly.

That indirection exists because `${CLAUDE_PLUGIN_ROOT}` is not, as it might
look, a path inside a full checkout of this repository. A `claude plugin
marketplace add` install materializes only this plugin's own subtree, this
directory and its neighbors, into a cache directory of Claude Code's own
choosing; there is no `src/`, no `package.json`, no repository root reachable
from there by any relative path, so a built `dist/cli.js` cannot simply sit two
levels up the way it would in a hand-cloned checkout.

So `bin/start.mjs` builds and caches the server itself, the first time it
runs: `npm install git+https://github.com/jordfan/gsheets-pro.git` into this
plugin's own persistent data directory (`${CLAUDE_PLUGIN_DATA}`), which clones
the repository, runs its build through the package's own `prepare` script, and
keeps only the built output and its runtime dependencies, no TypeScript
toolchain left behind. That first run prints one status line to stderr and can
take a minute; every run after it, as long as this plugin's own version has
not changed, execs the already-built server directly, with no network call and
no npm involved.

If the very first run fails (no network reaching GitHub, no npm on `PATH`,
that kind of thing), the error npm produced is printed to stderr and the
server does not start; fix whatever it names and reconnect.

## Tool names

The server key is `sheets`, so the tools arrive as
`mcp__plugin_gsheets_pro_local_sheets__sheets_open` and so on. Hook matchers and
every line of the skill match on the `sheets_<tool>` suffix, so the same guidance
works whether you reach the server through this plugin, through a self-hosted
HTTP server, or through a Workspace connector.

## Cloud sessions

Claude Code cloud sessions cannot start stdio servers, so this plugin does
nothing there. Run `npx gsheets-pro serve --http` somewhere reachable and add an
HTTP entry to the repository's `.mcp.json` instead. `docs/hosting.md` covers it.
