# Backups

- `.restore-command` — the one-line restore command on /settings/backups: a `<pre>` that wraps, scrolls with the keyboard (`tabindex="0"`) and takes its height from its text, so a one-liner is not a log pane.

- The lanes card on /settings/backups adds no class: each lane is a `row()` in a `.setting-list`, its lead glyph (✓, !, –) coloured by the row's state (green is `open`, red `closed`, retired `draft`), a retired lane also carrying an outline `badge`, so no state is colour alone.
