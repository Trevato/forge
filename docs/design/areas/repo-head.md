# Repository head

The head of a repository page names the repository and what you can do with it. `scopeHeader()` in `src/web/chrome.ts` draws it; the rules live in `src/web/style/content.ts`.

- `.repo-title` — the head's `owner / name` line: the owner muted, the slash faint, the name in full weight. It is an `h1` on a repository's own pages and a `div` where the page has its own `h1`.
