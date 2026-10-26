# Icons

One icon set, drawn from one sprite: `icon(name)` in `src/web/icons.ts` writes a `<svg>` slot that `<use>`s a
`<symbol>`, and `iconSprite()` defines each drawing a page used once, at the end of `<body>`. Fragments expand the
references in place with `inlineIcons()`. Every rule is in `src/web/style/components.ts`.

- `.ico` — every icon slot: written by `icon()` (`src/web/icons.ts`, as `ico ico-<name>`) and by `themeGlyph`, the
  theme menu's half-filled circle. Styled in `src/web/style/components.ts` (a 16px inline-flex box that never shrinks); the
  components that hold one (`.badge`, `.count`, `.menu-item`, `.toast`, `.empty`, and `src/web/style/content.ts`'s
  `.where-place`, `.live-note`, `.origin-chip`) tune its size and colour.
- `.ico-loader` — the spinning loader, written by `icon("loader")` (`src/web/icons.ts`; used on the pull page,
  `src/web/pages/pull.ts`, and the studio's working word, `src/web/studio/words.ts`). Styled in
  `src/web/style/components.ts`: it spins, and inside a `.btn` it spins only while the button is `aria-busy="true"`.
- `.sprite` — the zero-sized `<svg>` of `<symbol>`s, written by `iconSprite()` (`src/web/icons.ts`, placed by
  `layout.ts`). Styled in `src/web/style/components.ts`: absolutely positioned at 0×0 so it can never move a layout.
