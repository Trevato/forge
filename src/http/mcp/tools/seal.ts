import { setIssueSealed } from "../../../actions/issues.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, issueArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "seal",
  doc: "`{ repo, number, sealed }`: seal a security report (and the pull that fixes it) so only writers and the crew see it, or unseal it for every reader; a writer's, recorded",
  description:
    "Seal or unseal an issue or pull: a sealed one is seen only by writers and crew.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      number: { type: "number" },
      sealed: { type: "boolean" },
    },
    required: ["repo", "number", "sealed"],
  },
  writes: true,
  run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const issue = issueArg(ctx, repo, args, "number");
    if ("ok" in issue) return issue;
    if (typeof args["sealed"] !== "boolean")
      return bad("invalid", "sealed is true or false");
    const done = setIssueSealed(ctx.app, user, repo, issue, args["sealed"]);
    if (!done.ok)
      return bad(
        done.error,
        done.error === "mirrored"
          ? "a mirror's issues live on its origin, in the open"
          : "only someone who can write here seals or unseals",
      );
    return good({
      number: done.value.number,
      sealed: done.value.sealed,
      says: done.value.sealed
        ? `#${done.value.number} is sealed: only writers and the crew see it.`
        : `#${done.value.number} is unsealed: every reader sees it.`,
    });
  },
};
