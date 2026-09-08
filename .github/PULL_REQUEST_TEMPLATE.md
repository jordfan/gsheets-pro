## What this changes and why

One to three sentences. Name the behavior that motivated it (a bug report, a
spike finding, a limitation you hit) rather than just describing the diff.

## Test plan

- [ ] `npm run typecheck` and `npm run build` pass
- [ ] `npm test` passes (offline suite, no credentials needed)
- [ ] I added or updated an offline test that covers this change, or I
      explain below why the existing suite already covers it
- [ ] If this touches a tool's live Sheets API calls: I ran the live suite
      against a disposable spreadsheet (`npm run test:live`), or I explain
      below which live case would catch a regression here and why running it
      wasn't practical
- [ ] If this changes a doc, a skill, or a tool description: I checked that
      every path, tool name, and behavior it states still matches the code

## Docs

- [ ] No doc needed updating
- [ ] I updated the relevant doc(s) in this PR: \_\_\_

## Anything a reviewer should know

Tradeoffs you considered and rejected, a spike or discovery-doc citation
behind a Sheets API decision, or a part of the change you are not confident
about.

---

By submitting this PR I confirm it contains no real spreadsheet ids,
hostnames, tokens, or people's names, and that I have read `CONTRIBUTING.md`.
