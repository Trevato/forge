## 4. Space, radius, motion

- **4px grid.** Every padding, margin and gap is divisible by 4; 6px is allowed
  _inside_ a control. Scale: `2 4 6 8 12 16 24 32 48 64`.
- **Three radii, held to.** `--radius-sm: 6px` on controls (button, input,
  chip, kbd), `--radius: 8px` on surfaces (card, code block), `--radius-lg:
12px` on overlays (menu, dialog, palette), `999px` on pills and avatars.
  A nested element uses the outer radius minus the border width, never the same.
- **Dividers**: `border-top` on `:not(:first-child)`, never `border-bottom` on
  all — that is where the double line at the end of a list comes from.
- **Density**: dense rows (files, commits, issues) 40px; anything touchable is
  ≥44px under `@media (pointer: coarse)` — via padding, so text stays centered.
- **Motion**: 100–200ms, `cubic-bezier(.2,0,0,1)`, enter only. Only `color`,
  `background-color`, `border-color`, `opacity` and `transform` are ever
  animated. Never `height`, never `box-shadow` on scroll. Everything is inside
  the `prefers-reduced-motion` kill switch.
- **Focus** is the accent at 2px with 2px offset, identical on every control,
  and inset (−2px) on full-bleed rows so nothing reflows. Never `outline: none`.
- **Sticky, and only these**: the topbar, a diff file's header, the file path
  header. Everything anchorable carries `scroll-margin-top`.
- **Layout is tokens.** A `z-index` is `var(--z-…)`, spacing is on the scale above,
  and `position: fixed` or a full-viewport box belongs to `src/web/overlay_host.ts`
  (open a layer with `forgeOverlay.open`). Enforced: `src/design/layout.ts`, run by
  `bun scripts/design-lint.ts`; today's debt is named per file under `layout` in
  `docs/design/baseline.json` and only shrinks.
