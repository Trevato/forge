import { ORIGIN_UNREACHABLE } from "../../../actions/origin_app_words.ts";
import { reattachMirror, syncRepoNow } from "../../../actions/origins.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Answer, type Tool, REPO_ARG, repoArg, isAnswer, str } from "../shared.ts";

/** What an agent does next, for each way a sync or a reconnect is refused. */
const REFUSALS: Record<string, string> = {
  forbidden: "you need write access to sync here",
  unauthorized: "you need write access to sync here",
  not_detached: "this mirror is not frozen; sync it without originId",
  wrong_host: "that origin is on another site than the mirror came from",
  remote_unknown: "this mirror's source is not known; it cannot be reconnected",
  origin_cannot_see: "that origin's account cannot see the source repository",
  not_the_same_repo: "the origin's repository is not the one this mirror came from",
  already_mirrored: "that repository is already mirrored here",
  needs_reauth: "that origin's token no longer works; connect it again",
  unreachable: `${ORIGIN_UNREACHABLE}; try again later`,
};

export const tool: Tool = {
  name: "sync",
  doc: "`{ repo, originId? }`: sync a mirror now, or with `originId` (admin token) reconnect its origin; refused as `POST …/sync` and `…/origin/reconnect` are, a fork is pointed to `take_updates`",
  description: "Sync a mirror now; `originId` reconnects it.",
  inputSchema: {
    type: "object",
    properties: { repo: REPO_ARG, originId: REPO_ARG },
    required: ["repo"],
  },
  writes: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const reconnecting = args["originId"] !== undefined;
    const refused = (e: string): Answer =>
      e === "not_found"
        ? bad("not_found", "no such app or repository (owner/name)")
        : reconnecting && (e === "forbidden" || e === "unauthorized")
          ? bad(e, "you need to be an admin of this repository to reconnect its origin")
          : bad(e, REFUSALS[e] ?? e);
    if (reconnecting) {
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "reconnecting a mirror needs an admin-scope token");
      const done = await reattachMirror(ctx.app, user, repo, str(args["originId"]));
      return done.ok
        ? good({ says: `Reconnected ${done.value.fullName}; its refs are syncing.`, fullName: done.value.fullName })
        : refused(done.error);
    }
    if (repo.origin === null && repo.forkParentId !== null)
      return bad("not_a_mirror", "this is a fork; use take_updates");
    const synced = await syncRepoNow(ctx.app, user, repo);
    return synced.ok
      ? synced.value.error === ""
        ? good({ says: "Synced.", ...synced.value })
        : bad("sync_failed", synced.value.error)
      : refused(synced.error);
  },
};
