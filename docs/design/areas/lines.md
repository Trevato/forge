# Lines

The line-number gutter of a file's source view: one cell per line, holding a link to that line's anchor.

- `.ln` — the number cell of a row in `.code`, written by `blobBody()` in `src/web/pages/repo.ts` as
  `<td class="ln"><a href="#L…">…</a></td>`, styled by `.code .ln` in `src/web/style/content.ts`: right-aligned
  tabular numbers in `--faint` behind a hairline border, unselectable so a copy takes only the code, and `--attn` on a
  `:target` or `[data-hl]` row. `src/web/client.ts` reads `.code .ln a` for shift-click range selection (`#L3-L9`).
  The editor's own gutter is `.editor-gutter`, already named in §5's file editor row.
