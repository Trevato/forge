# The last Stripe event and refused signatures

An admin who is a person can see when Stripe last told the forge something, and how many events were refused for a bad or stale signature on the current UTC day.

- **Page:** `/settings/billing`, under Provider: two rows, "Last event" (its type and time in UTC, or "No event yet") and "Refused today".
- **Terminal:** the Billing screen (palette: Billing) shows the same two facts in a line under the Stripe status.

Both read `readBilling` (`events`), so both are admin-only: anyone else gets the not-found page, and the terminal screen shows nothing. The data comes from `POST /hooks/stripe` (`stripe_event`, `stripe_hook_refused`). The count is the current UTC day, not a rolling 24 hours.
