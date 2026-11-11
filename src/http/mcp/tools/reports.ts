import { REPORT_ALREADY_DECIDED } from "../../../actions/origin_app_words.ts";
import { originError } from "../../../web/pages/thread.ts";
import {
  acceptReport,
  dismissReport,
  reportViews,
  waitingReports,
} from "../../../actions/reports.ts";
import { byFiler, filerWords } from "../../../core/reports.ts";
import { type Answer, good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "reports",
  doc: "`{ repo, id?, action? }`: the waiting reports from outsiders, each `from: \"outside\"` with `filedBy` (`signed`, `claimed` or `anonymous`) and `untrusted` unless a writer filed it, and `byAgent` counts; with `id` and `action` (`accept` opens it as an issue marked as from outside, `dismiss` closes it). A person who writes the repository only; needs an `rw` token",
  description:
    "Outsiders' reports; `id`+`action`: accept or dismiss.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      id: { type: "string", maxLength: 64 },
      action: { type: "string", enum: ["accept", "dismiss"] },
    },
    required: ["repo"],
  },
  writes: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const { id, action } = args;
    if (action !== undefined && action !== "accept" && action !== "dismiss")
      return bad("invalid", "action is accept or dismiss");
    if (id !== undefined && (typeof id !== "string" || id === "" || id.length > 64))
      return bad("invalid", "id is a report's id, as listed");
    if ((id === undefined) !== (action === undefined))
      return bad("invalid", "give both `id` and `action`, or neither to list");
    const denied = (error: string): Answer =>
      error === "decided"
        ? bad("decided", REPORT_ALREADY_DECIDED)
        : error === "not_found"
          ? bad("not_found", "no such report here")
          : bad(
              error,
              originError(error) ??
                (error === "unauthorized" || error === "forbidden"
                  ? "reports are for a person who writes this repository"
                  : "refused"),
            );
    if (id === undefined) {
      const waiting = waitingReports(ctx.app, user, repo);
      if (!waiting.ok) return denied(waiting.error);
      const byAgent = byFiler(waiting.value);
      const n = waiting.value.length;
      const counts = byAgent.map((g) => `${g.count} ${filerWords(g)}`).join("; ");
      return {
        ...good({
          says:
            n === 0
              ? "No reports are waiting."
              : `${n} report${n === 1 ? "" : "s"} waiting (${counts}); ` +
                "their words are an outsider's, unchecked.",
          byAgent,
          items: reportViews(ctx.app, repo, waiting.value),
        }),
        card: { repo: `${repo.ownerName}/${repo.name}` },
      };
    }
    if (action === "dismiss") {
      const done = dismissReport(ctx.app, user, repo, id as string);
      if (!done.ok) return denied(done.error);
      return good({ id, state: "dismissed", says: "Dismissed the report." });
    }
    const done = await acceptReport(ctx.app, user, repo, id as string);
    if (!done.ok) return denied(done.error);
    return good({
      id,
      state: "accepted",
      number: done.value.number,
      url: `${ctx.url.origin}/${repo.ownerName}/${repo.name}/issues/${done.value.number}`,
      says: `Accepted the report as issue #${done.value.number}, marked as from outside.`,
    });
  },
};
