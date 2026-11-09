import { canAdmin } from "../../../core/repos.ts";
import { getWebhook, listWebhooks, pingWebhook, recentDeliveries } from "../../../core/webhooks.ts";
import { createWebhook, deleteWebhook, redeliverWebhook } from "../../../actions/repos.ts";
import { pageRows } from "../page.ts";
import { good, bad, type Answer, type Args, type Tool, REPO_ARG, repoArg, isAnswer, str } from "../shared.ts";

const HOOK_LIMITS = { url: 2048, kinds: 200, secret: 200, id: 64, delivery: 64 } as const;

/** The refusal for a `hooks` argument that is not text or is over its declared length. */
function hookTooLong(args: Args): Answer | undefined {
  for (const [key, max] of Object.entries(HOOK_LIMITS)) {
    const v = args[key];
    if (v !== undefined && (typeof v !== "string" || v.length > max))
      return bad("invalid", `${key} is text of at most ${max} characters`);
  }
  return undefined;
}

const notAdmin = (): Answer => bad("not_found", "no such app or repository, or you do not administer it");

export const tool: Tool = {
  name: "hooks",
  doc: "`{ repo, action, url, secret, kinds, id }`: `list` (pages: `limit` 1–200, `cursor`; `{ items, next_cursor }`), `add` (`secret`, 16–200 characters, is required) or `remove` the repository's webhooks, as `…/hooks`; `deliveries` with `id` answers that hook's last 20, newest first (`{ items: [{ id, state, attempts, lastStatus, lastError, kind }] }`); `ping` with `id` queues one `ping` delivery (`{ id }`), at most 3 a minute per hook; `redeliver` with `id` and `delivery` queues a failed delivery again (`{ id, state }`; 409-like `conflict` if not failed or sealed); an admin-scope token on a repository you administer, and a secret is never shown",
  description: "List, add (`url`, `secret`, `kinds`) or remove (`id`) webhooks; admins.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      action: { type: "string", enum: ["list", "add", "remove", "deliveries", "ping", "redeliver"] },
      url: { type: "string", maxLength: 2048 },
      kinds: { type: "string", maxLength: 200 },
      secret: { type: "string", maxLength: 200 },
      id: { type: "string", maxLength: 64 },
      delivery: { type: "string", maxLength: 64 },
      limit: { type: "number" },
      cursor: { type: "string" },
    },
    required: ["repo", "action"],
  },
  writes: true,
  needsAdminScope: true,
  run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const action = args["action"];
    if (action === "list") {
      if (!canAdmin(ctx.app.db, repo, user)) return notAdmin();
      return pageRows(listWebhooks(ctx.app.db, repo.id), (h) => h.id, args);
    }
    if (action === "deliveries") {
      const long = hookTooLong(args);
      if (long !== undefined) return long;
      if (!canAdmin(ctx.app.db, repo, user)) return notAdmin();
      const hook = getWebhook(ctx.app.db, repo.id, str(args["id"]));
      if (hook === undefined) return bad("not_found", "no such webhook here");
      return good({ items: recentDeliveries(ctx.app.db, hook.id, 20) });
    }
    if (action === "ping") {
      const long = hookTooLong(args);
      if (long !== undefined) return long;
      if (!canAdmin(ctx.app.db, repo, user)) return notAdmin();
      const hook = getWebhook(ctx.app.db, repo.id, str(args["id"]));
      if (hook === undefined) return bad("not_found", "no such webhook here");
      const pinged = pingWebhook(ctx.app.db, `${repo.ownerName}/${repo.name}`, hook);
      return pinged.ok ? good({ id: pinged.value.id }) : bad("rate_limited", `too many pings: try again in ${pinged.error.retryAfter} s`);
    }
    if (action === "redeliver") {
      const long = hookTooLong(args);
      if (long !== undefined) return long;
      const done = redeliverWebhook(ctx.app, user, repo, str(args["id"]), str(args["delivery"]));
      if (done.ok) return good({ id: str(args["delivery"]), state: "pending" });
      if (done.error === "not_failed") return bad("conflict", "only a failed delivery can be sent again");
      if (done.error === "sealed") return bad("conflict", "this delivery belongs to a sealed report and stays refused");
      return done.error === "no_admin" ? notAdmin() : bad("not_found", "no such webhook or delivery here");
    }
    if (action === "add") {
      const long = hookTooLong(args);
      if (long !== undefined) return long;
      const secret = args["secret"];
      if (typeof secret !== "string" || secret.length < 16)
        return bad("invalid", "secret is required: 16 to 200 characters, the key deliveries are signed with");
      const created = createWebhook(ctx.app, user, repo, {
        url: str(args["url"]),
        kinds: str(args["kinds"]) || "*",
        secret,
      });
      if (!created.ok)
        return created.error === "invalid_url"
          ? bad("invalid_url", "a webhook url is https://…")
          : notAdmin();
      // Unlike the API's one-time reveal, the secret is never echoed here.
      return good(created.value.webhook);
    }
    if (action === "remove") {
      const long = hookTooLong(args);
      if (long !== undefined) return long;
      const removed = deleteWebhook(ctx.app, user, repo, str(args["id"]));
      return removed.ok ? good({}) : bad("not_found", "no such webhook here");
    }
    return bad("invalid", "action is list, add, remove, deliveries, ping or redeliver");
  },
};
