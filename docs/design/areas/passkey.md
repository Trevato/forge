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
`#claim-access` sentence and the form (every id kept for the passkey script). The form is a username and one primary
button, **Create your passkey**, in a `data-passkey="on"` block the script shows where a passkey can run; the password
field sits in a `data-passkey="off"` block the script hides there, so the page never offers both as a choice and never
says which state it is in (no badge). The used, expired, made-up and owned states
are the same section with their sentence and, for used and owned, the Sign in action. `test/claim-link.test.ts` holds it.

The page that answers "make me a forge" (`madeBody()` in `src/web/forge_made.ts`) is a `.narrow .stack`: a `pageHead`,
one `role="status"` sentence that changes with the real step, then the link as a `.setting-list` row with its copy button.

- `.to-phone` — the QR code that opens the link on a phone, with its one muted sentence. Black on white whatever the
  theme, since a scanner needs it so; not shown under 720px, where the person is already on the phone.
