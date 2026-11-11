# Billing

Billing records the plan each forge is on (`src/billing/`): a store of entitlements, every change kept. There is no payment processor and nothing reads a plan to limit a forge yet; a grant is a record until a limit reads it.

- **Plans:** small, medium or large, the sizes. A forge never granted a plan reads as `active` on its size, source `granted`.
- **Grant by hand (admin, a person):** the Billing page, the terminal screen, `PUT /api/v1/forges/{name}/plan` with `{ "plan": "large" }` (`GET` reads it), or the MCP `forges` tool with `{ forge, plan }` (planned first; `dryRun: false` grants).
- **Audit:** every grant is a row in `entitlement_change` and a `billing.plan` event.
- **Terminal:** the palette's *Billing* (admins), `src/tui/screens/billing.ts`: `j`/`k` pick a forge, `s`, `m` or `l` grants that plan after a yes/no.
