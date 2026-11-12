# Request access (#10928)

`New accounts` has four modes (Admin → Limits, `signup` over MCP and `PATCH /api/v1/admin/settings`):

| mode | meaning |
| --- | --- |
| `open` | anyone can make an account and starts at once; a new account is a guest |
| `request` | anyone can ask for an account; it waits until an admin allows it |
| `invite` | only a person with an invite link can make an account |
| `closed` | no new accounts |

Invite links keep working in every mode but `closed`; in `request` an open invite is a vouch, so its holder starts at once.

## A stranger
`/signup` in `request` mode asks for a username, a password or passkey, and an optional "What do you want to build?". The account is made *waiting* (`user.waiting_at`): `isActive` is false, so no session, token, key or password opens anything. They land on `/signup/requested`: "Your request is in. Someone who runs this forge will look at it; you can close this page and sign in later to check." Signing in (password or passkey) while waiting shows the wait and starts no session; after Decline it says so politely. After Allow the next sign-in works, and home says "You're in." once.

`POST /api/v1/users` answers `202 {state:"waiting", username, message}`; it takes `note` and `from` (the forge or agent asking). The terminal's create screen says the same sentence.

## The admin
- The notifier sends a line for each of the first three waiting requests, then one count line ("N people ask for an account") that moves only every 25 more (`crew/notify.ts`, `requestLines`), linking to the Waiting list.
- The terminal's **Waiting** screen (palette, `src/tui/screens/requests.ts`): `a` allows, `d` declines, through the same actions.
- The **Waiting** list is on top of Settings → Accounts and in home's "Needs you": name, note, when, from where, with **Allow** and **Decline** one tap each.
- API: `GET /api/v1/admin/requests`, `POST /api/v1/admin/requests/:username/allow|decline`; MCP: `account_requests`.
- Allow makes the person a member (small quotas, no model grant: the crew spends nothing until an admin gives credits). Decline keeps the record (`account_request`).

## Limits
At most 200 requests wait (`WAITING_CAP`): past that a stranger meets the closed door, except one holding an open invite, until the admin answers some. Updating a forge that stored `closed` leaves it `closed`; the migration changes no setting.

`NEWCOMER_QUOTAS` (`settings/quotas.ts`: 3 repositories, 2 apps, 200 MB, 1 preview, 1 run, 1 check) hold an account that was allowed from a request, unless the admin stored a quota of their own, which wins for everyone. Admins, existing members and guests are unchanged.
