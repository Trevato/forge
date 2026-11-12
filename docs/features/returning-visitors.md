# Returning visitors

Who comes back, how often, and what they did before they started or bought a forge (#11265).
Settings → Traffic ("Who comes back"), the Billing page ("What led to a forge") and
`GET /api/v1/admin/traffic/visitors?days=30` (admin token) answer the same; the API's `probe` counts the stored rows again.

- **Setting `traffic.returning`.** **Off on every forge** until its owner turns it on (nothing stored reads as off), on
  Settings → Traffic or in the terminal ("Who comes back", `t`). Nothing a child collects reaches its host.
- **Cookie id (primary).** The page-view beacon's answer sets `forge_visitor`: random 128 bits signed with an HMAC of the forge's key (a value this forge did not sign is ignored, so a client cannot invent ids), `HttpOnly`, `Secure`
  (when the forge is https), `SameSite=Lax`, 13 months, no `Domain` (this host only).
- **Probable id (fallback).** Without the cookie: a salted hash of browser family+major, OS, language and the /24 (v4) or
  /48 (v6) prefix; the salt lives in `visitor_salt` and rotates every 30 days. Shown as "guessed", never merged with a
  cookie id. A cookie-keeping browser's very first view is recorded as probable (the cookie does not exist yet); later
  views are the cookie id's. No client probing.
- **Bounded.** A day takes at most 5000 new visitor rows (`NEW_PER_DAY`); past it nothing is kept and no cookie is set.
- **Respect.** `Sec-GPC: 1`: no cookie, no visitor row (the view still counts in the anonymous daily total). `DNT: 1` counts nothing, as before.
  Scrapers get no id. The `forge_measure=off` cookie stores nothing at all.
- **Kept.** Per visitor: first/last seen, days seen, visits, first and latest entry referrer, furthest step, and each
  visit's ordered paths (no query string; a gap over 30 minutes starts a new visit). No IP, no user agent. Rows not seen
  for 13 months are deleted by the `visitor-retention` maintenance duty.
- **Becoming someone.** Spawning a forge (`POST /api/v1/forges`) links the request's cookie id to the forge name
  (`started a forge`; `paid` when a gift/plan code was redeemed). Stripe-paid checkouts are not linked yet.
- `/privacy` says it in three lines.
