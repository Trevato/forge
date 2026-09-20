/**
 * The home in the studio: what asks you first, then every app as a shelf
 * row (`shelf.ts` draws those — the row is not this page's to decide), and
 * beside it what is happening right now across all of them, and what a
 * person put on you. Built from the same rows and cards as the rest of the
 * forge, from grouped reads only, so the page does not get slower as the
 * apps grow.
 */

import { canSeeOwnerFacts, type Repo } from "../../core/repos.ts";
import { listActiveRuns } from "../../core/runs.ts";
import { getUsersByIds, type User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { repoBase } from "../chrome.ts";
import { asksJs, liveRegionsJs } from "../client.ts";
import { html, when } from "../html.ts";
import { page } from "../layout.ts";
import { liveClientJs } from "../live.ts";
import { btn, card, empty, icon, listCard, row, time } from "../ui.ts";
import { onYouCard } from "../pages/site.ts";
import { appsOf, asksPanel, decisionsFor } from "./asks.ts";
import { withLikely } from "./leans.ts";
import { stopForm } from "./run.ts";
import { shelfRows } from "./shelf.ts";
import { studioCss } from "./style.ts";

/**
 * The home in the studio: what asks you first, then your apps as a shelf of
 * rows — and beside it what is happening right now across all of them, and
 * what a person put on you. Built from the same rows and cards as the rest
 * of the forge, so it reads as the forge.
 */
export async function studioHome(ctx: Ctx, user: User): Promise<Response> {
  const db = ctx.app.db;
  const { repos: appRepos } = appsOf(ctx, user);
  // Read once, shown twice: the panel below is these same asks, and the
  // shelf counts them into each row's pill.
  const decisions = withLikely(ctx, decisionsFor(ctx, appRepos));
  const appRows = await shelfRows(ctx, appRepos, { decisions });

  const apps =
    appRows.length === 0
      ? empty({
          icon: "rocket",
          title: "No apps yet",
          note: "Make one, tell the crew what it is, and watch it come up.",
          action: btn("New app", { href: "/apps/new", variant: "primary" }),
        })
      : listCard(appRows, {
          head: html`${icon("rocket")}
            <h2>Your apps</h2>
            <span class="spacer"></span>
            ${btn("Map", { href: "/map", size: "sm", icon: "map" })}
            ${btn("New app", { href: "/apps/new", size: "sm", icon: "plus" })}`,
        });

  const asks = when(decisions.length > 0, () => asksPanel(ctx, decisions, "/"));

  // Happening now: every run in flight across the apps, one read.
  const running = listActiveRuns(
    db,
    appRepos.map((r) => r.id),
  );
  const runActors = getUsersByIds(
    db,
    running.map((r) => r.actorId).filter((id): id is string => id !== null),
  );
  const byId = new Map(appRepos.map((r) => [r.id, r]));
  // Who is working is the owner's fact, not a stranger's to read — the same
  // predicate the shelf row uses, asked only of the apps with a run in
  // flight.
  const ownerFacts = new Set(
    [...new Set(running.map((r) => r.repoId))]
      .map((id) => byId.get(id))
      .filter((r): r is Repo => r !== undefined)
      .filter((r) => canSeeOwnerFacts(db, r, user))
      .map((r) => r.id),
  );
  // The board: the same runs as a wall for a second monitor.
  const nowHead = html`${icon("activity")}
    <h2>Happening now</h2>
    <span class="spacer"></span>
    ${btn("Focus", {
      href: "/board",
      size: "sm",
      title: "The board: a live wall of the crews at work",
    })}`;
  const now =
    running.length === 0
      ? card(html`<p class="muted small">Nobody is working right now.</p>`, {
          head: nowHead,
        })
      : listCard(
          running.map((r) => {
            const repo = byId.get(r.repoId)!;
            const actorName =
              r.actorId === null
                ? "crew"
                : (runActors.get(r.actorId)?.username ?? "crew");
            const who = ownerFacts.has(repo.id) ? actorName : "the crew";
            const stop = stopForm(ctx, repo, r);
            return row({
              ...(stop
                ? {}
                : { href: `${repoBase(repo)}/runs/${r.id}`, nav: true }),
              lead: icon(r.state === "running" ? "loader" : "clock"),
              title: html`<a href="${repoBase(repo)}/runs/${r.id}"
                >${who} · ${repo.name}</a
              >`,
              meta: html`${r.state === "running"
                ? "working"
                : "waiting"}${r.startedAt
                ? html` since ${time(r.startedAt)}`
                : null}`,
              ...(stop
                ? {
                    trail: html`<span class="studio-ask-actions"
                      >${stop}</span
                    >`,
                  }
                : {}),
            });
          }),
          { head: nowHead },
        );

  const body = html`<div class="dash">
    <div class="dash-main stack">
      <div id="live-asks" data-live="run.*,pull.*,issue.*,check.*">${asks}</div>
      <div
        id="live-apps"
        data-live="app.serving,app.stopped,run.queued,run.started,run.finished,pull.opened,pull.closed,pull.merged"
      >
        ${apps}
      </div>
    </div>
    <aside class="dash-rail stack">
      <div id="live-now" data-live="run.*">${now}</div>
      <div
        id="live-on-you"
        data-live="issue.assigned,pull.assigned,issue.closed,pull.closed,issue.reopened,pull.reopened,pull.merged"
      >
        ${onYouCard(ctx, user) ?? null}
      </div>
    </aside>
  </div>`;
  return page({
    ctx,
    title: "Studio",
    body,
    styleCss: studioCss,
    scriptJs: `${liveClientJs}\n${liveRegionsJs}\n${asksJs}`,
  });
}
