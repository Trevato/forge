import { askedIn, askedJson, askedRepos, isAskedOrder, isAskedShow } from "../../../core/asked.ts";
import { streamJson, thoughtStream } from "../../../core/thought_stream.ts";
import { good, bad, type Tool, str, REPO_ARG } from "../shared.ts";

export const tool: Tool = {
  name: "asked",
  doc: "`{ repo?, show?, order? }`: what people asked the crew for, by default nothing merged yet and oldest first: who and when, the pulls that close it, the crew's last activity, waiting/building/shipped/closed, stale when not shipped in three days and flagged when stale with nothing built; repositories you can write",
  description:
    "What people asked the crew for where you write: by default nothing merged yet, oldest first.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      show: { type: "string", enum: ["unshipped", "flagged", "all"] },
      order: { type: "string", enum: ["oldest", "newest"] },
    },
  },
  writes: false,
  run(ctx, user, args) {
    const show = args["show"] ?? "unshipped";
    if (!isAskedShow(show))
      return bad("invalid_show", "show is unshipped, flagged or all");
    const order = args["order"] ?? "oldest";
    if (!isAskedOrder(order))
      return bad("invalid_order", "order is oldest or newest");
    const spec = args["repo"] === undefined ? null : str(args["repo"]);
    const repos = askedRepos(ctx.app.db, user, spec);
    if (spec !== null && repos.length === 0)
      return bad("not_found", "no such app or repository you can write (owner/name)");
    return good({
      asked: askedIn(ctx.app.db, repos, { show, order }).map(askedJson),
      thoughts: thoughtStream(ctx.app.db, user).map(streamJson),
    });
  },
};
