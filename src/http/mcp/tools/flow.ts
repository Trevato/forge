import { noteRead, telemetryReader } from "../../../actions/telemetry.ts";
import { getIssue } from "../../../core/issues.ts";
import { getPull, pullDir, pullMergeState } from "../../../core/pulls.ts";
import { canWrite } from "../../../core/repos.ts";
import { mayView } from "../../../core/sealed.ts";
import { whyIssue, whyPull, liveHead, whyRepo, type Why } from "../../../flow/why.ts";
import { countRead } from "../../../system/telemetry_reads.ts";
import { flowCached } from "../../../system/flow_cache.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

const number = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;

const said = (subject: string, why: Why) =>
  good({
    subject,
    moving: why.cause === null && why.settled === undefined,
    ...(why.settled === undefined ? {} : { state: why.settled }),
    ...(why.cause === null ? {} : { cause: why.cause.name, says: why.cause.says, clears: why.cause.clears }),
    ...(why.next === undefined ? {} : { next: why.next }),
  });

export const tool: Tool = {
  name: "flow",
  doc: "with no arguments, the forge's pipeline (a forge admin's, or an agent the owner granted `telemetry:read`; private repositories cut out): per stage counts, `oldestWaiting`, `capacity`, the bottleneck, the merge `queue` and what each reviewer has `reviewing`; with `{ repo, issue? or pull? }` (a writer of the repository), why it is not moving: `{ subject, moving, state?, cause, says, clears, next? }`, the first of wall (a person decides new access), ceiling, hot_file, blocked_by, later_gate, no_builder, no_headroom, red_check, waiting_review that holds it (`flow/why.ts`); `repo` alone asks about the repository's builders",
  description:
    "Pipeline (admin); with `repo` and `issue` or `pull`: why it is not moving.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      issue: { type: "integer", minimum: 1 },
      pull: { type: "integer", minimum: 1 },
    },
  },
  writes: false,
  async run(ctx, user, args) {
    if (args["repo"] === undefined) {
      const reader = telemetryReader(ctx.app, user);
      if (!reader)
        return bad("forbidden", "only an admin of this forge, or an agent granted telemetry:read, reads its pipeline");
      noteRead(ctx.app, user, reader, "flow");
      countRead("flow", user.username);
      return good(flowCached(ctx.app, reader));
    }
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const db = ctx.app.db;
    if (!canWrite(db, repo, user) && !telemetryReader(ctx.app, user))
      return bad("forbidden", "only someone who can write here reads why it is not moving");
    const slug = `${repo.ownerName}/${repo.name}`;
    const issueN = number(args["issue"]);
    const pullN = number(args["pull"]);
    if ((args["issue"] !== undefined && issueN === undefined) || (args["pull"] !== undefined && pullN === undefined))
      return bad("invalid", "issue and pull are numbers");
    if (issueN !== undefined && pullN !== undefined) return bad("invalid", "ask about an issue or a pull, not both");
    if (issueN !== undefined) {
      const issue = getIssue(db, repo.id, issueN);
      if (issue === undefined || issue.kind !== "issue" || !mayView(db, repo, issue, user))
        return bad("not_found", `no issue #${issueN}`);
      return said(`${slug}#${issueN}`, whyIssue(ctx.app, repo, issue));
    }
    if (pullN !== undefined) {
      const pull = getPull(db, repo.id, pullN);
      if (pull === undefined || !mayView(db, repo, pull, user)) return bad("no_such_pull", `no pull #${pullN}`);
      if (pull.state !== "open" || pull.mergedAt !== null)
        return said(`${slug}!${pullN}`, whyPull(ctx.app, repo, pull, { headOid: pull.headOid, conflicts: 0 }));
      const dir = await pullDir(db, ctx.app.reposRoot, repo, pull);
      const [state, headOid] = await Promise.all([pullMergeState(dir, pull), liveHead(dir, pull)]);
      return said(`${slug}!${pullN}`, whyPull(ctx.app, repo, pull, { headOid, conflicts: state?.conflicts?.length ?? 0 }));
    }
    return said(slug, whyRepo(ctx.app, repo));
  },
};
