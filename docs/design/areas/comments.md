# Comments

A comment on an issue or pull, and the form that writes one. Both are a `card()`; these classes give it its comment look.

- `.comment` — one comment as a card: its `.card-head` (byline and time) on the muted ground, the body under it. Written by `commentCard()` in `src/web/comments.ts` and by `reviewRows()` in `src/web/diff-view.ts` (an inline review comment); styled in `src/web/style/components.ts`, and spaced inside a review thread by `.dc-review .comment` in `src/web/style/content.ts`.
- `.comment-body` — a comment's rendered markdown, always beside `.prose`, padded inside its card. Written by `commentCard()` in `src/web/comments.ts`, `reviewRows()` in `src/web/diff-view.ts` and `reviewEntry()` in `src/web/studio/change.ts`; styled in `src/web/style/components.ts` (tighter in a timeline event's card).
- `.comment-form` — the card that writes a comment: a textarea and its `.form-actions`. Written by `composer()` and `editForm()` in `src/web/pages/thread.ts`, `reviewRows()` in `src/web/diff-view.ts` (a reply in a review thread) and `studioApp()` in `src/web/studio/app.ts` (the "Tell the crew" box); styled in `src/web/style/components.ts`, with its narrow-screen action line and its review-thread margin in `src/web/style/content.ts`.
- `.tl-earlier` — the line above a long thread's newest items, `Show N earlier items`, a plain link to `?all=1`. Written by `conversation()` in `src/web/pages/thread.ts`; styled in `src/web/style/components.ts` beside `.tl-item`, indented to the timeline's item column.
