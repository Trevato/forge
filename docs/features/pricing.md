# Buy a forge at /pricing (#11138)

Open `/pricing` with no account. Each plan shows its size, price and crew credit. Type the forge's name and an email, press the paid plan's button, pay at the provider's checkout, and the page you return to (`/pricing/done`) shows the claim link once. Open it to take the forge over.

- **Free plan:** its button goes to `/forges/new`.
- **Closed the tab?** `/pricing/resend`: name and email you bought with; a new link is mailed there (needs mail configured) and the old one stops.
- **No provider connected:** paid plans show their size and say "Ask the operator".
- **Operator:** connect Stripe under Settings → Billing. A paid order whose forge could not be made shows under "Paid, not made" with Retry and a link to the provider's dashboard to refund; a flow alarm names it.
- **Limits:** one client address may have 3 orders waiting at once (counted by socket address, never a header); a name is held 35 minutes and the provider's checkout stops being payable at 31, so a late payer never finds the name given away; a claim link is mailed again at most once a day per order.
- **Terminal:** no screen yet; checkout is browser-only (the provider's hosted page). Tracked in a follow-up issue.
- **Code:** `src/actions/order.ts` (rules), `src/billing/orders.ts` (store), `src/web/pages/pricing.ts` (pages). The paid path is described in `docs/SPAWN.md`.
- **Test:** `bun test test/pricing-order.test.ts`.
