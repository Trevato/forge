/**
 * The studio: the forge with apps as the unit. A person does two things to
 * an app here — tell the crew, look at what it made — and every word on the
 * page maps to one thing in git that dev mode shows. Nothing here is a second system: these pages read the same tables
 * as the rest and act through the same actions a person would take by
 * hand.
 *
 * Words: *tell* is an issue; *working* is a run; *look* is an open pull
 * with a green check and a preview; *shipped* is a merge. An autonomous
 * app lands its own green changes; nothing here waits on a person.
 */

import { tell } from "../../actions/tell.ts";
import { appsRuntime, type EnvStatus } from "../../apps/runtime.ts";
import { listCrewRoles } from "../../core/agents.ts";
import { appsForRepos, type AppRecord } from "../../core/apps.ts";
import { getIssueById, listIssues, type Issue } from "../../core/issues.ts";
import { listPulls, openPullsClosing } from "../../core/pulls.ts";
import { canWrite, listReposVisibleTo, type Repo } from "../../core/repos.ts";
import {
  latestAgentRunsForRepos,
  latestRunsForIssues,
  listActiveRuns,
  listRuns,
  type Run,
} from "../../core/runs.ts";
import { getUsersByIds, type User } from "../../core/users.ts";
import { autonomyStatus } from "../../crew/autonomy.ts";
import { decisionStats, type DecisionStat } from "../../core/decisions.ts";
import type { Ctx } from "../../http/context.ts";
import {
  crumbsFor,
  loadRepo,
  notFoundPage,
  repoBase,
  repoHeader,
  repoPalette,
  signInFirst,
} from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { followingCard, followingOf } from "./following.ts";
import { audit } from "../../contract/audit.ts";
import { latestProbes } from "../../contract/probes.ts";
import { liveRegionsJs } from "../client.ts";
import { flashTo, page, redirect } from "../layout.ts";
import { liveClientJs, liveMount } from "../live.ts";
import { isMode, modeCookie } from "../mode.ts";
import {
  avatar,
  btn,
  card,
  dot,
  empty,
  icon,
  listCard,
  row,
  time,
  userTag,
  type Tone,
} from "../ui.ts";
import { lookNow } from "./looks.ts";
import { onYouCard } from "./site.ts";

/**
 * The week's decisions in one line: how many, how many the decider took
 * rather than the rule, and what came of the ones that are known.
 * "12 · 11 by typesafe · shipped 5, shown 2, stopped 1"
 */
function decisionWords(stats: readonly DecisionStat[]): Html {
  const n = stats.reduce((s, k) => s + k.n, 0);
  const decided = stats.reduce((s, k) => s + k.decided, 0);
  const by = stats
    .flatMap((k) => Object.entries(k.outcomes))
    .reduce<Record<string, number>>((acc, [o, c]) => {
      acc[o] = (acc[o] ?? 0) + c;
      return acc;
    }, {});
  const outcomes = Object.entries(by)
    .sort((a, b) => b[1] - a[1])
    .map(([o, c]) => `${o} ${c}`)
    .join(", ");
  return html`${n}
    <span class="muted"
      >· ${decided} by the
      decider${outcomes === "" ? "" : ` · ${outcomes}`}</span
    >`;
}

/**
 * The one control a live run has: a person who can write here stops a
 * running one or takes a queued one back off the board. Nothing for runs
 * that are over, or for readers.
 */
function stopForm(ctx: Ctx, repo: Repo, run: Run): Html | null {
  if (run.state !== "running" && run.state !== "queued") return null;
  if (run.kind !== "agent") return null;
  if (!canWrite(ctx.app.db, repo, ctx.auth.user)) return null;
  return html`<form
    method="post"
    action="${repoBase(repo)}/runs/${run.id}/cancel"
  >
    ${btn(run.state === "running" ? "Stop" : "Cancel", {
      size: "sm",
      variant: "outline",
    })}
  </form>`;
}

type Word = "working" | "look" | "shipped" | "stopped" | "waiting" | "planned";

function wordFor(run: Run): { word: Word; note: string } {
  if (run.state === "queued")
    return run.notBefore === null
      ? { word: "waiting", note: "queued" }
      : { word: "waiting", note: "paused, resumes soon" };
  if (run.state === "running") return { word: "working", note: "now" };
  if (run.state === "failed" || run.state === "cancelled")
    return { word: "stopped", note: run.summary || run.state };
  const summary = run.summary || "";
  if (/opened pull|updated pull/.test(summary))
    return { word: "look", note: summary };
  if (/planned|no changes pushed/.test(summary))
    return { word: "planned", note: summary };
  return { word: "shipped", note: summary };
}

const WORD_ICON: Record<Word, Parameters<typeof icon>[0]> = {
  working: "loader",
  look: "eye",
  shipped: "check",
  stopped: "alert",
  waiting: "clock",
  planned: "map",
};

// ---- the app in the studio ----

/**
 * One line about the app's policy, when it has one: what it opens to
 * anyone and what the running app said when the forge last knocked, with
 * the way to the audit, where the whole table is. An app without a
 * contract says nothing here; its doors are not the forge's to describe.
 */
async function policyLine(
  ctx: Ctx,
  repo: Repo,
  record: AppRecord,
): Promise<Html> {
  const { standing } = await audit(ctx.app.reposRoot, repo);
  if (standing.kind === "unread") return html``;
  const href = `/audit#${repo.ownerName}-${repo.name}`;
  if (standing.kind === "unsound")
    return html`<p class="policy-line">
      ${icon("alert")}
      <span
        ><b>Its contract does not read</b>, so an app built on it does not
        boot.</span
      >
      <a href="${href}">See why</a>
    </p>`;
  const last = latestProbes(ctx.app.db, [record.id]).get(record.id);
  const open = standing.open.length;
  const said =
    last === undefined
      ? "not yet knocked on"
      : last.verdict === "ok"
        ? "obeys its table"
        : last.verdict === "mismatch"
          ? `${last.said.length === 1 ? "one door disobeys" : `${last.said.length} doors disobey`} its table`
          : last.verdict === "down"
            ? "was not running when knocked on"
            : "has no door to knock on";
  return html`<p class="policy-line" data-tone="${last?.verdict ?? "none"}">
    ${icon("shield")}
    <span
      ><b
        >${Object.keys(standing.contract.resources).length === 1
          ? "One resource"
          : `${Object.keys(standing.contract.resources).length} resources`}</b
      >,
      ${open === 0
        ? "nothing open to anyone"
        : open === 1
          ? "one door open to anyone"
          : `${open} doors open to anyone`};
      ${said}.</span
    >
    <a href="${href}">The table</a>
  </p>`;
}

export async function studioApp(
  ctx: Ctx,
  repo: Repo,
  record: AppRecord,
): Promise<Response> {
  const db = ctx.app.db;
  const base = repoBase(repo);
  const crew = listCrewRoles(db, repo.id);
  const builders = crew.filter((c) => c.role === "builder").map((c) => c.agent);
  const runs = listRuns(db, repo.id, { kind: "agent", limit: 8 });
  const actors = getUsersByIds(
    db,
    runs.map((r) => r.actorId).filter((id): id is string => id !== null),
  );
  const issues = new Map<string, Issue>();
  for (const r of runs)
    if (r.issueId !== null && !issues.has(r.issueId)) {
      const i = getIssueById(db, r.issueId);
      if (i) issues.set(r.issueId, i);
    }
  const openPulls = listPulls(db, repo.id, { state: "open", limit: 10 });
  const pullChecks = latestRunsForIssues(
    db,
    openPulls.map((p) => p.id),
  );
  const week = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
  const weekRuns = listRuns(db, repo.id, { kind: "agent", limit: 200 }).filter(
    (r) => r.createdAt >= week,
  );
  const spent = weekRuns.reduce((s, r) => s + r.costUsd, 0);
  const shipped = listPulls(db, repo.id, {
    state: "closed",
    limit: 100,
  }).filter((p) => p.mergedAt !== null && p.mergedAt >= week).length;
  const ledgerWeek = decisionStats(db, repo.id, week);
  const autonomy =
    repo.autonomy === "off" ? undefined : autonomyStatus(ctx.app, repo);
  const moving = runs.some(
    (r) => r.state === "running" || r.state === "queued",
  );

  // ---- the app itself ----
  const runtime = appsRuntime(ctx.app);
  const envs: EnvStatus[] = runtime === undefined ? [] : runtime.status(record);
  const production = envs.find((e) => e.env === "production");
  const url = runtime?.urlFor(record, "production");
  const state = production?.state ?? "stopped";
  const liveWord =
    state === "running"
      ? "live"
      : state === "failed"
        ? "not up"
        : state === "stopped"
          ? "not running"
          : "starting";
  const liveTone: Tone =
    state === "running" ? "success" : state === "failed" ? "danger" : "default";
  const head = html`<div class="page-head studio-head">
    <div class="stack stack-tight">
      <h1>
        ${repo.name}
        <span
          class="badge"
          data-variant="${liveTone === "success"
            ? "success"
            : liveTone === "danger"
              ? "danger"
              : "secondary"}"
          >${liveWord}</span
        >
      </h1>
      <p class="muted">
        ${repo.description || "No description yet."}
        ${url === undefined
          ? null
          : html`·
              <a href="${base}/app/production/open" class="mono"
                >${url.replace(/^https?:\/\//, "")}</a
              >`}
        ${production?.commitOid
          ? html`·
            ${production.commitOid.slice(0, 7)}${production.since
              ? html` since ${time(production.since)}`
              : null}`
          : null}
      </p>
    </div>
    <span class="spacer"></span>
    ${lookNow(ctx, repo, record)}
    ${btn("Open the app", {
      href: `${base}/app/production/open`,
      variant: "primary",
      icon: "external",
    })}
  </div>`;

  // ---- the box ----
  const tell = html`<form
    class="card comment-form studio-tell"
    method="post"
    action="${base}/tell"
  >
    <label class="sr-only" for="tell">Tell the crew</label>
    <textarea
      class="input"
      id="tell"
      name="text"
      rows="3"
      required
      placeholder="${builders.length === 0
        ? "Add a crew member under Settings → Crew, then tell them what you want."
        : "What should change? One thing at a time works best."}"
    ></textarea>
    <div class="bar">
      <span class="muted small">
        ${builders.length === 0
          ? html`Nobody on the crew yet.`
          : html`${builders
              .map((b) => userTag(b.user.username))
              .reduce((a, b) => html`${a} ${b}`)}
            ${builders.length === 1 ? "takes it" : "share the work"}`}
      </span>
      <span class="spacer"></span>
      ${btn("Tell the crew", { variant: "primary", type: "submit" })}
    </div>
  </form>`;

  // ---- now: one row per thing, in the five words ----
  const proposed = new Set(openPulls.map((p) => p.id));
  const openByIssue = openPullsClosing(db, repo.id);
  const told = listIssues(db, repo.id, {
    kind: "issue",
    state: "open",
    limit: 30,
  }).filter((i) => i.assigneeIsAgent && !openByIssue.has(i.number));
  const everRan = latestRunsForIssues(
    db,
    told.map((i) => i.id),
    ["agent"],
  );
  const waiting = told.filter((i) => !everRan.has(i.id)).slice(0, 5);
  const issueNumberById = new Map(told.map((i) => [i.id, i.number]));
  const rowsNow = runs
    .filter((r) => {
      if (r.issueId === null) return true;
      if (proposed.has(r.issueId)) return false;
      const n = issueNumberById.get(r.issueId) ?? issues.get(r.issueId)?.number;
      return n === undefined || !openByIssue.has(n);
    })
    .filter(
      (r, idx, all) => all.findIndex((x) => x.issueId === r.issueId) === idx,
    )
    .slice(0, 6);
  const wordBadge = (word: Word): Html => {
    const variant =
      word === "look" || word === "shipped"
        ? "success"
        : word === "stopped"
          ? "danger"
          : word === "working"
            ? "accent"
            : "secondary";
    return html`<span
      class="badge"
      data-variant="${variant}"
      data-word="${word}"
      >${word === "working" ? icon("loader") : null}${word}</span
    >`;
  };
  const nowRows: Html[] = [
    ...openPulls.map((p) => {
      const check = pullChecks.get(p.id);
      const word: Word =
        check?.state === "ok"
          ? "look"
          : check?.state === "failed"
            ? "stopped"
            : "working";
      return row({
        href: `${base}/pulls/${p.number}`,
        nav: true,
        lead: avatarOf(p.authorName),
        title: p.title,
        meta: html`${p.authorName} ·
        ${word === "look"
          ? "green, ready for a look"
          : word === "stopped"
            ? "the check failed"
            : "checking"}
        · ${time(p.createdAt)}`,
        trail: wordBadge(word),
      });
    }),
    ...rowsNow.map((r) => {
      const { word, note } = wordFor(r);
      const who =
        r.actorId === null
          ? "crew"
          : (actors.get(r.actorId)?.username ?? "crew");
      const about = r.issueId === null ? undefined : issues.get(r.issueId);
      const stop = stopForm(ctx, repo, r);
      return row({
        ...(stop ? {} : { href: `${base}/runs/${r.id}`, nav: true }),
        lead: avatarOf(who),
        title: stop
          ? html`<a href="${base}/runs/${r.id}">${about?.title ?? note}</a>`
          : (about?.title ?? note),
        meta: html`${who} · ${word === "working" ? "working now" : note}
        ${word === "working"
          ? null
          : html` · ${time(r.finishedAt ?? r.createdAt)}`}`,
        trail: stop
          ? html`<span class="studio-row-actions"
              >${wordBadge(word)} ${stop}</span
            >`
          : wordBadge(word),
      });
    }),
    ...waiting.map((i) =>
      row({
        href: `${base}/issues/${i.number}`,
        nav: true,
        lead: avatarOf(i.assigneeName ?? "crew"),
        title: i.title,
        meta: html`${i.assigneeName} · told ${time(i.createdAt)}, not picked up
        yet`,
        trail: wordBadge("waiting"),
      }),
    ),
  ];
  const now =
    nowRows.length === 0
      ? card(
          html`<p class="muted small">
            Nothing yet. Tell the crew something.
          </p>`,
          {
            head: html`${icon("activity")}
              <h2>Now</h2>`,
          },
        )
      : listCard(nowRows, {
          head: html`${icon("activity")}
            <h2>Now</h2>
            <span class="spacer"></span>
            ${btn("Every run", { href: `${base}/runs`, size: "sm" })}`,
        });

  // ---- the rail ----
  const crewCard =
    crew.length === 0
      ? card(
          html`<p class="muted small">
            Nobody yet. <a href="${base}/settings/crew">Add someone.</a>
          </p>`,
          {
            head: html`${icon("bot")}
              <h2>Crew</h2>`,
          },
        )
      : listCard(
          crew.map((c) =>
            row({
              lead: avatarOf(c.agent.user.username),
              title: c.agent.user.username,
              meta: html`${c.role === "builder"
                ? "builds"
                : c.role === "planner"
                  ? "plans"
                  : "reviews"}`,
            }),
          ),
          {
            head: html`${icon("bot")}
              <h2>Crew</h2>
              <span class="spacer"></span>
              ${btn("Change", { href: `${base}/settings/crew`, size: "sm" })}`,
          },
        );
  const weekCard = card(
    html`<dl>
      <dt>Shipped</dt>
      <dd>${shipped} change${shipped === 1 ? "" : "s"}</dd>
      <dt>Runs</dt>
      <dd>${weekRuns.length}</dd>
      <dt>Spent</dt>
      <dd>
        $${spent.toFixed(2)}${shipped > 0
          ? html` <span class="muted"
              >· $${(spent / shipped).toFixed(2)} per shipped change</span
            >`
          : null}
      </dd>
      ${when(
        ledgerWeek.length > 0,
        () =>
          html`<dt>Decided</dt>
            <dd>${decisionWords(ledgerWeek)}</dd>`,
      )}
    </dl>`,
    {
      head: html`${icon("activity")}
        <h2>This week</h2>`,
      extra: "about",
    },
  );
  const ownCard = card(
    autonomy === undefined
      ? html`<p class="muted small">
          Off. <a href="${base}/settings/autonomy">Turn it on</a> and the crew
          works what is ready without being asked.
        </p>`
      : html`<dl>
          <dt>Mode</dt>
          <dd>${repo.autonomy === "autonomous" ? "Autonomous" : "Assisted"}</dd>
          <dt>Today</dt>
          <dd>
            $${autonomy.spentTodayUsd.toFixed(2)} of
            $${autonomy.ceilingUsd.toFixed(0)}
          </dd>
          <dt>Slots</dt>
          <dd>${autonomy.active} of ${autonomy.slots} in use</dd>
          ${autonomy.paused
            ? html`<dt>Paused</dt>
                <dd>
                  ${autonomy.paused === "ceiling"
                    ? "at the ceiling, until 00:00 UTC"
                    : autonomy.paused === "forge ceiling"
                      ? "at the forge's ceiling, until 00:00 UTC"
                      : autonomy.paused}
                </dd>`
            : null}
        </dl>`,
    {
      head: html`${icon("play")}
        <h2>On its own</h2>
        <span class="spacer"></span>
        ${btn("Change", { href: `${base}/settings/autonomy`, size: "sm" })}`,
      extra: "about",
    },
  );
  const more = html`<p class="muted small">
    <a href="${base}/map">The map</a> ·
    <a href="${base}/issues">Everything told</a> ·
    <a href="${base}/pulls">Every change</a>
  </p>`;

  // An app that follows another says so before anything else: whether
  // it is in step is the first thing its owner wants to know.
  const following = await followingOf(ctx, repo);
  const body = html`${repoHeader(ctx, repo, "code", {
      compact: true,
      ownTitle: true,
    })}
    ${head}
    ${following === undefined ? null : followingCard(ctx, repo, following)}
    ${await policyLine(ctx, repo, record)}
    <div class="dash">
      <div class="dash-main stack">
        ${tell}
        <div
          id="live-now"
          data-live="run.*,pull.*,issue.*"
          data-live-repo="${repo.ownerName}/${repo.name}"
        >
          ${now}
        </div>
      </div>
      <aside class="dash-rail stack">
        ${crewCard} ${weekCard} ${ownCard} ${more}
      </aside>
    </div>
    ${when(moving, () => liveMount({ repo: base }))}`;
  return page({
    ctx,
    title: `${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(repo),
    body,
    styleCss: studioCss,
    scriptJs: `${liveClientJs}\n${liveRegionsJs}`,
  });
}

function avatarOf(username: string): Html {
  return avatar(username);
}

// ---- the studio home ----

/**
 * The home in the studio: what is on you first, then every app as one row
 * that carries a real signal — live or not, what the crew last did there,
 * how many things wait on you — and beside it what is happening right now
 * across all of them, and what a person put on you. Built from the same
 * rows and cards as the rest of the forge, so it reads as the forge.
 */
export async function studioHome(ctx: Ctx, user: User): Promise<Response> {
  const db = ctx.app.db;
  const { repos: appRepos, records } = appsOf(ctx, user);
  const runtime = appsRuntime(ctx.app);
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

  const appRows = appRepos.map((repo) => {
    const record = records.get(repo.id)!;
    const envs = runtime === undefined ? [] : runtime.status(record);
    const production = envs.find((e) => e.env === "production");
    const state = production?.state ?? "stopped";
    const latest = latestRuns.get(repo.id);
    const word = latest === undefined ? undefined : wordFor(latest);
    const who =
      latest?.actorId == null
        ? undefined
        : actors.get(latest.actorId)?.username;
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
      trail: html`<span class="badge" data-tone="${tone}"
        >${state === "running"
          ? "live"
          : state === "stopped"
            ? "not running"
            : state}</span
      >`,
    });
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
                    trail: html`<span class="studio-row-actions"
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
      <div id="live-apps" data-live="run.finished,pull.merged,pull.opened">
        ${apps}
      </div>
    </div>
    <aside class="dash-rail stack">
      <div id="live-now" data-live="run.*">${now}</div>
      ${onYouCard(ctx, user) ?? null}
    </aside>
  </div>`;
  return page({
    ctx,
    title: "Studio",
    body,
    styleCss: studioCss,
    scriptJs: `${liveClientJs}\n${liveRegionsJs}`,
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

// ---- actions ----

/** POST /:owner/:name/tell  { text } — a sentence becomes work. */
export async function tellSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const base = repoBase(repo);
  // The same act the forge's MCP `tell` tool performs (`actions/tell.ts`).
  const told = await tell(ctx.app, ctx.auth.user, repo, field(form, "text"));
  if (!told.ok)
    return flashTo(ctx, base, {
      tone: "danger",
      message:
        told.error === "empty"
          ? "Say something first."
          : "That could not be told.",
    });
  const { issue, routed, assigned } = told.value;
  if (routed === undefined)
    return flashTo(ctx, base, {
      message: `Told. Nobody is on the crew to take it yet — add someone under Settings → Crew.`,
    });
  const builder = routed.builder;
  return flashTo(ctx, base, {
    message: assigned
      ? `${builder.user.username} is on it — ${routed.size} ${routed.kind}${routed.by === "rule" ? "" : `, ${routed.by} decided in ${routed.ms} ms`}. Watch it work below.`
      : `Told as #${issue.number}, but ${builder.user.username} could not take it.`,
  });
}

/** Where a form sends a person back: what it said, else the referer, else
 * home — and never off this forge. */
function backTo(ctx: Ctx, said: string): string {
  const back = said || ctx.request.headers.get("referer") || "/";
  return (back.startsWith("/") && !back.startsWith("//")) ||
    back.startsWith(`${ctx.url.origin}/`)
    ? back
    : "/";
}

/** POST /mode  { mode } — studio or dev, for this browser. */
export async function modeSubmit(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx);
  if (form instanceof Response) return form;
  const choice = field(form, "mode");
  const secure = ctx.url.protocol === "https:";
  return redirect(
    backTo(ctx, field(form, "back")),
    modeCookie(isMode(choice) ? choice : undefined, secure),
  );
}

export const studioCss = /* css */ `
.studio { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 22px; margin-top: 16px; }
@media (max-width: 860px) { .studio { grid-template-columns: 1fr; } }
.studio-main { display: grid; gap: 18px; }
.studio-preview { border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; background: var(--muted); }
.studio-preview-head { display: flex; align-items: center; gap: 12px; }
.studio-live { font-family: var(--mono); font-size: 11.5px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); }
.studio-live[data-state="running"] { color: var(--merged); border-color: var(--merged); }
.studio-live[data-state="failed"] { color: var(--danger, #c33); }
.studio-tell textarea { min-height: 72px; resize: vertical; }
.studio-tell .bar { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.studio-head h1 { display: flex; align-items: center; gap: 10px; }
.badge[data-variant="accent"] { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 34%, transparent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.badge[data-word="working"] svg { animation: spin 1.1s linear infinite; }
.studio-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.studio-list li { display: grid; grid-template-columns: 18px 84px minmax(0, 1fr) auto; gap: 10px; align-items: baseline; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 14px; }
.studio-list li svg { vertical-align: -3px; }
.studio-who { font-weight: 600; }
.studio-word { font-family: var(--mono); font-size: 11.5px; opacity: .8; white-space: nowrap; }
.row-meta .studio-word { font-family: inherit; font-size: inherit; opacity: 1; font-weight: 560; }
.studio-list li[data-word="working"] .studio-word { color: var(--accent); opacity: 1; }
.studio-list li[data-word="look"] .studio-word { color: var(--merged); opacity: 1; }
.studio-list li[data-word="stopped"] .studio-word { color: var(--danger, #c33); opacity: 1; }
.studio-row-actions { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.studio-rail { display: grid; gap: 18px; align-content: start; }
.studio-rail h3 { font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; opacity: .7; margin: 0 0 6px; font-weight: 600; }
.studio-crew { list-style: none; margin: 0; padding: 0; display: grid; gap: 5px; font-size: 13.5px; }
.studio-crew li { display: grid; grid-template-columns: 74px 1fr; gap: 8px; }
.studio-crew li b { font-weight: 600; }
.studio-crew li span { opacity: .85; }
`;
