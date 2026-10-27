import { askedIn, askedJson, askedRepos, isAskedOrder, isAskedShow } from "../../../core/asked.ts";
import { streamJson, thoughtStream } from "../../../core/thought_stream.ts";
import { good, bad, type Tool, str, REPO_ARG } from "../shared.ts";
import { ORDER_WORDS } from "../../../core/arg_words.ts";

export const tool: Tool = {
  name: "asked",
  doc: "`{ repo?, show?, order? }`: what people asked the crew for, by default nothing merged yet and oldest first: who and when, the pulls that close it, the crew's last activity, waiting/building/shipped/closed, the outcome (landed in a pull, who is building, parked and why, failed) and its sentence, stale when not shipped in three days and flagged when stale with nothing built; repositories you can write; draws the `ui://forge/asked` card: flagged asks first, then each ask's words, its state and a link to the merged or open pull that closes it, else the issue; at most 20 rows",
  description:
    "What people asked the crew for: unmerged by default, oldest first.",
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
      return bad("invalid_order", ORDER_WORDS);
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
