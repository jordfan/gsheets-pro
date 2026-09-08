---
name: setup
description: Walks through connecting gsheets-pro to a Google account, including creating an OAuth client, choosing between the two authentication paths, and diagnosing a connection that stopped working. Run it with /gsheets-pro:setup.
disable-model-invocation: true
---

# Setting up gsheets-pro

This is a manual walkthrough, not something Claude starts on its own. It touches
a Google Cloud project and stores a credential, so a person should be the one
who decides to run it.

Start here, whatever the situation:

```
npx gsheets-pro doctor
```

`doctor` reports what it finds: whether a token exists, which scopes it carries,
how the consent screen is configured, how many days until the token expires, and
whether `pdftoppm` is installed for rendering. Most problems are one line of its
output. If it says everything is fine and the tools still fail, the problem is
usually the plugin, not the credential, and the issue tracker is the right place.

## Which path

Two ways to authenticate. Read both before starting; switching later means
redoing the work.

**Path B first if you already have the gcloud CLI.** It needs no OAuth client
and no Cloud Console visit, and it is the fastest way to a working setup.

**Path A otherwise.** It is the path most people take, and it is a Cloud Console
chore. Budget the time honestly.

| | Path A, your own OAuth client | Path B, gcloud application default credentials |
|---|---|---|
| Prerequisite | A Google account | The gcloud CLI, already installed and logged in |
| First-time setup | 15 to 25 minutes, most of it in the Cloud Console | 2 to 5 minutes |
| If you have done it before | About 5 minutes | Under a minute |
| Token lifetime | Indefinite, once the app is published. Seven days if you skip that step | Follows your gcloud session |
| Good for | Anyone. This is the supported default | Developers who live in gcloud already |

Neither path sends your credentials anywhere except Google. The token is stored
on your own machine.

## Path A, your own OAuth client

You are creating a small private application that exists only to let this plugin
talk to your own spreadsheets. Nobody else will ever use it.

1. **Create a project.** Go to console.cloud.google.com, open the project picker
   at the top, and choose New Project. Any name works. Wait for it to finish
   creating and make sure the picker now shows it.

2. **Turn on the two APIs.** In APIs and Services, choose Library. Search for
   Google Sheets API and enable it. Search for Google Drive API and enable that
   too. The Drive API is what lets the plugin find a spreadsheet by name and
   create a new one.

3. **Configure the consent screen.** In APIs and Services, choose OAuth consent
   screen. Pick External unless you are on Google Workspace and only ever want
   your own organization to use it, in which case Internal is simpler and skips
   the publishing step below. Fill in an app name, your email as the support
   contact, and your email again as the developer contact. Save.

4. **Publish the app. Do not skip this.** On the same consent screen page there
   is a Publish app button, and while the app sits in Testing every refresh
   token it issues **expires after seven days**. You will authenticate, use the
   plugin happily for a week, and then find it broken with no obvious cause.
   Click Publish app and confirm.

   Publishing shows a warning about verification. That is expected, and it does
   not apply here. Google exempts an app used only by the person who created it,
   and the Sheets scope this plugin requests is a Sensitive scope, not a
   Restricted one, so no verification review is required. When you sign in you
   will see an unverified-app screen once. Choose Advanced, then continue.

5. **Create the client.** In APIs and Services, choose Credentials, then Create
   Credentials, then OAuth client ID. For Application type choose **Desktop
   app**. Name it anything. Copy the client ID and the client secret from the
   dialog that appears.

6. **Give them to the plugin.** Run `/plugin` and configure `gsheets-pro-local`,
   which prompts for both. The secret goes to your system keychain rather than
   to `settings.json`. If you are self-hosting the HTTP server instead, put them
   in the server's environment. `docs/hosting.md` covers that.

7. **Sign in.** Run `npx gsheets-pro auth`. A browser tab opens, you pick your
   Google account, you click through the unverified-app screen, and the tab says
   you can close it. The token is written to the plugin's data directory.

8. **Confirm.** `npx gsheets-pro doctor` should now report a valid token, the
   two scopes, and a published consent screen.

## Path B, gcloud application default credentials

If the gcloud CLI is installed and you are logged in, there is nothing to
create.

```
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/drive.file,https://www.googleapis.com/auth/cloud-platform
```

The `cloud-platform` scope is there because gcloud requires it alongside the
others; the plugin does not use it. Leave the client ID and secret blank in the
plugin configuration and it will find these credentials on its own.

The tradeoff is that this ties the plugin to your gcloud session. Re-running
`gcloud auth application-default login` for any other reason without those
scopes will break it, and `doctor` will tell you that is what happened.

## Scopes, and the one that is optional

The plugin asks for two:

- `spreadsheets`, to read and write the spreadsheets themselves.
- `drive.file`, to create a new spreadsheet and to reach the ones you open
  through the plugin.

`drive.file` deliberately does **not** grant access to your whole Drive. The
cost is that the plugin cannot open an existing spreadsheet that it did not
create, purely by ID, under this scope alone. Opening one by its URL works.

Searching Drive by title needs a third scope, `drive.readonly`, which Google
classifies as Restricted, and which grants read access to every file in your
Drive. It is off by default. Turn it on only if you actually want
`sheets_find` to search by name, and understand what you are granting.

## When it stops working

Run `doctor` first. The common causes, in the order they happen:

**Everything worked for a week, then stopped.** The consent screen is still in
Testing. Go back to step 4 and publish, then run `npx gsheets-pro auth` again.

**"Requested entity was not found" on a spreadsheet you can see in a browser.**
Usually the ID rather than the whole URL is wanted, and the ID is the long
string between `/d/` and `/edit`. If the ID is right, this is the `drive.file`
limitation above: open the spreadsheet through the plugin once by URL.

**Rendering returns an error about pdftoppm.** Install poppler.
`brew install poppler` on macOS, `apt install poppler-utils` on Debian and
Ubuntu. Everything except `sheets_render` works without it.

**Sudden failures partway through a long build.** Google allows 60 reads and 60
writes per minute per user. The plugin backs off and retries, but a very large
build can still hit it. Wait a minute and continue.

## Cloud sessions and scheduled runs

Two things are different there, and both are measured rather than assumed.

**The stdio server does not start**, so `gsheets-pro-local` does nothing in a
cloud session. Run the server over HTTP and add an HTTP entry with a bearer
token to the repository's `.mcp.json`. `docs/hosting.md` covers it.

**Declaring this plugin in a repository's `.claude/settings.json` does not
install it.** In a scheduled routine the marketplace is never cloned and the
skill is unknown. Repository hooks and skills do load, so for a repository whose
scheduled runs touch spreadsheets, copy the guide in:

```
gsheets-pro vendor /path/to/your-repo
```

That puts the skill, the hooks, and the presets under the repository's
`.claude/` directory and registers the hooks in its `settings.json`. Commit the
result, because a scheduled run gets a fresh clone. Re-running is safe: it
replaces what it wrote before and leaves other hooks alone. Run it again after
pulling a new version.

`docs/cloud.md` has the full findings, including why the guard denies rather
than asks when nobody is watching.

## What is stored, and where

The token, and only the token, in the plugin's data directory. On a normal
install that is `~/.claude/plugins/data/gsheets-pro-local-gsheets-pro/token.json`
(Claude Code names a plugin's data directory `<plugin>-<marketplace>`). Delete
that file to sign out. The client secret lives in your system keychain if you
configured the plugin through `/plugin`. Nothing is sent anywhere but Google,
and the server logs metadata only, never cell contents.
