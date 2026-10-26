import { THREAD_SAYS } from "../../../actions/thread_words.ts";
import { setIssueLabelsThrough } from "../../../actions/issues.ts";
import { originError } from "../../../web/pages/thread.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, issueArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "labels",
  doc: "`{ repo, number, labels }`: set an issue's or a pull's labels to exactly these (`[]` clears); only labels the repository has, by a writer",
  description:
    "Set an issue's or pull's labels to exactly these (none clears). Writers.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      number: { type: "integer", minimum: 1 },
      labels: {
        type: "array",
        items: { type: "string", maxLength: 64 },
        maxItems: 50,
      },
    },
    required: ["repo", "number", "labels"],
  },
  writes: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const chosen = args["labels"];
    if (
      !Array.isArray(chosen) ||
      chosen.length > 50 ||
      !chosen.every((l) => typeof l === "string" && l.length <= 64)
    )
      return bad("invalid_labels", "labels is a list of up to 50 label names");
    const issue = issueArg(ctx, repo, args, "number");
    if ("ok" in issue) return issue;
    // The permission is the action's to check, as on the page.
    const applied = await setIssueLabelsThrough(
      ctx.app,
      user,
      repo,
      issue,
      chosen,
    );
    if (!applied.ok)
      return bad(
        applied.error,
        originError(applied.error) ??
          (applied.error === "unknown_label"
            ? THREAD_SAYS.unknownLabel
            : THREAD_SAYS.labelsForbidden),
      );
    const names = applied.value.map((l) => l.name);
    return good({
      says:
        names.length === 0
          ? `Cleared the labels of #${issue.number}.`
          : `Labels of #${issue.number} set to ${names.join(", ")}.`,
      labels: names,
      url: `${ctx.url.origin}/${repo.ownerName}/${repo.name}/${issue.kind === "pull" ? "pulls" : "issues"}/${issue.number}`,
    });
  },
};
