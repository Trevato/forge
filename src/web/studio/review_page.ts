/**
 * `/review`: every ask waiting on the viewer as one row — the title, the
 * repository, how long it has waited and why a person must decide, and what the crew advises — newest
 * decision first. Read from the same candidates the asks page reads
 * (`waitingOn`); no polling, and nothing here changes anything.
 */

import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { previewEnv } from "../../apps/data.ts";
import { recommendationsFor } from "../../core/pull_wait.ts";
import { appsForRepos } from "../../core/apps.ts";
import { latestRunsForIssues, type Run } from "../../core/runs.ts";
import { listReposVisibleTo } from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { repoBase, signInFirst } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { badge, empty, listCard, row, runStateBadge, time } from "../ui.ts";
import { waitingOn } from "./asks.ts";
import { diffStatFor, sizeLine } from "./review_evidence.ts";

/** The check on a pull's head, as the pull page wears it; only a run of this very head counts. */
function verdict(run: Run | undefined, headOid: string): Html {
  return run === undefined || run.commitOid !== headOid
    ? badge("No check", { variant: "outline" })
    : runStateBadge(run.state, "check");
}

export function reviewPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const user = ctx.auth.user;
  if (!user) return signInFirst(ctx);
  const asks = timePhase(ctx.request, "asks", () => {
    const repos = listReposVisibleTo(ctx.app.db, user, { limit: 200, withoutArchived: true });
    return waitingOn(ctx.app.db, user, repos).sort((a, b) => Date.parse(b.since) - Date.parse(a.since));
  });
  const rendering = performance.now();
  const advice = recommendationsFor(
    ctx.app.db,
    asks.flatMap((a) => {
      const id = a.pull?.id ?? a.issue?.id;
      return id === undefined ? [] : [id];
    }),
  );
  const checks = latestRunsForIssues(
    ctx.app.db,
    asks.flatMap((a) => (a.pull === undefined ? [] : [a.pull.id])),
    ["check"],
  );
  const apps = appsForRepos(ctx.app.db, asks.map((a) => a.repo.id));
  const rows = asks.map((a) => {
    const base = repoBase(a.repo);
    const href =
      a.pull !== undefined
        ? `${base}/pulls/${a.pull.number}`
        : a.issue !== undefined
        ? `${base}/issues/${a.issue.number}`
        : base;
    const rec = advice.get((a.pull?.id ?? a.issue?.id) ?? "");
    const advised =
      rec === undefined
        ? "The crew has not advised yet"
        : html`The crew advises: ${rec.verdict}${rec.reason === "" ? "" : html` — ${rec.reason}`}`;
    const stat = a.pull === undefined ? undefined : diffStatFor(ctx.app, a.repo, a.pull);
    const pending =
      stat === "loading"
        ? " · Diff loading — reload for the size"
        : stat === "failed"
        ? " · Diff size unavailable — open the pull to see it"
        : "";
    return row({
      href,
      nav: true,
      title: a.pull?.title ?? a.issue?.title ?? a.proposal?.title ?? `${a.repo.name} is waiting on you`,
      titleAttr: `${a.repo.ownerName}/${a.repo.name}: ${a.why ?? a.consequence.why}`,
      meta: html`${a.repo.ownerName}/${a.repo.name} · ${time(a.since)} · ${a.why ?? a.consequence.why} · ${advised}${pending}`,
      // The trail survives the meta line's ellipsis: the verdict and the size are the facts this row gives.
      ...(a.pull === undefined
        ? {}
        : {
            trail: html`${typeof stat === "object" ? html`<span class="small muted">${sizeLine(stat)}</span> ` : ""}${verdict(checks.get(a.pull.id), a.pull.headOid)}`,
          }),
      // A sibling of the row's link, never inside it: a link in a link is not a link.
      ...(a.pull !== undefined && apps.has(a.repo.id)
        ? { children: [row({ href: `${base}/app/${previewEnv(a.pull.number)}/open`, title: "Open the preview", nav: true })] }
        : {}),
    });
  });
  const body = html`<h1>Review</h1>
    <p class="muted">${asks.length === 0 ? "All fine" : `${asks.length} ${asks.length === 1 ? "ask" : "asks"}, newest first`}</p>
    ${rows.length === 0
      ? empty({
          icon: "issue",
          title: "Nothing to review",
          note: "When the crew needs a person, it shows up here.",
          action: html`<a class="btn" href="/asks">All asks</a>`,
        })
      : html`${listCard(rows)}<p class="small muted"><a href="/asks">All asks, with their buttons</a></p>`}`;
  const response = page({ ctx, title: "Review", body });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}
