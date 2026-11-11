# Buy links

Where a buyer pays for a hosted forge (#11149). One https link per size (small, medium, large), empty by default.

## Set them

- Web: `/admin/limits`, the **Buy links** row; one address per size, empty clears it.
- Terminal: the palette entry **Buy links**; enter on a size asks for its address.
- Web: `/settings/billing`, the **Payment links** section; one field per size, saved in one submit.
- API: `PUT /api/v1/admin/billing/links` with `{"links": {...}}` (admin token), or `PATCH /api/v1/admin/settings` with `{"billingLinks": {"small": "https://…"}}` (admin token); `GET` on the same path reads them.
- MCP: the `signup` tool with `billingLinks`; it plans first, send `dryRun: false` with an admin token to apply. Without `mode` or `billingLinks` it reads them.

An address is https, at most 300 bytes, with no credentials, spaces or quotes. Only a forge admin who is a person may read or change them; each change is kept with who and when.

## What the home shows

The signed-out home's **Get your own forge** lists every plan ([plans on the home](home-plans.md)) and one **Get a forge** button to `/forges/new`. A paid plan whose size has a link also carries a plain **Pay for <plan>** link to it (opened in a new tab, `noopener`); the free plan never does, and no link adds a second button. The terminal's **Get your own forge** prints the same link as `Pay: <address>`.
