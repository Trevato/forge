# Buy links

Where a buyer pays for a hosted forge (#11149). One https link per size (small, medium, large), empty by default.

## Set them

- Web: `/admin/limits`, the **Buy links** row; one address per size, empty clears it.
- Terminal: the palette entry **Buy links**; enter on a size asks for its address.
- API: `PATCH /api/v1/admin/settings` with `{"billingLinks": {"small": "https://…"}}` (admin token); `GET` on the same path reads them.
- MCP: the `signup` tool with `billingLinks`; it plans first, send `dryRun: false` with an admin token to apply. Without `mode` or `billingLinks` it reads them.

An address is https, at most 300 bytes, with no credentials, spaces or quotes. Only a forge admin who is a person may read or change them; each change is kept with who and when.

## What the home shows

With no links, the signed-out home says "Hosted forges are coming." and nothing is sold. With any link set, the home's **Get your own forge** section lists one row per size that has a link: the size's CPU, memory and disk, the monthly price and crew credit, and a **Get a forge** button to the link. "Hosted forges are coming" goes. The prices come from `src/settings/plans.ts`; the buyer is told the forge is made after payment and the claim link arrives by email.

## What llms.txt changes

The "Get your own forge" line says hosted forges are free within limits "while hosting is not sold" when no link is set; with any link set it says paid plans are on the home page and the other way is free within limits.
