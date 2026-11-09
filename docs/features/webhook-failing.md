# A failing webhook is said once

When a webhook's third delivery in a row ends `failed`, one `webhook.failing`
event goes on the bus (`src/core/webhook_streak.ts`, called from the delivery
worker in `src/core/webhooks.ts`). Once per streak: a success ends it, and a
fourth failure or a redelivery that fails again adds nothing.

Writers of the repository see one line in their feed — "Webhook to
example.com failed 3 times: answered HTTP 500" — linking to the repository, and naming Settings ›
Webhooks, where redeliver and pause are (`webhook-redeliver.md`,
`webhook-pause.md`). Readers do not: the event's audience is `writers`
(`src/core/event_audience.ts`). It names the host, never the address.
