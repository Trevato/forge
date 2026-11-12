import { listRepoRuns } from "../../../actions/runs.ts";
import { RUN_KINDS, type RunKind } from "../../../core/runs.ts";
import { mayView } from "../../../core/sealed.ts";
import { markReaders } from "../../../crew/direct.ts";
import { getIssueById } from "../../../core/issues.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "runs",
  doc: "`{ repo, kind?, limit? }`: the repository's recent runs (kind agent, deploy or check), newest first (id, kind, state, issue or pull number and title, `untrusted: true` on a title from someone who cannot write, started, ended; draws the `ui://forge/runs` card, a failed run first in its status, each row linked to its run page), 1–50, default 20; read as the runs page reads them",
  description:
    "A repository's runs, newest first: id, kind, state, number, start, end.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      kind: {
        type: "string",
        enum: ["agent", "deploy", "check"],
        description: "Only runs of this kind; all kinds when omitted.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "Default 20.",
      },
    },
    required: ["repo"],
  },
  writes: false,
  run(ctx, user, args) {
    const limit = args["limit"] ?? 20;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50)
      return bad("bad_limit", "limit is a whole number from 1 to 50");
    const kind = args["kind"];
    if (kind !== undefined && !RUN_KINDS.some((k) => k === kind))
      return bad("bad_kind", `kind is one of ${RUN_KINDS.join(", ")}`);
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const runs = listRepoRuns(ctx.app, user, repo, {
      limit,
      ...(kind === undefined ? {} : { kind: kind as RunKind }),
    });
    if (!runs.ok) return bad("not_found", "no such app or repository (owner/name)");
    const rows = runs.value.map((r) => {
      const found = r.issueId === null ? undefined : getIssueById(ctx.app.db, r.issueId);
      // A sealed issue the reader may not see gives neither number nor title.
      const issue = found !== undefined && mayView(ctx.app.db, repo, found, user) ? found : undefined;
      return { run: r, issue };
    });
    const seen = rows.flatMap((x) => (x.issue === undefined ? [] : [x.issue]));
    const untrusted = new Set(
      markReaders(ctx.app.db, repo, seen).flatMap((m) => (m.untrusted === undefined ? [] : [m.id])),
    );
    const answer = good({
      runs: rows.map(({ run: r, issue }) => ({
        id: r.id,
        kind: r.kind,
        state: r.state,
        number: issue?.number ?? null,
        title: issue?.title ?? null,
        ...(issue !== undefined && untrusted.has(issue.id) ? { untrusted: true } : {}),
        startedAt: r.startedAt,
        endedAt: r.finishedAt,
      })),
    });
    return { ...answer, card: { repo: `${repo.ownerName}/${repo.name}` } };
  },
};
