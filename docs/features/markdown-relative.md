# Markdown relative images and links

In a repository's Markdown file or README card, a relative image or link resolves inside the same repository at the same ref. Code: `resolveRelative` in `src/web/markdown.ts`; the context comes from `readmeRepo` (`src/web/pages/repo.ts`) and `src/web/render/markdown.ts`.

- `![x](img/a.png)` draws `/<repo>/media/<ref>/<dir>/img/a.png`; `[m](more.md)` opens the file view, `[s](../src/)` the tree. `[![badge](b.svg)](x.md)` is an image inside a link.
- A `../` that leaves the repository, encoded dots or slashes, backslashes and control characters stay as plain text.
- **Absolute images are not drawn.** `![x](https://…)` shows only its alt text: the page's Content-Security-Policy allows no foreign images, so drawing one would only break. The origins browser has no media route and rewrites nothing.
