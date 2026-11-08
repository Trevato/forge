# Machines

A machine's shell page, `/:owner/:name/machines/:machine/shell`
(`src/web/pages/machines.ts`, its rules in `MACHINE_SHELL_CSS`, shipped as the
page's own style). The list at `/:owner/:name/settings/machines` uses the
table and `btn` it already had; no new class there.

- `.machine-term` — the box the terminal (ghostty-web's canvas) draws in:
  its height is fixed to the window below the page head (`100dvh` less
  `--machine-term-above`, the named sum of what sits over it, never under 320px), so nothing moves when the terminal arrives or the
  socket opens; a bordered surface on the page background, its overflow
  clipped. Its `data-wasm` names the emulator's WebAssembly.
- `.machine-term-status` — the one-line status above the box (connecting,
  connected, why it closed): reserves its line (1.5em) so the box never
  shifts as the words change; muted text, a polite live region. The server
  renders it empty and the script says "Connecting…"; without JavaScript a
  `<noscript>` line in the same class says the shell needs it.

Settings › Machines (`/:owner/:name/settings/machines`) adds no component class. As on the home page it is headings over
rows: Machines and Last sessions are each a `<section class="settings-block">` with an `<h2>`. Each machine is a `row()` in
`<ul class="list setting-list" id="machines">` (tools and reach in its meta, "Open shell" as its trail, writers only as the
page is); each session a `row()` in `#machine-sessions`, a running one marked by a ● glyph and a "running" badge, an ended
one by a dash and its reason in words, so state is never colour alone. With no session, one plain sentence says so.
`test/machine-shell-page.test.ts` holds the shape.
