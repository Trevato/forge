import { THREAD_SAYS } from "../../../actions/thread_words.ts";
import { setIssueLabelsThrough } from "../../../actions/issues.ts";
import { originError } from "../../../web/pages/thread.ts";
import { ensureFlowLabel } from "../../../actions/flow_first.ts";
import { FLOW_LABEL } from "../../../core/flow_label.ts";
import { labelsFor } from "../../../core/issues.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, issueArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "labels",
  doc: "`{ repo, number, labels, action? }`: set an issue's or a pull's labels to exactly these (`[]` clears), or with `action` `add`/`remove` only these; `flow` goes first among ready work; only labels the repository has (`flow` is made on first add), by a writer",
  description:
    "Set an issue's or pull's labels to exactly these (none clears). Writers.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      number: { type: "integer", minimum: 1 },
      action: { type: "string", enum: ["set", "add", "remove"] },
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
    const action = args["action"] ?? "set";
    if (action !== "set" && action !== "add" && action !== "remove")
      return bad("invalid_action", "action is set, add or remove");
    const issue = issueArg(ctx, repo, args, "number");
    if ("ok" in issue) return issue;
    const names = chosen as string[];
    if (action !== "remove" && names.some((l) => l.toLowerCase() === FLOW_LABEL)) {
      const made = ensureFlowLabel(ctx.app, user, repo);
      if (!made.ok) return bad(made.error, originError(made.error) ?? THREAD_SAYS.labelsForbidden);
    }
    const current = labelsFor(ctx.app.db, issue.id).map((l) => l.name);
    const lower = new Set(names.map((l) => l.toLowerCase()));
    const wanted =
      action === "set"
        ? names
        : action === "add"
          ? [...current, ...names]
          : current.filter((n) => !lower.has(n.toLowerCase()));
    // The permission is the action's to check, as on the page.
    const applied = await setIssueLabelsThrough(
      ctx.app,
      user,
      repo,
      issue,
      wanted,
    );
    if (!applied.ok)
      return bad(
        applied.error,
        originError(applied.error) ??
          (applied.error === "unknown_label"
            ? THREAD_SAYS.unknownLabel
            : THREAD_SAYS.labelsForbidden),
      );
    const now = applied.value.map((l) => l.name);
    return good({
      says:
        now.length === 0
          ? `Cleared the labels of #${issue.number}.`
          : `Labels of #${issue.number} set to ${now.join(", ")}.`,
      labels: now,
      url: `${ctx.url.origin}/${repo.ownerName}/${repo.name}/${issue.kind === "pull" ? "pulls" : "issues"}/${issue.number}`,
    });
  },
};
