# Theme

The appearance picker: the Theme section of the topbar's menu, a radio per theme, each with a round colour swatch of
that theme, then Apply.

- `.swatch` — a theme's colour dot beside its radio, `data-t` naming the theme it shows. Written by `themeForm()` in
  `src/web/layout.ts`; styled in `src/web/style/components.ts` (the ring, and `::after` the inner dot).
