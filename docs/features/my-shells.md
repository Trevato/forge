# Your shells

The machine shells you hold: the live ones first (started, last input, last output, how many are attached, CPU and
memory when the cell reports them, a dash when it does not), then the last ten that ended and why. Read only, your
own account only; another person's shells are never listed.

Try it:
- Web: open `/settings/shells`, or press the palette and choose **Your shells**. With none, it says so in one line.
- Terminal: open the palette (`/`) and choose **Your shells**; `r` reads again, `esc` closes.
- MCP: `sessions` with `kind: "shells"` returns the same rows.

Both doors read `myShells` in `src/machines/shell.ts`. The terminal screen is `src/tui/screens/shells.ts`; the page is
`shellsPage` in `src/web/pages/account.ts`. Left out: ending a shell from the list, and a Settings sidebar row (the
settings page's first-view budget has no word to spare).

Pinned by `test/my-shells.test.ts`.
