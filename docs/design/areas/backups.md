# Backups

- `.restore-command` — the one-line restore command on /settings/backups: a `<pre>` that wraps, scrolls with the keyboard (`tabindex="0"`) and takes its height from its text, so a one-liner is not a log pane.

- The lanes card on /settings/backups adds no class: each lane is a `row()` in a `.setting-list`, its lead glyph (✓, !, –) coloured by the row's state (green is `open`, red `closed`, retired `draft`), a retired lane also carrying an outline `badge`, so no state is colour alone.

Settings › Backups (`src/web/pages/backups.ts`) adds no component class. As on the home page it is headings over rows: each
part (Lanes, Where and when, Snapshots, Destination, Off-box mirror, Failure domains) is a `<section class="settings-block">`
with an `<h2>`; the snapshots are `row()`s in `<ul class="list setting-list" id="snapshots">`; with none, one plain sentence
says so. `#backups-live` and its `data-live` attributes are unchanged. `test/backups-parts.test.ts` holds the shape.
