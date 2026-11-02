import { closingFrom, plannerCloseRefusal, setIssueStateThrough } from "../../../actions/issues.ts";
import { CLOSE_REASONS } from "../../../core/issues.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, issueArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "close",
  doc: "`{ repo, number, state?, reason?, into?, note? }`: close an issue or a pull (`state` closed by default) or reopen it (`open`); the same rules and refusals as `PATCH …/issues/:number`: an agent closes only what the rules give it and reopens nothing; a bug closed with no fix needs `note` (why, one sentence); answers `state` and `closeReason`",
  description:
    "Close or reopen (`state` open) an issue or pull. `reason`: done, dropped, split (`into`).",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      number: { type: "integer", minimum: 1 },
      state: { type: "string", enum: ["closed", "open"] },
      reason: { type: "string", enum: [...CLOSE_REASONS] },
      note: { type: "string", maxLength: 300 },
      into: {
        type: "array",
        items: { type: "integer", minimum: 1 },
        maxItems: 50,
      },
    },
    required: ["repo", "number"],
  },
  writes: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const issue = issueArg(ctx, repo, args, "number");
    if ("ok" in issue) return issue;
    const state = args["state"] ?? "closed";
    if (state !== "closed" && state !== "open")
      return bad("invalid_state", "state is closed or open");
    // The PATCH route's own check of `reason` and `into`.
    const closing = closingFrom(args);
    if (closing === undefined)
      return bad("invalid_reason", "a reason is done, dropped, or split (with `into`: up to 50 issue numbers)");
    const changed = await setIssueStateThrough(ctx.app, user, repo, issue, state, closing);
    if (!changed.ok) {
      if (changed.error === "invalid_note")
        return bad("invalid_note", "`note` is one sentence of text, at most 300 characters");
      if (changed.error === "reason_required")
        return bad("reason_required", "a bug closed without a fix says why: pass `note`");
      // A planner told no learns which rule refused it.
      const rule =
        changed.error === "forbidden" && state === "closed"
          ? plannerCloseRefusal(ctx.app, repo, issue, user, closing)
          : undefined;
      return bad(
        changed.error,
        rule ??
          (changed.error === "forbidden"
            ? "this is not yours to close or reopen"
            : "that state could not be set"),
      );
    }
    return good({
      says: `#${issue.number} is ${changed.value.state}.`,
      number: issue.number,
      state: changed.value.state,
      closeReason: changed.value.closeReason,
    });
  },
};
