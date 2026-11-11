# Redeliver a failed webhook delivery

A webhook delivery that ran out of attempts stays failed. A repository admin can send it again from the terminal or from the repository's Settings.

- **Key.** Open a hook's Deliveries screen in the terminal and press `r` on a row. The screen is a repository admin's, and so is the key.
- **Which rows.** Only a `failed` row. On a pending or delivered row `r` does nothing.
- **What happens.** `redeliver` (`src/core/webhooks.ts`) puts the same row back to `pending` with its attempts reset to zero and its last status and error cleared; there is no new row and no new event. It reads, checks and updates the row in one transaction. The worker tries it on its next pass with the same event's payload; on a paused hook (`p`) it waits, pending, until the hook is resumed.
- **Sealed reports.** The delivery of a sealed report stays refused, as it is when the event first fires: `r` leaves the row failed.
- **Page.** Settings > Webhooks lists each hook's recent deliveries, and a `failed` row has a Redeliver button, a POST form to `/:owner/:name/settings/hooks/:id/deliveries/:delivery/redeliver` (`webhookRedeliver`, `src/web/pages/hooks.ts`). Only a repository admin sees it, the POST is same-origin only, and anyone else gets a 404. It redirects back to the page, where the row reads `pending`; a refused redelivery redirects with a notice and changes nothing.
- **API.** `POST /api/v1/repos/:owner/:name/hooks/:id/deliveries/:delivery/redeliver` (admin-scope token, a repository you administer; 404 otherwise) goes through the same action as the form (`redeliverWebhook`, `src/actions/repos.ts`) and answers `{ id, state: "pending" }`. A row that is not `failed`, or a sealed report's, answers 409 with a sentence and changes nothing.
- **MCP.** `hooks` with `action: redeliver`, `id` and `delivery`: the same checks, a `conflict` error in the 409 cases.
