# Your shells

The machine shells you hold: the live ones first (started, last input, last output, how many are attached, CPU and
memory when the cell reports them, a dash when it does not), then the last ten that ended and why. Read only, your
own account only; another person's shells are never listed.

Try it:
- Web: open `/settings/shells`, or press the palette and choose **Your shells**. With none, it says so in one line.
- Terminal: open the palette (`/`) and choose **Your shells**; `j`/`k` pick a line, `s` stops the picked live shell, `i` stops all idle ones, `r` reads again, `esc` closes.
- MCP: `sessions` with `kind: "shells"` returns the same rows.

Both doors read `myShells` in `src/machines/shell.ts`. The terminal screen is `src/tui/screens/shells.ts`; the page is
`shellsPage` in `src/web/pages/account.ts`. Left out: a Settings sidebar row (the
settings page's first-view budget has no word to spare).

Stopping (#10545), on all three doors with the same receipts: on the page each live line has **Stop**, and **Stop all idle** stops every shell of yours that nobody is
attached to and that is past half the idle limit. Both are same-origin form posts (`/settings/shells/:id/stop`,
`/settings/shells/stop-idle`); another person's id is a 404; each answers on the page with a one-line receipt and
records `end_reason = 'stopped'`. MCP: `sessions` with `kind: "shells"` and `action: "end"` + `id`, or `"end_idle"`. Terminal: `s` and `i` as above, answering in a toast.

Pinned by `test/my-shells.test.ts` and `test/tui-my-shells.test.ts`.

## App terminals (#10549)

An app's terminal (`tty` in forge.json, over SSH or the forge's UI) is held in `src/apps/tty_registry.ts` while it is open: app, environment, holder, start, last input and output. `myShells` lists it as a `kind: "app"` row beside the machine shells, on the account page and in `sessions` (`kind: "shells"`). Stop and Stop all idle hang up its pty (SIGHUP, its process group ends); one idle for the shell idle limit stops itself. Only live terminals are listed: an ended one leaves no row.
