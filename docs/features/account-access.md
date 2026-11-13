# Manage account: reset a person's access

An admin opens a person's page (`/settings/accounts/<name>`, linked as **Manage account** from their profile and from `/settings/accounts`, which searches by name) and sees, on one screen: role and join date, email and whether it is verified, passkey count and whether a password is set (never the secrets), the browsers they are signed in on now (when, from where; a person's sign-in history is not kept), what they own, their model allowance and ceilings, and the actions.

- **Reset access** (after a confirm) makes a link, `/signin/access/<secret>`, good for one hour and one use. The person opens it, sets a new password (the admin never sees or sets it) and is signed in, then can add a passkey at `/settings/passkeys`. The admin copies the link from the page; when the forge can send mail and the address is verified, it is mailed too. Tick *Also sign them out everywhere* to end every browser in the same step. A new link withdraws the older ones. Only the link's hash is kept.
- **End all sessions** (after a confirm) signs them out of every browser and does nothing else.
- Verify email, make member or guest, suspend, unsuspend, set the allowance and ceilings, and remove (with the existing confirm) are the same acts the API has, as buttons.
- Every act is an event with the admin as actor (`account.access_reset`, `account.sessions_ended`, `account.access_redeemed`). The person reads "An admin reset your access on …" on the next page they open in any browser; it is marked read only when a page shows it, so a redirect or an API call does not use it up.
- Only the forge's owner (the first admin still here) may reset another admin's access; any other admin is refused. A person who is not an admin is a 404 on all of it.

## API and MCP

- `POST /api/v1/admin/accounts/{username}/reset` with `{ endSessions?, dryRun? }` answers `{ username, url, expiresAt, sessionsEnded, mailed }`.
- `POST /api/v1/admin/accounts/{username}/end-sessions` with `{ dryRun? }` answers `{ username, sessionsEnded }`.
- MCP `account_access` with `{ username, action: "reset" | "end_sessions", endSessions?, dryRun? }`; it plans unless `dryRun` is `false`, and the link is shown once.

## Terminal

The palette's **Account access** (admins only) lists people with the browsers they are signed in on; `/` searches by name, `r` resets access (confirm, with or without signing them out) and shows the link, `e` ends all sessions (confirm). The gates are the page's, and each act is an event, so a web viewer sees it live.
