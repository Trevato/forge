import { placeOf, rankIssue } from "../../../actions/next.ts";
import { nextUp, TOP, type NextRow } from "../../../core/next_up.ts";
import { notStartable } from "../../../crew/not_startable.ts";
import { weekView, type WeekView } from "../../../flow/week.ts";
import { sealedScope } from "../../../core/sealed.ts";
import { bad, good, type Tool, APP_ARG, planRepo, isAnswer, issueArg } from "../shared.ts";

const brief = (r: NextRow, week?: WeekView) => ({
  ...(week === undefined
    ? {}
    : {
        estimate: week.priced.find((p) => p.number === r.issue.number)?.estimate,
        thisWeek: week.cut.fits.includes(r.issue.number),
      }),
  issue: r.issue.number,
  title: r.issue.title,
  place: r.place,
  role: r.role,
  roleWhy: r.roleWhy,
  onIt: r.onIt,
  why: r.why,
});

export const tool: Tool = {
  name: "next_up",
  doc: "an app's one ranked list, the crew builds strictly from the top (`app`; with `issue` and `to` — `top`, `not-now` or `after:<number>` — a writer moves that issue and it saves at once; `top` lifts a gated issue past the Later gate; `all` lists beyond the top ten; each row carries its cost `estimate` range and `thisWeek`, and `projection` is one sentence on what the week can ship)",
  description: "The ranked list the crew builds from; `issue` + `to` (top, not-now, after:N) moves one.",
  inputSchema: {
    type: "object",
    properties: {
      app: APP_ARG,
      issue: { type: "integer", minimum: 1 },
      to: { type: "string", pattern: "^(top|not-now|after:[1-9][0-9]{0,8})$" },
      all: { type: "boolean" },
    },
    required: ["app"],
  },
  writes: true,
  readsWithout: "issue",
  run(ctx, user, args) {
    const repo = planRepo(ctx, user, args);
    if (isAnswer(repo)) return repo;
    if (args["issue"] !== undefined) {
      const issue = issueArg(ctx, repo, args, "issue");
      if ("ok" in issue) return issue;
      const place = typeof args["to"] === "string" ? placeOf(args["to"]) : undefined;
      if (place === undefined) return bad("invalid_to", "to is top, not-now or after:<number>");
      const moved = rankIssue(ctx.app, user, repo, issue.number, place);
      if (!moved.ok)
        return bad(moved.error.kind === "not_found" ? "no_such_issue" : moved.error.kind, moved.error.message);
    }
    const scope = sealedScope(ctx.app.db, repo, user);
    const next = nextUp(ctx.app.db, repo, scope, (ready) => notStartable(ctx.app, repo, ready, scope));
    const all = args["all"] === true;
    const week = weekView(ctx.app.db, repo.id, next.rows, new Date());
    return good({
      projection: week.sentence,
      next: (all ? next.rows : next.rows.slice(0, TOP)).map((r) => brief(r, week)),
      more: all ? 0 : Math.max(0, next.rows.length - TOP),
      notNow: next.notNowTotal,
      ...(all ? { notNowRows: next.notNow.map((r) => brief(r)) } : {}),
    });
  },
};
