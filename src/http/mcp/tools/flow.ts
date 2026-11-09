import { noteRead, telemetryReader } from "../../../actions/telemetry.ts";
import { getIssue } from "../../../core/issues.ts";
import { getPull, pullDir, pullMergeState } from "../../../core/pulls.ts";
import { canWrite } from "../../../core/repos.ts";
import { mayView } from "../../../core/sealed.ts";
import { whyIssue, whyPull, liveHead, whyRepo, type Why } from "../../../flow/why.ts";
import { countRead } from "../../../system/telemetry_reads.ts";
import { COLUMNS, readSort, sortRows } from "../../../fleet/columns.ts";
import { viewFleet } from "../../../fleet/rows.ts";
import { openBugs } from "../../../flow/bugs.ts";
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
  doc: "with no arguments, the forge's pipeline (a forge admin's, or an agent the owner granted `telemetry:read`; private repositories cut out): per stage counts, `oldestWaiting`, `capacity`, the bottleneck, the merge `queue` and what each reviewer has `reviewing`; with `{ q, sort? }`, the rows a fleet query line selects, as `/fleet` shows them: `{ kind, columns, items }`, only rows you may read, `sort` a column key led by `-` to reverse, a bad line answers its reason; with `{ kind: bugs }`, `{ open, overdue, bugs: [{ repo, number, priority, dueAt }] }` soonest due first, at most 100 (an admin sees all, anyone else public repositories); with `{ repo, issue? or pull? }` (a writer of the repository), why it is not moving: `{ subject, moving, state?, cause, says, clears, next? }`, the first of wall (a person decides new access), ceiling, hot_file, blocked_by, later_gate, no_builder, no_headroom, red_check, waiting_review that holds it (`flow/why.ts`); `repo` alone asks about the repository's builders",
  description:
    "Pipeline (admin); `q`: `/fleet` rows; `kind:bugs`: bugs; `repo`+`issue`/`pull`: why stuck.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["bugs"] },
      q: { type: "string", maxLength: 500 },
      sort: { type: "string" },
      repo: REPO_ARG,
      issue: { type: "integer", minimum: 1 },
      pull: { type: "integer", minimum: 1 },
    },
  },
  writes: false,
  async run(ctx, user, args) {
    if (args["q"] !== undefined) {
      const q = args["q"];
      if (typeof q !== "string" || q.trim() === "" || q.length > 500)
        return bad("invalid", "q is a fleet query line of at most 500 characters, like: repo autonomy:autonomous");
      if (args["sort"] !== undefined && typeof args["sort"] !== "string") return bad("invalid", "sort is a column key");
      // As `/fleet`: the same `viewFleet`, so the same rows for the same viewer.
      const view = viewFleet(ctx.app.db, user, q);
      if (!view.ok) return bad("invalid_query", view.error);
      const asked = args["sort"];
      const sort = asked === undefined || asked === "" ? undefined : readSort(view.kind, asked);
      if (asked !== undefined && asked !== "" && sort === undefined)
        return bad("invalid_sort", "sort is a column of the kind, optionally led by -");
      return good({ kind: view.kind, columns: COLUMNS[view.kind], items: sortRows(view.rows, sort) });
    }
    if (args["kind"] !== undefined) {
      if (args["kind"] !== "bugs") return bad("invalid", "kind is bugs");
      // As the terminal's bugs screen: an admin sees every repository, anyone else public ones.
      const all = openBugs(ctx.app.db, user.isAdmin && user.kind !== "agent" ? {} : { publicOnly: true });
      const now = Date.now();
      const bugs = all.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
      return good({
        open: bugs.length,
        overdue: bugs.filter((b) => Date.parse(b.dueAt) <= now).length,
        bugs: bugs.slice(0, 100).map((b) => ({ repo: b.repo, number: b.number, priority: b.high ? "high" : "low", dueAt: b.dueAt })),
      });
    }
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
