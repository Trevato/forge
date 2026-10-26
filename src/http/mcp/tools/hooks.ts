import { canAdmin } from "../../../core/repos.ts";
import { listWebhooks } from "../../../core/webhooks.ts";
import { createWebhook, deleteWebhook } from "../../../actions/repos.ts";
import { good, bad, type Answer, type Args, type Tool, REPO_ARG, repoArg, isAnswer, str } from "../shared.ts";

const HOOK_LIMITS = { url: 2048, kinds: 200, secret: 200, id: 64 } as const;

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
  doc: "`{ repo, action, url, secret, kinds, id }`: `list`, `add` (`secret`, 16–200 characters, is required) or `remove` the repository's webhooks, as `…/hooks`; an admin-scope token on a repository you administer, and a secret is never shown",
  description: "List, add (`url`, `secret`, `kinds`) or remove (`id`) webhooks; admins.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      action: { type: "string", enum: ["list", "add", "remove"] },
      url: { type: "string", maxLength: 2048 },
      kinds: { type: "string", maxLength: 200 },
      secret: { type: "string", maxLength: 200 },
      id: { type: "string", maxLength: 64 },
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
      return good(listWebhooks(ctx.app.db, repo.id));
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
    return bad("invalid", "action is list, add or remove");
  },
};
