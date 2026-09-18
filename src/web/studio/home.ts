/**
 * The home in the studio: what asks you first, then every app as one row
 * carrying a real signal — live or not, what the crew last did there, how
 * many things wait on you — and beside it what is happening right now across
 * all of them, and what a person put on you. Built from the same rows and
 * cards as the rest of the forge, from grouped reads only, so the page does
 * not get slower as the apps grow.
 */

import { appsRuntime } from "../../apps/runtime.ts";
import { appsForRepos } from "../../core/apps.ts";
import { canSeeOwnerFacts, listReposVisibleTo } from "../../core/repos.ts";
import { latestAgentRunsForRepos, listActiveRuns } from "../../core/runs.ts";
import { getUsersByIds, type User } from "../../core/users.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { repoBase } from "../chrome.ts";
import { asksJs, liveRegionsJs } from "../client.ts";
import { html, when } from "../html.ts";
import { page } from "../layout.ts";
import { liveClientJs } from "../live.ts";
import {
  btn,
  card,
  dot,
  empty,
  icon,
  listCard,
  pill,
  row,
  time,
  type Tone,
} from "../ui.ts";
import { onYouCard } from "../pages/site.ts";
import { asksPanel, decisionsFor } from "./asks.ts";
import { withLikely } from "./leans.ts";
import { stopForm } from "./run.ts";
import { studioCss } from "./style.ts";
import { runWord } from "./words.ts";

/**
 * The home in the studio: what asks you first, then every app as one row
 * that carries a real signal — live or not, what the crew last did there,
 * how many things wait on you — and beside it what is happening right now
 * across all of them, and what a person put on you. Built from the same
 * rows and cards as the rest of the forge, so it reads as the forge.
 */
export async function studioHome(ctx: Ctx, user: User): Promise<Response> {
  const db = ctx.app.db;
  const { repos: appRepos, records } = appsOf(ctx, user);
  const runtime = appsRuntime(ctx.app);
  // A public app you can only read appears here too, but who is on its
  // crew is its owner's fact, not yours to see — same predicate as the
  // app's own page.
  const ownerFacts = new Set(
    appRepos.filter((r) => canSeeOwnerFacts(db, r, user)).map((r) => r.id),
  );
  // One read for the newest run of every app, one for who ran them: the
  // home must not get slower as the apps grow.
  const latestRuns = latestAgentRunsForRepos(
    db,
    appRepos.map((r) => r.id),
  );
  const actors = getUsersByIds(
    db,
    [...latestRuns.values()]
      .map((r) => r.actorId)
      .filter((id): id is string => id !== null),
  );
  const decisions = withLikely(ctx, decisionsFor(ctx, appRepos));
  const asksByRepo = new Map<string, number>();
  for (const d of decisions)
    asksByRepo.set(d.repo.id, (asksByRepo.get(d.repo.id) ?? 0) + 1);

  const appRows = await Promise.all(appRepos.map(async (repo) => {
    const record = records.get(repo.id)!;
    const envs = runtime === undefined ? [] : runtime.status(record);
    const production = envs.find((e) => e.env === "production");
    const state = production?.state ?? "stopped";
    const latest = latestRuns.get(repo.id);
    const word =
      latest === undefined
        ? undefined
        : await runWord(
            {
              db,
              dir: repoDir(ctx.app.reposRoot, repo.ownerName, repo.name),
              runtime,
              record,
            },
            latest,
          );
    const who =
      latest?.actorId == null || !ownerFacts.has(repo.id)
        ? undefined
        : actors.get(latest.actorId)?.username;
    const asks = asksByRepo.get(repo.id) ?? 0;
    const tone: Tone =
      state === "running"
        ? "success"
        : state === "failed"
          ? "danger"
          : "default";
    const happening =
      latest === undefined || word === undefined
        ? html`<span class="muted">quiet — tell the crew something</span>`
        : html`<span class="studio-word" data-word="${word.word}"
              >${word.word}</span
            >
            ${who ? html`· ${who}` : null}
            ${word.word === "working"
              ? html`· now`
              : html`· ${time(latest.finishedAt ?? latest.createdAt)}`}`;
    return row({
      href: repoBase(repo),
      nav: true,
      lead: dot(tone),
      title: repo.name,
      titleAttr: repo.description || repo.name,
      meta: html`${repo.description
        ? html`${repo.description} · `
        : null}${happening}`,
      trail: html`${asks > 0 ? pill(`${asks} asks you`, "accent") : null}
        <span class="badge" data-tone="${tone}"
          >${state === "running"
            ? "live"
            : state === "stopped"
              ? "not running"
              : state}</span
        >`,
    });
  }));

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

/** The apps a person can see, as repositories, with their records. */
export function appsOf(ctx: Ctx, user: User) {
  const repos = listReposVisibleTo(ctx.app.db, user, { limit: 200 });
  const records = appsForRepos(
    ctx.app.db,
    repos.map((r) => r.id),
  );
  return { repos: repos.filter((r) => records.has(r.id)), records };
}
