import { pageLimit } from "../../../core/issues.ts";
import { listPinned, pinRepo, unpinRepo } from "../../../actions/origins.ts";
import { canRead, getReposByIds } from "../../../core/repos.ts";
import { good, bad, badLimit, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "pins",
  doc: "`{ action?, repo?, limit? (1 to 200), cursor? }`: `list` (the default) the caller's pinned repositories, paged by `owner/name` as `GET /api/v1/user/pins` is (`next_cursor`), leaving out a pin whose repository the caller can no longer read (the API's list still names it); `pin` or `unpin` `repo`, as `PUT`/`DELETE /api/v1/user/pins/:owner/:name` do. A repository the caller cannot see is not found",
  description: "Your pinned repos: list, pin or unpin `repo`.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "pin", "unpin"] },
      repo: REPO_ARG,
      limit: { type: "integer", minimum: 1, maximum: 200 },
      cursor: { type: "string" },
    },
  },
  writes: true,
  readsWithout: "repo",
  run(ctx, user, args) {
    const action = args["action"] ?? "list";
    if (action !== "list" && action !== "pin" && action !== "unpin")
      return bad("invalid", "action is list, pin or unpin");
    if (action === "list") {
      const { limit, cursor } = args;
      const limitRefused = badLimit(limit);
      if (limitRefused) return limitRefused;
      if (cursor !== undefined && typeof cursor !== "string")
        return bad("invalid", "`cursor` is the one a previous answer gave");
      const size = pageLimit(limit as number | undefined);
      const pins = listPinned(ctx.app, user);
      const repos = getReposByIds(ctx.app.db, pins.map((p) => p.repoId));
      const all = pins
        .flatMap((pin) => {
          const repo = repos.get(pin.repoId);
          if (!repo || !canRead(ctx.app.db, repo, user)) return [];
          return [{ repo: `${repo.ownerName}/${repo.name}`, pinnedAt: pin.createdAt }];
        })
        .sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
      const after = cursor ? all.filter((p) => p.repo > cursor) : all;
      const page = after.slice(0, size);
      return good({
        pins: page,
        next_cursor: after.length > size ? page[page.length - 1]!.repo : null,
      });
    }
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const done = action === "pin" ? pinRepo(ctx.app, user, repo) : unpinRepo(ctx.app, user, repo);
    return done.ok
      ? good({ repo: `${repo.ownerName}/${repo.name}`, pinned: action === "pin" })
      : bad(done.error, action === "pin" ? "that could not be pinned" : "that repository is not pinned");
  },
};
