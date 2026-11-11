# The Plan row in a forge's settings (#11141)

A forge's admins see one `status-rows` `dl` row (`Plan`) at the top of `/settings`: the plan's name and size, the crew credit used this month, and the status (`Active`, or `Past due, sleeps <date>`). With a billing portal set and a Stripe payer, **Manage billing** links to the provider's customer-portal sign-in (the buyer signs in with the email they paid with); **Change size** links to the host's `/pricing`. A forge with no notice (never told, or a host that is not its parent) shows no row.

- **Host:** Settings → Billing → *Billing portal* sets `billing.portal_url` (https only, empty clears). Changing it tells every forge sent from here.
- **How a forge learns its plan:** the host writes a notice (`src/billing/notice.ts`) into that one forge's own `plan.json` (never `parent.json`) when the forge is made, a gift is redeemed, a plan is granted, or Stripe changes the subscription. The forge reads only its own file and calls nothing on the host, so it cannot read another forge's plan; the notice has no forge name, customer or subscription id.
- **Terminal:** the palette entry *Plan* (`src/tui/screens/planrow.ts`, any admin) shows the same plan line (`planLine`) and, for an admin who is a person, sets the billing portal address with Enter through `changePortalUrl`, as the page does.
