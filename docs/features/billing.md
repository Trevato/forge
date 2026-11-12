# Billing

Billing records the plan each forge is on (`src/billing/`): a store of entitlements, every change kept. There is no payment processor and nothing reads a plan to limit a forge yet; a grant is a record until a limit reads it.

- **Plans:** small, medium or large, the sizes. A forge never granted a plan reads as `active` on its size, source `granted`.
- **Grant by hand (admin, a person):** the Billing page, the terminal screen, `PUT /api/v1/forges/{name}/plan` with `{ "plan": "large" }` (`GET` reads it), or the MCP `forges` tool with `{ forge, plan }` (planned first; `dryRun: false` grants).
- **Audit:** every grant is a row in `entitlement_change` and a `billing.plan` event.
- **Terminal:** the palette's *Billing* (admins), `src/tui/screens/billing.ts`: `j`/`k` pick a forge, `s`, `m` or `l` grants that plan after a yes/no; `c` connects Stripe (key shown as dots), `w` saves a signing secret, `x` disconnects after a yes/no.
- **Stripe (#11136):** Settings → Billing → Provider takes one key (`src/billing/stripe.ts`, `connection.ts`); how to connect it is in `docs/PROFIT.md`. Not yet: the `/hooks/stripe` receiver, and checkout, portal and reconcile, which come with the pull that calls them.

## Gift codes
A code gives a plan for free, with or without a payment provider (`src/billing/codes.ts`, `src/actions/codes.ts`). No provider is asked: a redeemed code writes the entitlement itself, source `code:<id>`.

- **Make (admin, a person):** Settings → Billing → Codes (below Plans) → *Make a code*, the terminal's *Gift codes* screen (`n` makes, `p` picks the plan, `x` revokes after a yes; live, so a code made or redeemed anywhere shows at once) (plan, uses, note, expiry), `POST /api/v1/codes` (`dryRun` true unless `false`), or the MCP `forges` tool with `code: { plan, uses?, note?, expires? }`. The plain code (`forge-7kq4-m2xp`) and its link `…/?code=<code>` are shown once; only a hash is kept.
- **List / revoke:** the same page (one row per code: plan and note, used of limit, who redeemed, and one *Stop this code working* button), `GET /api/v1/codes`, `DELETE /api/v1/codes/{id}`, MCP `codes: true` / `revoke: <id>`. Revoking stops new uses; forges already made keep their plan.
- **Redeem:** the link moves the code into an HttpOnly cookie and opens `/forges/new` (no code in the address, the log or the history) with the code filled in ("A gift: a medium forge, free."; the admin is not named). Without a code the field sits behind a "Have a code?" disclosure; `POST /api/v1/forges` and the MCP `spawn` take `code`. A wrong, used-up, expired or revoked code is said on the same form. A client may try 10 codes in 10 minutes.
- **Audit:** `billing.code.make`, `billing.code.redeem`, `billing.code.revoke` events.
