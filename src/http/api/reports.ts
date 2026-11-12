/**
 * Reports from outside over the API: `POST` and `GET`
 * `/api/v1/repos/:owner/:name/reports`, and `POST` `…/reports/:id/accept`
 * and `…/reports/:id/dismiss`. Filing needs no account and is rate-limited
 * per client; a person decides. Moved out of `api.ts` (#6332); the rules
 * live in `actions/reports.ts`.
 */

import { REPORT_ALREADY_DECIDED } from "../../actions/origin_app_words.ts";
import { REPORT_RECEIVED } from "../../actions/report_words.ts";
import {
  acceptReport,
  dismissReport,
  fileReport,
  reportViews,
  waitingReports,
} from "../../actions/reports.ts";
import { BODY_MAX, REQUEST_MAX, TITLE_MAX, byFiler } from "../../core/reports.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { keyedPage, keyedWindow, loadRepo, originAware, withLabels } from "../api.ts";
import type { Handler } from "../context.ts";
import { holds, weakEtag } from "../etag.ts";
import { clientBucket } from "../peer.ts";
import { proofOf } from "../report_filer.ts";
import {
  apiError,
  body,
  boundedBody,
  json,
  notFound,
  requireScope,
  respondAccess,
  str,
  tryAgain,
} from "../respond.ts";
import type { Router } from "../router.ts";

/** What a refused report is told: the shape that would have been taken. */
const REPORT_HINT =
  "send JSON {title, body?, page?, agent?}: plain text, " +
  `a title of 1-${TITLE_MAX} characters, a body of at most ${BODY_MAX}, ` +
  "page an http(s) address, agent a name of letters, digits, . _ - " +
  "(a claim unless a token proves it)";

/** A full queue drains as the crew reads reports; no clock says when, so a minute. */
const REPORT_QUEUE_RETRY = 60;

export function reportRoutes(router: Router<Handler>): void {
  // ── reports from outside — no account, a person decides ──────────────

  router.add("POST", "/api/v1/repos/:owner/:name/reports", async (ctx) => {
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await boundedBody(ctx.request, REQUEST_MAX);
    if (input === "too_large")
      return json({ error: "too_large", message: REPORT_HINT }, 413);
    const filed = fileReport(
      ctx.app,
      repo,
      {
        title: str(input.title),
        body: str(input.body),
        page: str(input.page),
        agent: str(input.agent),
      },
      clientBucket(ctx.request),
      proofOf(ctx),
    );
    if (!filed.ok) {
      const refusal = filed.error;
      if (refusal.error === "not_found") return notFound();
      if (refusal.error === "rate_limited")
        return tryAgain("rate_limited", 429, "too many reports; wait and send again", refusal.retryAfter);
      if (refusal.error === "queue_full")
        return tryAgain("queue_full", 429, "this repository has many reports waiting; try again later", REPORT_QUEUE_RETRY);
      return apiError(refusal.error, 422, REPORT_HINT);
    }
    return json(
      {
        id: filed.value.id,
        state: filed.value.state,
        filedBy: filed.value.filedBy,
        message: REPORT_RECEIVED,
      },
      202,
    );
  });

  // Reading the words is a writer's act, so a read-only token — the one an
  // app process holds for its owner — cannot fetch them.
  router.add("GET", "/api/v1/repos/:owner/:name/reports", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const window = keyedWindow(ctx);
    if (window instanceof Response) return window;
    const waiting = timePhase(ctx.request, "reports", () =>
      waitingReports(ctx.app, ctx.auth.user, repo),
    );
    if (!waiting.ok) return respondAccess(waiting.error, 403);
    return timePhase(ctx.request, "render", () => {
      const text = JSON.stringify({
        ...keyedPage(
          reportViews(ctx.app, repo, waiting.value),
          (r) => r.id,
          window,
        ),
        // Every waiting report's filer, not only this page's.
        byAgent: byFiler(waiting.value),
      });
      // The tag is of the exact bytes sent: a report filed, answered or out
      // of the window moves it, and each window has its own. Only a writer
      // reaches here, so every viewer who may ask is shown the same body.
      const etag = weakEtag(text);
      const headers = {
        etag,
        "cache-control": "private, no-cache",
        vary: "authorization, cookie",
      };
      if (holds(ctx.request, etag))
        return new Response(null, { status: 304, headers });
      return new Response(text, {
        headers: { "content-type": "application/json", ...headers },
      });
    });
  });

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/reports/:id/accept",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      // `{ title }` is the accepting person's wording; the marker stays.
      const { title } = await body(ctx.request);
      const accepted = await acceptReport(
        ctx.app,
        ctx.auth.user,
        repo,
        ctx.params.id ?? "",
        typeof title === "string" ? title : undefined,
      );
      if (!accepted.ok)
        return accepted.error === "decided"
          ? apiError("decided", 409, REPORT_ALREADY_DECIDED)
          : originAware(accepted.error);
      return json(withLabels(ctx, accepted.value), 201);
    },
  );

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/reports/:id/dismiss",
    (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      const dismissed = dismissReport(
        ctx.app,
        ctx.auth.user,
        repo,
        ctx.params.id ?? "",
      );
      if (!dismissed.ok)
        return dismissed.error === "decided"
          ? apiError("decided", 409, REPORT_ALREADY_DECIDED)
          : respondAccess(dismissed.error, 403);
      return json({ id: ctx.params.id, state: "dismissed" });
    },
  );
}
