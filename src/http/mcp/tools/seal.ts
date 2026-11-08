import { setIssueSealed } from "../../../actions/issues.ts";
import { privateRepoForSealed } from "../../../actions/repos.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, issueArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "seal",
  doc: "`{ repo, number, sealed }`: seal a security report (and the pull that fixes it) so only writers and the crew see it, or unseal it for every reader; a writer's, recorded; with `action: \"private\"` instead of `sealed`, the private repository a writer fixes a sealed report in, made on first need, with its name and clone URL (the API's `POST …/issues/:number/private`, same rules)",
  description:
    "Seal or unseal an issue or pull: a sealed one is seen only by writers and crew.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      number: { type: "number" },
      sealed: { type: "boolean" },
      action: { enum: ["private"] },
    },
    required: ["repo", "number"],
  },
  writes: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const issue = issueArg(ctx, repo, args, "number");
    if ("ok" in issue) return issue;
    if (args["action"] !== undefined && args["action"] !== "private")
      return bad("invalid", "action is private");
    if (args["action"] === "private") {
      const made = await privateRepoForSealed(ctx.app, user, repo, issue);
      if (!made.ok)
        return made.error === "not_found"
          ? bad("not_found", "no such issue")
          : made.error === "not_sealed"
            ? bad("not_sealed", "only a sealed report has a private place to fix it")
            : made.error === "unverified"
              ? bad("unverified", "verify your email first")
              : bad(made.error, made.error);
      const there = `${made.value.ownerName}/${made.value.name}`;
      return good({
        repo: there,
        clone: `${ctx.url.origin}/${there}.git`,
        says: `Fix #${issue.number} in ${there}: clone ${ctx.url.origin}/${there}.git`,
      });
    }
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
