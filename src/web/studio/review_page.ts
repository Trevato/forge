/**
 * `/review`: every ask waiting on the viewer as one row — the title, the
 * repository, how long it has waited and why a person must decide — newest
 * decision first. Read from the same candidates the asks page reads
 * (`waitingOn`); no polling, and nothing here changes anything.
 */

import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { listReposVisibleTo } from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { repoBase, signInFirst } from "../chrome.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";
import { empty, listCard, row, time } from "../ui.ts";
import { waitingOn } from "./asks.ts";

export function reviewPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const user = ctx.auth.user;
  if (!user) return signInFirst(ctx);
  const asks = timePhase(ctx.request, "asks", () => {
    const repos = listReposVisibleTo(ctx.app.db, user, { limit: 200, withoutArchived: true });
    return waitingOn(ctx.app.db, user, repos).sort((a, b) => Date.parse(b.since) - Date.parse(a.since));
  });
  const rendering = performance.now();
  const rows = asks.map((a) => {
    const base = repoBase(a.repo);
    const href =
      a.pull !== undefined
        ? `${base}/pulls/${a.pull.number}`
        : a.issue !== undefined
        ? `${base}/issues/${a.issue.number}`
        : base;
    return row({
      href,
      nav: true,
      title: a.pull?.title ?? a.issue?.title ?? a.proposal?.title ?? `${a.repo.name} is waiting on you`,
      titleAttr: `${a.repo.ownerName}/${a.repo.name}: ${a.why ?? a.consequence.why}`,
      meta: html`${a.repo.ownerName}/${a.repo.name} · ${time(a.since)} · ${a.why ?? a.consequence.why}`,
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
