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

`.mcp.json` points at `${CLAUDE_PLUGIN_ROOT}/../../dist/cli.js`.

`${CLAUDE_PLUGIN_ROOT}` is the absolute path to this plugin's own installation
directory, which is `plugins/gsheets-pro-local/` inside the cloned marketplace
repository. Two levels up is the repository root, where `npm run build` writes
`dist/`. Claude Code clones the whole marketplace repository, so the built
server sits beside the plugin, and tagged releases commit `dist/`.

If you installed this plugin some other way and the server does not start, the
likely cause is that `dist/` was not part of what you installed. Clone the
repository, run `npm ci && npm run build`, and install with
`--plugin-dir ./plugins/gsheets-pro-local`.

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
