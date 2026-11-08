# Bring an app from another forge (`/bring`)

Paste the link to an app on a forge you have connected (`/settings/origins`), and it
comes across: the code and history are mirrored, it is registered as a **private** app
and deploys at once, and you watch the first deploy on its app page. "Bring an app" is in
the `+` menu and the palette.

- **Link back stays.** The copy is a mirror: it keeps its origin, so improvements flow
  to the author.
- **Data, variables and secrets never come.** The page lists the names in the app's
  `.env.example` (names only, never values) and takes them in one form. Empty fields set nothing.
- **Left out:** a forge you have not connected (public, anonymous import) answers with a
  link to connect it; there is no anonymous fetch yet.
- Code: `src/origins/bring.ts` (link, host, needs), `src/actions/bring.ts`,
  `src/web/pages/bring.ts`. Test: `test/bring.test.ts`.
