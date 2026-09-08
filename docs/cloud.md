# Claude Code cloud sessions

Cloud sessions and scheduled routines behave differently from a laptop in ways
that change how this plugin has to be delivered. This is what was measured, and
what to do about it.

## What was verified

Measured in a real cloud session and a real scheduled routine, not inferred.

| | Result |
|---|---|
| Repository hooks in `.claude/settings.json` | **Run.** Including in a scheduled routine |
| Repository skills in `.claude/skills/` | **Load** |
| A plugin declared in `.claude/settings.json` | **Does not install.** See below |
| Stdio MCP servers | **Do not start.** HTTP servers work |
| `hookSpecificOutput.additionalContext` on `allow` | **Reaches the model** |
| A `deny` reason | **Arrives as the tool's error text**, so the model reads it |
| `SessionStart` stdout | **Reaches context** |
| `permission_mode` in an unattended run | **Reports `default`.** Not a usable signal |

## A plugin declared in a repository does not install

This is the finding that shaped the delivery. Declaring the plugin in a
repository's `.claude/settings.json` with `extraKnownMarketplaces` and
`enabledPlugins` did nothing in a scheduled routine: the marketplace was never
cloned, the plugin list came back empty, and the skill was unknown. Repository
hooks and skills in `.claude/` loaded normally in the same run.

So there are two ways to get the guide into a cloud session, and only one of
them is verified.

**Vendor it into the repository. This works.**

```
node scripts/vendor.mjs /path/to/your-repo
```

That copies the skill, the hooks, and the presets into the repository's
`.claude/` directory and registers the hooks in its `settings.json`. Commit the
result: a scheduled run gets a fresh clone, so anything uncommitted is not
there.

It is idempotent. Re-running replaces what it wrote before, keyed on the
`.claude/hooks/gsheets-pro/` path in each command, and leaves every other hook
and setting alone. Run it again after a `git pull` to pick up changes.

What lands where:

```
.claude/skills/gsheets-pro/     the guide, references, examples, CARD.md
.claude/hooks/gsheets-pro/      the four hooks and state.mjs
.claude/gsheets-pro/presets/    the style presets
.claude/settings.json           hook entries using $CLAUDE_PROJECT_DIR
.claude/gsheets-pro.json        the registry, if you have one. Not written by the script
```

The hooks resolve the card and the presets relative to their own file, with a
candidate for each layout, so the same scripts work vendored or installed as a
plugin. `hooks.json` is deliberately not copied, since in this layout the
registration lives in `settings.json` and a second file that looks
authoritative would be misleading.

Left out on purpose: the reviewer agent and the `setup` and `review` skills.
They are for interactive work and a scheduled run has no use for them. If you
want the reviewer in a cloud session, copy `agents/sheet-reviewer.md` into
`.claude/agents/` yourself and ask for it by name, since the plugin namespace
`gsheets-pro:sheet-reviewer` does not exist in a vendored install.

**A plugin synced from the claude.ai account. Unverified.** Plugins installed
against the account rather than declared in a repository may reach cloud
sessions. Nobody has tested it. If you try it, the check is whether
`sheets_open` produces the card on its first call.

## The guard denies rather than asks when nobody is watching

The guard hook stops a call that would damage a spreadsheet somebody else owns.
On a laptop it asks. In a scheduled routine it denies, and the difference
matters: an `ask` in a routine produced a permission prompt with nobody to
answer it, and the run stalled.

`permission_mode` cannot tell these apart. The routine reported `default`, the
same value an ordinary interactive session reports. The environment can, so the
hook reads that instead. Any one of these means unattended:

- `permission_mode` is `bypassPermissions` or `dontAsk`, so prompts are
  suppressed or auto-answered.
- `CLAUDE_CODE_ENTRYPOINT` is `remote_trigger`, which is a routine firing on a
  schedule.
- `CLAUDE_CODE_HOLD_UNANSWERED_PARKED_PERMISSION` is set, which the harness does
  in exactly the runs where an unanswered prompt parks instead of resolving.

`CLAUDE_CODE_REMOTE` is deliberately not one of them. It is true for interactive
cloud sessions as well, and denying those would block a person who is sitting
right there and able to decide. An interactive cloud session still gets `ask`.

A denial carries the reason and the card, because a deny reason arrives as the
tool's error text and is therefore read. The reason tells the model not to
retry, and to say in its summary what it did not do, so a person can run it.

## Reaching the server from a cloud session

Stdio servers do not start in cloud, so `gsheets-pro-local` does nothing there.
Run the server over HTTP and add an HTTP entry with a bearer token to the
repository's `.mcp.json`. `docs/hosting.md` covers running it.

Whatever the transport, the tools arrive with a different prefix in each
environment. Every hook matcher and every line of the skill keys on the
`sheets_<tool>` suffix, so nothing needs changing between them.
