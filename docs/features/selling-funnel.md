# The selling funnel

Settings → Billing, below Provider and Plans, has "Last 7 days: from visit to paid": one row per step — visits to the anonymous home, plans came into view, a plan's button pressed, forges made, entitlements active through a provider — each with its share of the step before; then a row per plan clicked and the top 5 referrers of visits that pressed a plan.
- In the terminal: the palette's "From visit to paid" (`tui/screens/funnel.ts`), the same rows, for a forge admin who is a person; `w` flips 7 and 30 days.

- `GET /api/v1/admin/billing/funnel?days=7` (a person admin; `days` 1 to 90) answers the same as JSON.
- `GET /api/v1/admin/traffic/probe?scope=funnel` counts each step again in SQL; `agrees` false and staying false is a claim to look at.
- Counts are the traffic view's own (`perf/funnel.ts`): scope `funnel` in `traffic_view`, the daily-salted visitor hash, scrapers never counted, no personal data, kept 90 days. Steps 1 to 3 count a visitor once a day; forges count forges; paid reads `entitlement_change` where the forge's provider is not `none`.
- The home's script (`web/funnel_door.ts`) posts to `/_funnel` (same-origin, rate-limited, nothing under Do-Not-Track); the plan must be one the forge offers. The free start is the "Get a forge" button, counted under the free plan's name.
- Not counted: forges made through the API or MCP (only the new-forge form), and the home served to a signed-in person.
