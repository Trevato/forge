# Passkey

A passkey control (sign-in, sign-up, claim, first admin, the everyday account, add and recover) reports in §5's form
field: `passkeyNote()` writes a `.field` holding one line, quiet `.muted` text that `passkey-client.ts` swaps for
`.error` (the class named by `data-fail`) on a failure, with `role="alert"`. A page that re-renders with a failure
writes the same shape on the server.

Settings › Passkeys (`passkeysPage()` in `src/web/pages/passkeys.ts`) adds no component class. As on the home page it is
headings over rows: a `<section class="settings-block">` "Your passkeys" with one muted sentence and a `.setting-list` of
`row()`s (the name; when it was added and last used; a Remove that goes through `/-/confirm`, so it works with JavaScript
off), then a second `settings-block`, "New passkey", holding the name field and the add button. No card, no table, no
empty-state box: with none, one plain sentence says so. `test/passkeys-page.test.ts` holds the shape.
