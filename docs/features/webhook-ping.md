# Send a webhook a test ping

A repository admin can check that a webhook's receiver answers without waiting for a real event: a `ping` is one signed delivery to that hook only, whatever kinds it follows.

- **Page.** Settings › Webhooks has a **Send ping** button on each hook, a same-origin POST to `/:owner/:name/settings/hooks/:id/ping`. The ping appears at once among that hook's deliveries; a refused one says how long to wait.
- **API.** `POST /api/v1/repos/:owner/:name/hooks/:id/ping` with an admin-scope token answers 202 `{ id }`. Below admin, or for a hook not in the repository, it is 404.
- **MCP.** `hooks` with `action: ping` and `id`, admin scope; it answers `{ id }`.
- **Terminal.** Open a hook's Deliveries screen and press `p`. The screen and the key are a repository admin's; the new row shows at the top as `ping · pending`.
- **Body.** `{ kind: "ping", repo, hook, at }`, signed with the hook's secret like any delivery. The worker sends it on its next pass, with the same egress refusal and retries; a paused hook holds it pending until it is resumed.
- **Rate limit.** At most 3 a minute per hook. Past that the API answers 429 with `retry-after`, MCP says the same, and the page and the terminal say how many seconds to wait.
- **Not an event.** The ping lives on its own delivery row (`webhook_ping`), never in the event log, so no feed, stream or other hook hears of it. A failed ping is not redelivered with `r`: send another.
