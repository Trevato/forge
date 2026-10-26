# Passkey

A passkey control (sign-in, sign-up, claim, first admin, the everyday account, add and recover) reports in §5's form
field: `passkeyNote()` writes a `.field` holding one line, quiet `.muted` text that `passkey-client.ts` swaps for
`.error` (the class named by `data-fail`) on a failure, with `role="alert"`. A page that re-renders with a failure
writes the same shape on the server.
