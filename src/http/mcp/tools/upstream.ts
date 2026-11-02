import { checkUpstreamNow, FOLLOW_REFUSALS, followJson, setFollowUpstream } from "../../../actions/upstream_follow.ts";
import { getFollow } from "../../../core/upstream_follow.ts";
import { canAdmin } from "../../../core/repos.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool, str, REPO_ARG, repoArg, isAnswer } from "../shared.ts";
import { ENABLED_WORDS } from "../../../core/arg_words.ts";

export const tool: Tool = {
  name: "upstream",
  doc: "`{ repo, enabled?, url?, branch?, check? }`: the repository a fork follows (an admin reads it); with `enabled` sets it, with `check: true` checks it now; setting and checking need an admin token",
  description:
    "Read, set (`enabled`) or `check` the upstream a repository follows.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      enabled: { type: "boolean" },
      url: { type: "string" },
      branch: { type: "string" },
      check: { type: "boolean" },
    },
    required: ["repo"],
  },
  writes: true,
  readsWithout: "enabled",
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const gone = bad("not_found", FOLLOW_REFUSALS.not_found);
    const refuse = (e: string) => (e === "not_found" || e === "unauthorized" || e === "forbidden" ? gone : bad(e, FOLLOW_REFUSALS[e as keyof typeof FOLLOW_REFUSALS]));
    const acts = args["check"] === true || args["enabled"] !== undefined;
    if (!acts) {
      if (!canAdmin(ctx.app.db, repo, user)) return gone;
      const follow = getFollow(ctx.app.db, repo.id);
      return good({ following: follow === undefined ? null : followJson(follow) });
    }
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "following an upstream needs an admin token");
    if (args["check"] === true) {
      if (args["enabled"] !== undefined) return bad("invalid", "check or set, not both");
      const checked = await checkUpstreamNow(ctx.app, user, repo);
      return checked.ok ? good(checked.value) : refuse(checked.error);
    }
    const { enabled, url, branch } = args;
    if (typeof enabled !== "boolean") return bad("bad_enabled", ENABLED_WORDS);
    if ((url !== undefined && typeof url !== "string") || (branch !== undefined && typeof branch !== "string"))
      return bad("invalid", "url and branch are text");
    const saved = setFollowUpstream(ctx.app, user, repo, { url: str(url), branch: str(branch), enabled });
    return saved.ok ? good({ following: followJson(saved.value) }) : refuse(saved.error);
  },
};
