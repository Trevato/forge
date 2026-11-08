# Form layout

A form's fields and its buttons sit in two rows, one for what you fill in and one for what you do with it.

- `.field-row` — a row of `.field`s side by side that wraps on a narrow screen, each at least 160px wide and aligned to the bottom so a labelled input and the button beside it share a baseline. Styled in `style/components.ts`; written by `createForm` in `pages/branches.ts` (the new-branch form), the graph filter in `pages/fleet-graph.ts` and the freeze form in `pages/frozen.ts`. The new-pull form stacks Base and Compare as plain `.field`s, one column at any width.
- `.form-actions` — the row of a form's buttons under its fields: 16px above, 8px apart, wrapping. Styled in `style/components.ts`, and in `style/content.ts` for a thread's close reason and "close into" input and for `.comment-form` on a narrow screen; written by nearly every form in `src/web/pages/` (`account.ts`, `settings.ts`, `crew.ts`, `edit.ts`, `issues.ts`, `pulls.ts`, `oauth.ts`, `teams.ts`, `chain.ts`, `everyday.ts`) and by the review comment form in `diff-view.ts`; `client.ts` finds its `.muted` note to report a save.

- The gate break-glass (#7790) on the pull's Files step is a plain `field()` with a hint and a `.form-actions` row holding one `btn` in the `danger` variant; no new class. It sits under the disabled primary Merge button, so the page keeps one accent.
