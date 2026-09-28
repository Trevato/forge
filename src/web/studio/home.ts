/**
 * The home in the studio: every app as a shelf
 * row (`shelf.ts` draws those — the row is not this page's to decide), and
 * beside it what is happening right now across all of them, and what a
 * person put on you. Built from the same rows and cards as the rest of the
 * forge, from grouped reads only, so the page does not get slower as the
 * apps grow.
 */

import { appsRuntime } from "../../apps/runtime.ts";
import { crewForRepos } from "../../core/agents.ts";
import { openPullsForRepos, type Pull } from "../../core/pulls.ts";
import { listActiveRuns } from "../../core/runs.ts";
import { getUsersByIds, type User } from "../../core/users.ts";
import { isPausedAtCeiling, spentTodayForRepos } from "../../crew/autonomy.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { repoBase } from "../chrome.ts";
import { liveRegionsJs } from "../client.ts";
import { html, when } from "../html.ts";
import { page } from "../layout.ts";
import { liveClientJs } from "../live.ts";
import { btn, card, empty, icon, listCard, row, time } from "../ui.ts";
import { onYouCard } from "../pages/site.ts";
import { writableAppsOf } from "./asks.ts";
import { changeHref } from "./nouns.ts";
import { stopForm } from "./run.ts";
import { productionFactsForRepos, shelfRows } from "./shelf.ts";
import { pullWord, servingHistory, wordBadge, type WordCtx } from "./words.ts";

/**
 * The home in the studio: your apps as a shelf of
 * rows — and beside it what is happening right now across all of them, and
 * what a person put on you. Built from the same rows and cards as the rest
 * of the forge, so it reads as the forge.
 */
export async function studioHome(ctx: Ctx, user: User): Promise<Response> {
  const db = ctx.app.db;
  // The front door leads with what the viewer can write — their own apps
  // and their organisations' — never widened by a stranger's public app
  // (`writableAppsOf`, not the visibility every reader gets from `appsOf`).
  const { repos: appRepos, records } = writableAppsOf(ctx, user);
  const runtime = appsRuntime(ctx.app);
  // Read once, shown twice again: a shipped or failed deploy is a row's own
  // word, and — when nothing is running and no change waits — the rail's.
  const productionFacts = productionFactsForRepos(ctx, appRepos);
  // One memo of production's history for every word on this page: the
  // shelf's rows and the Now list below ask it once per repository.
  const history = servingHistory();
  const appRows = await shelfRows(ctx, appRepos, {
    productionFacts,
    history,
  });

  // What the crew cost today across every app on the shelf, and how many
  // are paused at their ceiling right now — the owner's first question at
  // the front door, in one bounded read each (`spentTodayForRepos`,
  // `crewForRepos`), never a query or an `autonomyStatus` call per app.
  // Every app here is already one the viewer can write, so no further
  // filter is needed to keep the money to the owner's own.
  const costLine = when(appRepos.length > 0, () => {
    const spentToday = spentTodayForRepos(
      db,
      appRepos.map((r) => r.id),
    );
    const crew = crewForRepos(
      db,
      appRepos.map((r) => r.id),
    );
    const spentUsd = appRepos.reduce(
      (sum, r) => sum + (spentToday.get(r.id) ?? 0),
      0,
    );
    const paused = appRepos.filter((r) =>
      isPausedAtCeiling(r, crew, spentToday),
    ).length;
    const noun = `app${appRepos.length === 1 ? "" : "s"}`;
    const sentence = `$${spentUsd.toFixed(2)} spent today across ${appRepos.length} ${noun} you can write`;
    return html`<p class="small muted studio-cost">
      ${sentence} · ${paused} paused at <a href="/map">their ceiling</a>
    </p>`;
  });

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
            ${btn("Audit", { href: "/audit", size: "sm", icon: "shield" })}
            ${btn("New app", { href: "/apps/new", size: "sm", icon: "plus" })}`,
        });

  // Happening now: every run in flight across the apps, one read.
  const running = listActiveRuns(
    db,
    appRepos.map((r) => r.id),
  );
  const runActors = getUsersByIds(
    db,
    [
      ...running.map((r) => r.actorId),
      ...[...productionFacts.values()].map((f) => f.actorId),
    ].filter((id): id is string => id !== null),
  );
  const byId = new Map(appRepos.map((r) => [r.id, r]));
  // Who is working is shown by name here because every app on this shelf is
  // already one the viewer can write — nothing here is a stranger's app.
  // The board: the same runs as a wall for a second monitor.
  const nowHead = html`${icon("activity")}
    <h2>Happening now</h2>
    <span class="spacer"></span>
    ${btn("Focus", {
      href: "/board",
      size: "sm",
      title: "The board: a live wall of the crews at work",
    })}`;
  // Nothing running is not the same as nothing happening: an open change
  // still waits for a look, an agent's or a person's own, and the rail
  // links straight to it rather than reporting silence.
  const openPulls: readonly Pull[] =
    running.length === 0
      ? [
          ...openPullsForRepos(
            db,
            appRepos.map((r) => r.id),
          ).values(),
        ]
      : [];
  // Still nothing waiting for a look: a deploy that just landed or just
  // failed is news too, newest first — the same facts the shelf's rows
  // read, shared rather than asked for twice.
  const shipped =
    running.length === 0 && openPulls.length === 0
      ? [...productionFacts.entries()]
          .sort(([, a], [, b]) => (a.at < b.at ? 1 : -1))
          .slice(0, 10)
      : [];
  const now =
    running.length > 0
      ? listCard(
          running.map((r) => {
            const repo = byId.get(r.repoId)!;
            const who =
              r.actorId === null
                ? "crew"
                : (runActors.get(r.actorId)?.username ?? "crew");
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
        )
      : openPulls.length > 0
        ? listCard(
            await Promise.all(
              openPulls.slice(0, 10).map(async (pull) => {
                const repo = byId.get(pull.repoId)!;
                const info = await pullWord(
                  {
                    db,
                    dir: repoDir(ctx.app.reposRoot, repo.ownerName, repo.name),
                    runtime,
                    record: records.get(repo.id),
                    history,
                  },
                  pull,
                );
                const href = changeHref(repoBase(repo), pull.number);
                return row({
                  href,
                  nav: true,
                  lead: icon("eye"),
                  title: html`<a href="${href}"
                    >${pull.title} · ${repo.name}</a
                  >`,
                  meta: html`${info.note} · ${time(pull.updatedAt)}`,
                  trail: wordBadge(info.word),
                });
              }),
            ),
            { head: nowHead },
          )
        : shipped.length > 0
          ? listCard(
              shipped.map(([repoId, fact]) => {
                const repo = byId.get(repoId)!;
                const href = `${repoBase(repo)}/runs/${fact.runId}`;
                const who =
                  fact.actorId === null
                    ? "crew"
                    : (runActors.get(fact.actorId)?.username ?? "crew");
                return row({
                  href,
                  nav: true,
                  lead: icon(fact.word === "shipped" ? "check" : "alert"),
                  title: html`<a href="${href}">${who} · ${repo.name}</a>`,
                  meta: html`${fact.note} · ${time(fact.at)}`,
                  trail: wordBadge(fact.word),
                });
              }),
              { head: nowHead },
            )
          : card(
              html`<p class="muted small">Nobody is working right now.</p>`,
              {
                head: nowHead,
              },
            );

  const body = html`<h1 class="sr-only">Studio</h1>
    ${costLine}
    <div class="dash">
      <div class="dash-main stack">
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
    scriptJs: `${liveClientJs}\n${liveRegionsJs}`,
  });
}
