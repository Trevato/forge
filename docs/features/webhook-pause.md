# Pausing a webhook

A repository admin pauses and resumes a webhook from the terminal (#8082),
from Settings › Webhooks (#10103), the API and MCP (#10104).

- **Where.** The palette's **Webhooks** (`:` → `webhooks`) lists the
  repository's hooks. `p` pauses the selected hook, or resumes it when it is
  paused. Anyone who does not administer the repository is not offered the
  screen. On the web, each row of `/:owner/:name/settings/hooks` has
  **Pause**, or **Resume** when paused: a same-origin POST to
  `…/settings/hooks/:id/pause` or `…/resume`. Anyone who does not
  administer the repository gets 404, from the page and from the post.
- **What paused means.** The row reads `paused` in place of its last delivery.
  A paused hook gets no deliveries: new events are not queued for it, and
  deliveries already queued (including ones waiting to retry) stay `pending`
  until it is resumed, then go out. Events that came while it was paused are
  not backfilled.
- **Trail.** Each change is a `webhook.paused` / `webhook.resumed` event.
- **Code.** `pauseWebhook` in `src/actions/repos.ts`, called by the
  terminal and by `webhookPause` / `webhookResume` in `src/web/pages/hooks.ts`; `setWebhookActive` and
  the `w.active = 1` filters in `src/core/webhooks.ts`.
- **API and MCP.** `POST /api/v1/repos/:owner/:name/hooks/:id/pause` and `…/resume` (admin scope; 404 for anyone who does not administer the repository or a missing hook) answer `{ id, active }`; MCP `hooks` takes `action: "pause"` or `"resume"` with `id`, the same checks. Resuming queues one delivery of its own: the `webhook.resumed` event is recorded once the hook is active again, so a hook watching `*` receives it; a pause is not delivered, the hook being already inactive. (#10104)
