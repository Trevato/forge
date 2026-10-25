# Text utilities

One component: the small text utilities every page puts on a span, a paragraph or a cell to say how its text reads,
without a page-local class of its own. Each is styled in `style/base.ts`; they compose (`muted small` is the usual
quiet line under a card), and a page reaches for them instead of setting a colour or a size by hand.

- `.muted` — low-emphasis text in `--muted-fg`: notes, timestamps, the summary of a tucked disclosure. Written by
  `ui.ts` (`envFacts()`, `terminalLine()`, `disclosure()` with `small`) and most pages
  (`pages/commits.ts`, `pages/settings.ts`, `pages/looks.ts`, …); styled in `style/base.ts`, with contextual rules in
  `style/content.ts`.
- `.small` — 13px text, the step under body. Written by `ui.ts` beside `.muted`, `layout.ts` (the topbar's Asks
  link) and pages such as `pages/edit.ts` and `pages/boards-view.ts`; styled in `style/base.ts`, with contextual rules
  in `style/content.ts`.
- `.num` — tabular figures so counts line up in a column. Written by `ui.ts` (`stat()`'s value, `counts()`)
  and pages such as `pages/spend.ts`, `pages/repo.ts` and `pages/crew.ts`; styled in `style/base.ts`, right-aligned
  inside `.table` by `style/components.ts`.
- `.truncate` — one line that ends in an ellipsis rather than wrapping. Written by `ui.ts` (`envFacts()`'s URL) and
  pages such as `pages/apps.ts`, `pages/refs.ts` and `pages/explorer.ts`; styled in `style/base.ts`, capped at 34ch
  inside `.table` by `style/content.ts`.
- `.sr-only` — text for a screen reader only: a table's caption, a select's label, a fieldset's legend. Written by
  pages such as `pages/audit.ts`, `pages/pull.ts` and `pages/thread.ts`, and by `studio/app.ts` and
  `studio/review_act.ts`; styled in `style/base.ts`.
- `.mark` — the forge's square glyph beside the wordmark and in the footer. Written by `layout.ts` (the topbar's
  `.wordmark` and the `.foot`) and `pages/board.ts`; styled in `style/base.ts` only inside `.wordmark` and `.foot`.
