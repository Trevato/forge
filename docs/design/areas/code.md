# Code

- `.blob-view` — the file view in the code browser (`renderBlob` in `src/web/pages/repo.ts`): on a Markdown file, wraps the Source/Rendered `.seg` toggle at the end of the file's bar, set 8px off the line count with its segments at 12.5px.
- `.pdf-view`, `.pdf-links`, `.pdf-frame`, `.pdf-fallback` — a PDF on its blob page (`render/pdf.ts`): one card holding the browser's viewer in a full-width frame 80vh tall (480px at least), under an always-visible Open · Download line (the frame is 60vh on a phone so a thumb can scroll past it), with a padded link line inside for a browser that cannot draw it.

`.ex-more` also closes a windowed directory page and the side Files column: the "Show all N entries" link to `?all=1`.

- `.rail-facts`, `.rail-fact` — the facts in a repository's About rail (`aboutCard` in `src/web/pages/repo.ts`): a `dl` of label-over-value pairs, 12px apart, no rules between them, values wrapping anywhere. The rail is narrower than `.status-row`'s 168px label column, so it stacks instead.

- `.card.bare` — a card with its frame taken off (`card({ extra: "bare" })`): no border, shadow, fill or padding, no rules between rows, head and foot as plain lines. The repository page's file listing, README, Following panel and fork line use it; the markup, and so every hook, stays the same.

- `.moved-from` (#10109) — the one muted line "Moved from <old path> on <date>" under a repository head for 30 days after a move; the path wraps anywhere, so no sideways scroll at 390px.

A font specimen (`render/font.ts`): `.font-view` sits in a bare card (`card({ extra: "bare" })`, no box of its own); `.font-name` its family heading, `.font-line` one line of sample text, and `.font-s`, `.font-m`, `.font-l` its three sizes. The small size is 14px; the larger two are display sizes, off the UI scale on purpose.
