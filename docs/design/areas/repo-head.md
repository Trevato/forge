# Repository head

Every forge pull's preview carries desk and phone looks of this page as the owner, over the preview seed's `/preview-admin/sample` (#8865).

The head of a repository page names the repository and what you can do with it. `scopeHeader()` in `src/web/chrome.ts` draws it; the rules live in `src/web/style/content.ts`.

- `.repo-title` — the head's `owner / name` line: the owner muted, the slash faint, the name in full weight. It is an `h1` on a repository's own pages and a `div` where the page has its own `h1`.
- `.repo-nav` — the head's navigation at rest (#8774): Code (or Studio and Files), Issues, Pulls and Settings as
  words-only tabs, and every other step (Map, Commits, Branches, Forks, Runs, Events, API, Terminal) in one "More"
  menu beside them; a rare step the page is on stays a tab. `src/web/repo_steps.ts` is the one list, with the
  conditions for each; the command palette draws its rows from it, so a link the head shows is a palette row.
- Quiet at rest: no tab icons, no "Public" badge (the audience line says it in words; only "Private" wears a badge),
  and on a live browse one primary action ("Mirror into your workbench" / "Open the mirror") with Fork and "Open on
  <host>" in a "More" menu beside it.

The head is for knowing where you are and taking the next step; everything else waits one tap away.
