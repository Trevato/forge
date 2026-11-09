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

## A writer who is not an admin

The feed line links to Settings › Webhooks. An admin gets the settings page; a
writer who is not one gets a page headed "Webhooks" that names the repository's
admins (`repoAdminNames`, `src/core/repo_admins.ts`: the owner of a personal
repository, else the unsuspended members of the org's admin teams). When that
names nobody it says a site admin of the forge can act. Readers and visitors
still get 404.

The terminal has no counterpart on purpose: its Webhooks command is offered to
admins only (`hooksCommands`), and on a personal repository the only writers
are its owner and site admins, who are admins. A non-admin writer meets this
page by the feed link in the browser.
