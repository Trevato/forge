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

The claim page (`/claim`, `claimForm()` and `dead()` in `src/web/pages/claim.ts`) adds no component class and no card: a
`pageHead`, then one `<section class="settings-block">` holding the plain sentence of what this forge is, the
`#claim-access` sentence and the form (every id kept for the passkey script). The used, expired, made-up and owned states
are the same section with their sentence and, for used and owned, the Sign in action. `test/claim-link.test.ts` holds it.
