# Theme

Appearance is chosen in two places. The topbar's menu holds one row, `themeRow()` in `src/web/layout.ts`: Auto, Light,
Dark as the submit buttons of a `.seg`. Settings, Appearance (`appearancePage()` in `src/web/pages/account.ts`) holds
every theme as a card. Both are one form posting to `/theme`; the shell script applies a press at once.

- `.theme-grid` — the gallery's form: two cards across on a phone, four from 720px.
- `.theme-card` — one theme as a submit button: its preview, its name, and Light or Dark under it;
  `aria-pressed="true"` rings it in the accent.
- `.theme-look` — the preview: a small page and card in the theme's own colours, which `data-look` on each half puts
  in scope whatever the page wears. Auto shows the default pair side by side.
