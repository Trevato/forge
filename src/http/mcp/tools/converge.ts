import { NOT_A_MEMBER } from "../../../core/roles.ts";
import { ARCHIVED_WHY, forkParentFor } from "../../../core/repos.ts";
import { convergeFork } from "../../../crew/converge.ts";
import { DIRECTION_NOTE } from "../../../crew/direct.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "converge",
  doc: "`{ repo }`: the fork's crew merges where both sides changed the same files; comes back as a pull",
  description:
    "Have a fork's crew merge the parent's updates where both changed a file.",
  inputSchema: {
    type: "object",
    properties: { repo: REPO_ARG },
    required: ["repo"],
  },
  writes: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const parent = forkParentFor(ctx.app.db, repo, user);
    if (parent === undefined)
      return bad("not_a_fork", "this repository follows nothing");
    const outcome = await convergeFork(ctx.app, repo, parent, user);
    if (outcome.kind === "forbidden") return bad("forbidden", DIRECTION_NOTE);
    if (outcome.kind === "not_member") return bad("not_member", NOT_A_MEMBER);
    if (outcome.kind === "archived") return bad("archived", ARCHIVED_WHY);
    return good({
      kind: outcome.kind,
      issue: "issue" in outcome ? outcome.issue.number : null,
      pull: "pull" in outcome ? outcome.pull.number : null,
    });
  },
};
