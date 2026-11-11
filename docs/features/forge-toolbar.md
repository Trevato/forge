# The forge toolbar

A small pill the app proxy adds to an app's pages (production and every pull's
preview), so you always know where you are and can get back to the forge.

- **Where it goes:** into an HTML page the app sent whole and uncompressed,
  once, before the last `</body>` (at the end when there is none). JSON,
  images, scripts, styles, attachments, ranges and `HEAD` pass through byte for
  byte. A page that already carries the tag is not given a second.
- **What it says:** the app, the environment and, on a preview, a link
  "Preview of pull #N" to the pull's page on the forge; Home goes to the forge.
- **Make it yours:** on a public app, a reader who is not on its crew sees
  one more link, "Make it yours", to the forge's own make-it-yours page for
  that app (no new route), opened in the same tab. Signed out, that page asks
  for sign-in and returns to itself. The owner, any member who can write, a private app and a sealed
  pull's preview see none. A read-only member of a public repository is
  offered it (they cannot write, so there is something to fork); a suspended,
  removed or unknown account is not, while a signed-out reader is. The pill is
  a page-only surface: the terminal already has make-it-yours
  (`src/tui/screens/yours.ts`). Who the reader is comes from the app's own grant,
  read by `/__forge/crew`, never from the page.
- **What a note carries:** a note sent from the pill also carries where it came
  from, folded at the foot of the issue under "Where this came from": the
  build the app is serving (from the forge's own record of the running
  environment, never the client's word) and up to five recent console errors
  (`console.error`, uncaught errors and unhandled rejections, message text
  only). Each error is cut to 200 characters, control characters, URL queries
  and anything shaped like a token, password or key are taken out on the
  server, and the whole is bounded by the request cap. The page is the issue's
  existing `Page:` line and is not repeated. The sender sees nothing new; the
  fold is closed until opened.
- **No layout shift:** it is `position: fixed` inside a closed shadow root and
  adds nothing to the page's flow or style sheets.
- **Escaping:** app and pull names travel as escaped `data-*` attributes and are
  set as text, never as markup.
- **Content-Security-Policy:** the script is served from the app's own host
  (`/__forge/toolbar-<hash>.js`), so `script-src 'self'` admits it, and an
  app's nonce is copied onto the tag. A policy that admits neither leaves the
  pill out; the app still works.
- **Off:** `"toolbar": false` in `forge.json`.

Tests: `test/toolbar-injection.test.ts`, `test/apps-toolbar.test.ts`, `test/note-context.test.ts`, `test/apps-feedback.test.ts`, `test/apps-toolbar-yours.test.ts`.
