# Features (Settings › Features)

`src/web/pages/features.ts` adds no component class. The list and a feature's page are a heading over rows, as the
home page is: a `<section class="settings-block">` with an `<h2>` (a `.bar` when a badge sits beside it) over a
`.setting-list` of `row()`s. No card around the list or a feature's form, and no icon in a row's lead. Classes used are
named in `docs/design/areas/settings.md`. Where an app comes from (fork of, last changed by) is the row's `facts` (`.row-facts`, in `docs/design/areas/lists.md`) on the list, and `.status-rows` `dl` rows on a feature's page.
