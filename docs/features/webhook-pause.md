# Pausing a webhook

A repository admin pauses and resumes a webhook from the terminal (#8082).

- **Where.** The palette's **Webhooks** (`:` → `webhooks`) lists the
  repository's hooks. `p` pauses the selected hook, or resumes it when it is
  paused. Anyone who does not administer the repository is not offered the
  screen.
- **What paused means.** The row reads `paused` in place of its last delivery.
  A paused hook gets no deliveries: new events are not queued for it, and
  deliveries already queued (including ones waiting to retry) stay `pending`
  until it is resumed, then go out. Events that came while it was paused are
  not backfilled.
- **Trail.** Each change is a `webhook.paused` / `webhook.resumed` event.
- **Code.** `pauseWebhook` in `src/actions/repos.ts`; `setWebhookActive` and
  the `w.active = 1` filters in `src/core/webhooks.ts`.
- **Not yet.** No button on the web settings page and no MCP tool.
