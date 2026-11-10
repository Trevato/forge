# How a fork follows its upstream

A fork's page says it in one line: **Proposes updates from ann/yard** (you are told, and take updates when you choose) or **Follows ann/yard automatically** (new code is merged as it lands; a conflict goes to the crew). The line shows only on a fork, to anyone who can see the page.

## Switching

- **Web:** an admin of the fork sees one button beside the line. It opens a confirm that says what changes ("without asking", "nothing is merged until you take it"); the POST is same-origin only, and the change is recorded as a `forge.follow_mode` event with the repository and the person.
- **MCP:** `follow_mode` with `repo` and `mode` (`tell-me` or `take-updates`) switches it for an admin and answers in the same words as the page. Anyone else is refused.
- **Terminal:** on a fork's screen the row shows the same line; `m` flips the mode and the toast says the same sentence.

The words live in `src/actions/follow_words.ts` and `followModeSaid` in `src/actions/follow.ts`; every door reads them from there.
