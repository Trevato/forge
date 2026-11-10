# The forge toolbar

A small pill the app proxy adds to an app's pages (production and every pull's
preview), so you always know where you are and can get back to the forge.

- **Where it goes:** into an HTML page the app sent whole and uncompressed,
  once, before the last `</body>` (at the end when there is none). JSON,
  images, scripts, styles, attachments, ranges and `HEAD` pass through byte for
  byte. A page that already carries the tag is not given a second.
- **What it says:** the app, the environment and, on a preview, a link
  "Preview of pull #N" to the pull's page on the forge; Home goes to the forge.
- **No layout shift:** it is `position: fixed` inside a closed shadow root and
  adds nothing to the page's flow or style sheets.
- **Escaping:** app and pull names travel as escaped `data-*` attributes and are
  set as text, never as markup.
- **Content-Security-Policy:** the script is served from the app's own host
  (`/__forge/toolbar-<hash>.js`), so `script-src 'self'` admits it, and an
  app's nonce is copied onto the tag. A policy that admits neither leaves the
  pill out; the app still works.
- **Off:** `"toolbar": false` in `forge.json`.

Tests: `test/toolbar-injection.test.ts`, `test/apps-toolbar.test.ts`.
