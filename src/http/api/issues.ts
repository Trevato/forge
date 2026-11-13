/**
 * An issue over the API: `GET` and `POST` `/api/v1/repos/:owner/:name/issues`,
 * one issue read and changed at `…/issues/:number`, its thread, labels,
 * teams, private fix repository and dependencies. Moved out of `api.ts`
 * (#7450); the rules live in `actions/issues.ts` and its neighbours.
 */

import { holds, weakEtag } from "../etag.ts";
import { ISSUE_TEAMS_SAY, nameTeams } from "../../actions/issue_teams.ts";
import { askEstimate, recordEstimate } from "../../actions/estimates.ts";
import { estimatesOf } from "../../core/estimates.ts";
import { confirmIssue, dependencyWords, linkIssue, unlinkIssue } from "../../actions/dependencies.ts";
import {
  addCommentThrough,
  closingFrom,
  editIssue,
  openIssueThrough,
  setIssueLabelsThrough,
  setIssueSealed,
  plannerCloseRefusal,
  setIssueStateThrough,
} from "../../actions/issues.ts";
import { PLAN_SHAPE, readPlan, setPlan } from "../../actions/run_plan.ts";
import { privateRepoForSealed } from "../../actions/repos.ts";
import { dependenciesOf } from "../../core/dependencies.ts";
import { teamsOfIssue } from "../../core/issue_teams.ts";
import {
  countThread,
  EMBEDDED_COMMENTS,
  getIssue,
  listComments,
  listIssues,
  type Issue,
} from "../../core/issues.ts";
import { canRead } from "../../core/repos.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { mayView, sealedScope } from "../../core/sealed.ts";
import {
  listQuery,
  loadConversation,
  loadPull,
  loadRepo,
  NOTHING_TO_CHANGE,
  originAware,
  positiveInt,
  readerMarked,
  reportInstead,
  takenUp,
  textFrom,
  withLabels,
  withLabelsMany,
  type Found,
} from "../api.ts";
import type { Ctx, Handler } from "../context.ts";
import { apiError, body, json, notFound, paged, requireScope, respondAccess, str } from "../respond.ts";
import type { Router } from "../router.ts";

/** An issue for a listing: what to pick from, without bodies. */
function briefIssue(i: ReturnType<typeof withLabelsMany>[number]) {
  return {
    number: i.number,
    kind: i.kind,
    title: i.title,
    state: i.state,
    labels: i.labels,
    assignee: i.assigneeName,
    author: i.originAuthor ?? i.authorName,
    originAuthor: i.originAuthor,
    ...(i.untrusted === undefined ? {} : { untrusted: i.untrusted }),
    authorIsAgent: i.authorIsAgent,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

function loadIssue(ctx: Ctx): Found<{ issue: Issue }> {
  const found = loadConversation(ctx);
  if ("error" in found) return found;
  return found.issue.kind === "issue" ? found : { error: notFound() };
}

// Replace the label set of an issue or a pull — both live in one table, so
// either number works here. Names or ids; an unknown label rejects the set.
export async function labelsHandler(ctx: Ctx): Promise<Response> {
  const denied = requireScope(ctx, "rw");
  if (denied) return denied;
  const found = loadConversation(ctx);
  if ("error" in found) return found.error;
  const input = await body(ctx.request);
  const labels = Array.isArray(input.labels)
    ? input.labels.filter((l): l is string => typeof l === "string")
    : [];
  const set = await setIssueLabelsThrough(
    ctx.app,
    ctx.auth.user,
    found.repo,
    found.issue,
    labels,
  );
  if (!set.ok) return originAware(set.error);
  return json(set.value);
}

/**
 * A reader-scoped JSON answer tagged by its exact bytes: a repeat holding the
 * tag gets 304. Callers check access first, so a 304 confirms nothing to
 * someone who may not read it.
 */
function tagged(request: Request, text: string): Response {
  const etag = weakEtag(text);
  const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
  if (holds(request, etag)) return new Response(null, { status: 304, headers });
  return new Response(text, { headers: { "content-type": "application/json", ...headers } });
}

export function issueRoutes(router: Router<Handler>): void {
  router.add(
    "PUT",
    "/api/v1/repos/:owner/:name/issues/:number/labels",
    labelsHandler,
  );

  // Name up to two crew teams on an issue: the pull that closes it is
  // reviewed by each (`core/issue_teams.ts`).
  router.add("GET", "/api/v1/repos/:owner/:name/issues/:number/teams", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const found = loadIssue(ctx);
    if ("error" in found) return found.error;
    const teams = timePhase(ctx.request, "teams", () => teamsOfIssue(ctx.app.db, found.issue.id));
    return timePhase(ctx.request, "render", () => json({ teams }));
  });
  router.add("PUT", "/api/v1/repos/:owner/:name/issues/:number/teams", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const found = loadIssue(ctx);
    if ("error" in found) return found.error;
    const input = await body(ctx.request);
    const slugs = Array.isArray(input.teams) ? input.teams : undefined;
    if (slugs === undefined || !slugs.every((t): t is string => typeof t === "string"))
      return json({ error: "teams must be a list of team slugs" }, 400);
    const set = nameTeams(ctx.app, ctx.auth.user, found.repo, found.issue, slugs);
    if (!set.ok)
      return set.error === "too_many" || set.error === "no_such_team"
        ? apiError(set.error, 422, ISSUE_TEAMS_SAY[set.error]!)
        : originAware(set.error);
    return json({ teams: set.value });
  });

  router.add("GET", "/api/v1/repos/:owner/:name/issues", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const fields = ctx.url.searchParams.get("fields");
    if (fields !== null && fields !== "brief")
      return apiError("invalid_fields", 422, "fields must be brief, or left out");
    const query = listQuery(ctx);
    if (query instanceof Response) return query;
    const listed = timePhase(ctx.request, "list", () =>
      listIssues(ctx.app.db, repo.id, {
        ...query,
        kind: "issue",
        ...sealedScope(ctx.app.db, repo, ctx.auth.user),
      }),
    );
    const items = timePhase(ctx.request, "labels", () => withLabelsMany(ctx, listed));
    return timePhase(ctx.request, "render", () => {
      const page = paged(items, query.limit, (i) => i.number);
      const text = JSON.stringify(
        fields === "brief" ? { ...page, items: page.items.map(briefIssue) } : page,
      );
      // Scoped by who asks (sealed issues), so private to the reader; the tag
      // is of the exact bytes sent, so each page, state and fields value has its own.
      return tagged(ctx.request, text);
    });
  });

  router.add("POST", "/api/v1/repos/:owner/:name/issues", async (ctx) => {
    // A stranger on a public repository is told the door that is open to
    // them, in the body and as a link relation, not only that this one is shut.
    if (ctx.auth.user === undefined) {
      const repo = loadRepo(ctx);
      if (repo !== undefined && canRead(ctx.app.db, repo, undefined))
        return reportInstead(ctx, repo);
    }
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const created = await openIssueThrough(ctx.app, ctx.auth.user, repo, {
      title: str(input.title),
      body: str(input.body),
      ...(input.sealed === true ? { sealed: true } : {}),
    });
    if (!created.ok) return originAware(created.error);
    return json(withLabels(ctx, created.value), 201);
  });

  // The plan a crew run keeps on its issue: replaced whole at each update (#8707).
  router.add("GET", "/api/v1/repos/:owner/:name/issues/:number/plan", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const found = loadIssue(ctx);
    if ("error" in found) return found.error;
    return json({ plan: readPlan(ctx.app, found.repo, ctx.auth.user, found.issue) ?? null });
  });
  router.add("PUT", "/api/v1/repos/:owner/:name/issues/:number/plan", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const found = loadIssue(ctx);
    if ("error" in found) return found.error;
    const input = await body(ctx.request);
    const set = setPlan(ctx.app, ctx.auth.user, found.repo, found.issue, { items: input.items, ask: input.ask });
    if (!set.ok)
      return set.error === "invalid" ? apiError("invalid", 422, PLAN_SHAPE) : originAware(set.error);
    return json({ plan: set.value });
  });

  router.add("GET", "/api/v1/repos/:owner/:name/issues/:number", (ctx) => {
    // Numbers are shared with pulls: a pull's number answers as the same
    // shape, marked `kind: "pull"`, with the path where its diff lives (#3299).
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const found = timePhase(ctx.request, "issue", () => loadConversation(ctx));
    if ("error" in found) return found.error;
    const { repo, issue } = found;
    // The newest 50 comments, oldest first, and a cursor for the older rest
    // (#6198); comments=N (0 to 200) asks for another count (#4097).
    const asked = ctx.url.searchParams.get("comments");
    let tail = EMBEDDED_COMMENTS;
    if (asked !== null) {
      if (!/^\d{1,3}$/.test(asked) || Number(asked) > 200)
        return apiError("invalid_comments", 422, "comments must be a whole number from 0 to 200");
      tail = Number(asked);
    }
    const { total, shown } = timePhase(ctx.request, "comments", () => {
      const rows =
        tail === 0
          ? []
          : listComments(ctx.app.db, found.issue.id, { newest: true, limit: tail });
      return {
        total: countThread(ctx.app.db, found.issue.id),
        shown: readerMarked(ctx, found.repo.id, rows),
      };
    });
    const labelled = timePhase(ctx.request, "labels", () => withLabels(ctx, issue));
    return timePhase(ctx.request, "render", () =>
      tagged(ctx.request, JSON.stringify({
        ...labelled,
        ...(issue.kind === "pull"
          ? {
              pull: `/api/v1/repos/${repo.ownerName}/${repo.name}/pulls/${issue.number}`,
            }
          : {}),
        plan: readPlan(ctx.app, found.repo, ctx.auth.user, issue) ?? null,
        comments: shown,
        commentsTotal: total,
        commentsNext: shown.length > 0 && shown.length < total ? shown[0]!.id : null,
        ...(asked === null ? {} : { commentCount: total }),
      })),
    );
  });

  // A thread, a page at a time: oldest first, `next` is the `after` of the
  // following page (#4150). A pull's number answers the same.
  router.add("GET", "/api/v1/repos/:owner/:name/issues/:number/comments", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const found = loadConversation(ctx);
    if ("error" in found) return found.error;
    const rawLimit = ctx.url.searchParams.get("limit");
    const limit = rawLimit === null ? 50 : /^\d{1,4}$/.test(rawLimit) ? Number(rawLimit) : 0;
    if (limit < 1 || limit > 100)
      return apiError("invalid_limit", 422, "limit is a whole number from 1 to 100");
    const after = ctx.url.searchParams.get("after");
    if (after !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(after))
      return apiError("invalid_after", 422, "after is a comment id");
    // `cursor` is what an issue's `commentsNext` hands over: the page just
    // older than that comment, still oldest first, and `next` the cursor of
    // the page older again (null at the first comment) (#6198).
    const cursor = ctx.url.searchParams.get("cursor");
    if (cursor !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(cursor))
      return apiError("invalid_cursor", 422, "cursor is a comment id from commentsNext");
    if (cursor !== null && after !== null)
      return apiError("invalid_cursor", 422, "cursor and after are two ways to page: send one");
    if (cursor !== null) {
      const older = timePhase(ctx.request, "comments", () =>
        listComments(ctx.app.db, found.issue.id, { before: cursor, newest: true, limit: limit + 1 }),
      );
      const page = older.slice(older.length - Math.min(limit, older.length));
      return timePhase(ctx.request, "render", () =>
        tagged(
          ctx.request,
          JSON.stringify({
            comments: readerMarked(ctx, found.repo.id, page),
            next: older.length > limit ? page[0]!.id : null,
          }),
        ),
      );
    }
    const { rows, page } = timePhase(ctx.request, "comments", () => {
      const read = listComments(ctx.app.db, found.issue.id, {
        limit: limit + 1,
        ...(after === null ? {} : { after }),
      });
      return { rows: read, page: read.slice(0, limit) };
    });
    return timePhase(ctx.request, "render", () =>
      tagged(
        ctx.request,
        JSON.stringify({
          comments: readerMarked(ctx, found.repo.id, page),
          next: rows.length > limit ? page[page.length - 1]!.id : null,
        }),
      ),
    );
  });

  // What an issue waits for, and what waits for it.
  // The private repository a writer fixes a sealed report in by hand (#865).
  router.add("POST", "/api/v1/repos/:owner/:name/issues/:number/private", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const found = loadIssue(ctx);
    if ("error" in found) return found.error;
    const made = await privateRepoForSealed(ctx.app, ctx.auth.user, found.repo, found.issue);
    if (!made.ok)
      return made.error === "not_found"
        ? notFound()
        : respondAccess(made.error, 422);
    const there = `${made.value.ownerName}/${made.value.name}`;
    return json({ repo: there, clone: `${ctx.url.origin}/${there}.git` }, 201);
  });

  // Estimates (#11955): GET asks the base rate; POST records one.
  router.add("GET", "/api/v1/repos/:owner/:name/issues/:number/estimates", (ctx) => {
    const found = loadIssue(ctx);
    if ("error" in found) return found.error;
    return json({
      ...askEstimate(ctx.app, ctx.auth.user, found.repo, found.issue),
      revisions: estimatesOf(ctx.app.db, found.issue.id),
    });
  });
  router.add("POST", "/api/v1/repos/:owner/:name/issues/:number/estimates", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const found = loadIssue(ctx);
    if ("error" in found) return found.error;
    if (ctx.auth.user === undefined) return apiError("unauthorized", 401, "sign in to record an estimate");
    const input = await body(ctx.request);
    const made = recordEstimate(ctx.app, ctx.auth.user, found.repo, found.issue, input);
    return made.ok
      ? json(made.value, 201)
      : apiError(made.error.kind, made.error.kind === "forbidden" ? 403 : 422, made.error.message);
  });
  router.add(
    "GET",
    "/api/v1/repos/:owner/:name/issues/:number/dependencies",
    (ctx) => {
      notePhase(ctx.request, "session", takeSessionTime(ctx.request));
      const found = loadIssue(ctx);
      if ("error" in found) return found.error;
      const deps = timePhase(ctx.request, "dependencies", () =>
        dependenciesOf(ctx.app.db, found.issue.id),
      );
      const seen = (i: Issue) =>
        mayView(ctx.app.db, found.repo, i, ctx.auth.user);
      const brief = (i: Issue) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        ...(i.closeReason === null ? {} : { closeReason: i.closeReason }),
      });
      return timePhase(ctx.request, "render", () =>
        json({
          blockedBy: deps.blockedBy.filter(seen).map(brief),
          blocks: deps.blocks.filter(seen).map(brief),
        }),
      );
    },
  );
  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/issues/:number/dependencies",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const found = loadIssue(ctx);
      if ("error" in found) return found.error;
      const input = await body(ctx.request);
      const number = Number(input.blockedBy);
      const blocker =
        Number.isInteger(number) && number > 0
          ? getIssue(ctx.app.db, found.repo.id, number)
          : undefined;
      if (!blocker)
        return apiError(
          "no_such_issue",
          422,
          `no issue #${String(input.blockedBy)}`,
        );
      const linked = linkIssue(
        ctx.app,
        ctx.auth.user,
        found.repo,
        found.issue,
        blocker,
      );
      if (!linked.ok)
        return ["self", "cycle", "cross_repo", "not_an_issue"].includes(
          linked.error,
        )
          ? apiError(linked.error, 422, dependencyWords[linked.error] ?? "")
          : respondAccess(linked.error, 422);
      return json(
        { issue: found.issue.number, blockedBy: blocker.number },
        201,
      );
    },
  );
  router.add(
    "DELETE",
    "/api/v1/repos/:owner/:name/issues/:number/dependencies/:blocker",
    (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const found = loadIssue(ctx);
      if ("error" in found) return found.error;
      const number = positiveInt(ctx.params.blocker);
      const blocker =
        number === undefined
          ? undefined
          : getIssue(ctx.app.db, found.repo.id, number);
      if (!blocker) return notFound();
      const unlinked = unlinkIssue(
        ctx.app,
        ctx.auth.user,
        found.repo,
        found.issue,
        blocker,
      );
      if (!unlinked.ok) return respondAccess(unlinked.error, 422);
      return new Response(null, { status: 204 });
    },
  );
  // A person confirms an edge whose blocker closed dropped or split: the
  // plan still holds, so the dependent is no longer parked on it.
  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/issues/:number/dependencies/:blocker/confirm",
    (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const found = loadIssue(ctx);
      if ("error" in found) return found.error;
      const number = positiveInt(ctx.params.blocker);
      const blocker =
        number === undefined
          ? undefined
          : getIssue(ctx.app.db, found.repo.id, number);
      if (!blocker) return notFound();
      const confirmed = confirmIssue(
        ctx.app,
        ctx.auth.user,
        found.repo,
        found.issue,
        blocker,
      );
      if (!confirmed.ok) return respondAccess(confirmed.error, 422);
      return new Response(null, { status: 204 });
    },
  );

  router.add(
    "PATCH",
    "/api/v1/repos/:owner/:name/issues/:number",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const found = loadIssue(ctx);
      if ("error" in found) return found.error;
      const input = await body(ctx.request);
      // Three acts a PATCH may carry, each its own authorization and each
      // alone a whole request: sealing (a writer's), new words, a new state.
      let issue = found.issue;
      if (typeof input.sealed === "boolean") {
        const sealed = setIssueSealed(
          ctx.app,
          ctx.auth.user,
          found.repo,
          issue,
          input.sealed,
        );
        if (!sealed.ok) return originAware(sealed.error, 409);
        issue = sealed.value;
      }
      const text = textFrom(input);
      if (text === undefined) return json({ error: "invalid_text" }, 422);
      const wanted = input.state === undefined ? undefined : str(input.state);
      if (wanted !== undefined && wanted !== "open" && wanted !== "closed")
        return json({ error: "invalid_state" }, 422);
      if (
        wanted === undefined &&
        text.title === undefined &&
        text.body === undefined
      )
        return typeof input.sealed === "boolean"
          ? json(withLabels(ctx, issue))
          : NOTHING_TO_CHANGE();
      if (text.title !== undefined || text.body !== undefined) {
        const edited = editIssue(
          ctx.app,
          ctx.auth.user,
          found.repo,
          issue,
          text,
        );
        if (!edited.ok)
          return edited.error === "taken_up"
            ? takenUp()
            : originAware(edited.error, 422);
        issue = edited.value;
      }
      if (wanted !== undefined) {
        const closing = closingFrom(input);
        if (closing === undefined)
          return json({ error: "invalid_reason" }, 422);
        const changed = await setIssueStateThrough(
          ctx.app,
          ctx.auth.user,
          found.repo,
          issue,
          wanted,
          closing,
        );
        if (!changed.ok) {
          // A planner told no learns which rule refused it.
          const rule =
            changed.error === "forbidden" && wanted === "closed" && ctx.auth.user
              ? plannerCloseRefusal(ctx.app, found.repo, issue, ctx.auth.user, closing)
              : undefined;
          if (rule !== undefined) return apiError("forbidden", 403, rule);
          return originAware(changed.error, 409);
        }
        issue = changed.value;
      }
      return json(withLabels(ctx, issue));
    },
  );

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/issues/:number/comments",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      // A pull's number answers here too, as the OpenAPI document says.
      const issueFound = loadIssue(ctx);
      const found =
        "error" in issueFound
          ? loadPull(ctx)
          : { repo: issueFound.repo, thread: issueFound.issue };
      if ("error" in found) return found.error;
      const input = await body(ctx.request);
      const added = await addCommentThrough(
        ctx.app,
        ctx.auth.user,
        found.repo,
        "thread" in found ? found.thread : found.pull,
        str(input.body),
      );
      if (!added.ok) return originAware(added.error);
      return json(added.value, 201);
    },
  );
}
