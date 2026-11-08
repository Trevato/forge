# Measuring a page: height and words

`scripts/measure-page.ts` answers "did this page get shorter?" with two numbers per page, the same way before and after a change.

```sh
# the page now, at 1440 wide, with pictures at 1440 and 390, light and dark
bun scripts/measure-page.ts --shots out/ /settings/subscriptions /settings/usage \
  /alice/demo/settings#proposal-tokens /alice/demo/settings#crew

# the same pages at an older commit
git worktree add ../before <commit>^ && ln -s "$PWD/node_modules" ../before/node_modules
bun scripts/measure-page.ts --root ../before /settings/subscriptions …

# no Chromium on this machine: words only, from the served HTML
bun scripts/measure-page.ts --words-only /settings/usage
```

- **height** is `document.documentElement.scrollHeight` in headless Chromium at `--width` (default 1440); for `path#id` it is that element's box height. When the id is absent (a page from before its sections had ids) the card or section whose `<h2>` is the id with spaces is used.
- **words** come from `src/measure/words.ts` in every mode: the text of `<main>` (or of the `#id` element), tags, scripts, styles and comments dropped. In a browser it reads the DOM's HTML back, so the method does not differ between modes.
- The script boots the checkout named by `--root` on a throw-away data directory, signs in a seeded admin (`alice`, the fixture the tests use) with a session, and seeds rows so growth per row shows: a repository `alice/demo` with five proposal tokens and three crew agents, and three subscriptions.
- One JSON line per path: `{"path","width","height","words"}`; exit 2 on bad usage, 3 when there is no Chromium and `--words-only` was not given.

## On file: Settings pages around 96b47467e (#9617)

Words, from `--words-only` on `96b47467e^` and `96b47467e` (seeded rows as above). Height needs Chromium, which could not start in the sandbox this was recorded in (`socket() failed: Operation not permitted`); run the command above with `--root` at each commit to fill the column.

| Page | words before | words after | height before → after |
| --- | --- | --- | --- |
| Subscriptions `/settings/subscriptions` | 394 | 289 | not measured |
| Usage `/settings/usage` | 20185 | 2508 (see below) | not measured |
| Tokens `/alice/demo/settings#proposal-tokens` | 87 | 81 | not measured |
| Crew `/alice/demo/settings#crew` | 211 | 178 | not measured |

**Why Usage reads 20185 before.** It is real table text, not script or JSON: the page prints one row per route pattern, and before the rewrite each row's "By role" and "By surface" cells wrote every key with its count (`user 0 · agent 0 · …`), used or not. After, `part()` in `src/web/pages/usage.ts` lists only keys with a count above zero, and the intro sentence and card header are shorter. Both runs seed no usage rows and the commit touches only the four pages' files, so the route list is the same at both commits; the drop is the zero-filled cells, which is what the rewrite set out to remove.

**Heights are a blocker, not a result.** The author's sandbox cannot start Chromium, and the preview deployments run pull branches, not `96b47467e^`, so no height was obtained and none is claimed. Whether any page grew in height is therefore unanswered; words alone fell on all four pages. Someone with Chromium runs the command above once per commit.

`96b47467e` is the commit the issue names; its subject carries #9617, the issue text says #9583. The hash is the pair measured.
