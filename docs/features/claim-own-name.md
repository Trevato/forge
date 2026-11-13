# Taking the forge's own name

A forge made from a sent link or Start my forge has an organisation named after
it (`probe`). A person claiming it may choose that same name for their account:
the organisation row becomes the account (a person, an admin, with the password
or passkey given), so the apps already under the name stay where they are.

- **Where.** `/claim` and `/welcome` (`takesName` in `src/web/pages/claim.ts`,
  `becomeOrg` in `src/spawn/claim.ts`). One transaction, gated by the burned
  link code; any session the organisation row held is deleted.
- **The link code field** is in the server render, visible and required, so the
  claim works with JavaScript off. The fragment script fills it from `#…` and
  then hides it.
- **Terminal.** The terminal does not take the name: it ends at a link to finish
  in the browser. Its guest menu's Start my forge gives that link, and a closed
  sign-up there says to choose it.
- **Credit.** A run on the host's included credit is budgeted at most what is
  left of it (`cappedByLent`), and the host is asked at the run's end
  (`runEnded`), so the budget and the credit line are one figure.
