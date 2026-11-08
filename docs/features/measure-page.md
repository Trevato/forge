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
