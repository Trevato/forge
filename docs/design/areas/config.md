# Config form

A JSON file edited as a form (`src/web/render/config-form.ts`, `src/web/pages/config.ts`, #7336). Styled in
`style/content.ts`.

- `.config-form` — the card that holds the form, on the blob page (read-only) and on the editor page.
- `.config-group` — a nested object or an array, as a `fieldset.field` with a thin rule down its left edge, so depth reads
  without boxes inside boxes.
- `.config-card` — one item of an array of objects: a `.card` with its Up, Down and Remove buttons in a `.bar`.
- `.config-chips` — an array of scalars: a wrapping row of small inputs, each with its Remove button.
- `.config-diff` — the review step's change, one line per row, `data-op="add|del|same"` tinted with the diff tokens.
