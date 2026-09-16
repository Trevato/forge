/**
 * The studio: the forge with apps as the unit. A person does three things
 * to an app here — tell the crew, look at what it made, decide when it
 * asks — and every word on the page maps to one thing in git that dev mode
 * shows. Nothing here is a second system: these pages read the same tables
 * as the rest and act through the same actions a person would take by
 * hand.
 *
 * Words: *tell* is an issue; *working* is a run; *look* is an open pull
 * with a green check and a preview; *shipped* is a merge; *asks you* is a
 * pull the crew stopped on, or a green one waiting for a look.
 */

import { addComment, openIssue, assignIssue } from "../../actions/issues.ts";
import { mergePull } from "../../actions/pulls.ts";
import { appsRuntime, type EnvStatus } from "../../apps/runtime.ts";
import { listCrewRoles, type Agent } from "../../core/agents.ts";
import { appsForRepos, getAppByRepo, type AppRecord } from "../../core/apps.ts";
import {
  getIssueById,
  listComments,
  listIssues,
  listOpenAgentPullsVisibleTo,
  type Issue,
} from "../../core/issues.ts";
import { getPull, joinMany, listPulls, type Pull } from "../../core/pulls.ts";
import { listReposVisibleTo, type Repo } from "../../core/repos.ts";
import { listReviews } from "../../core/reviews.ts";
import {
  automaticRunsSince,
  latestAgentRunsForRepos,
  latestRunsForIssues,
  listActiveRuns,
  listRuns,
  type Run,
} from "../../core/runs.ts";
import { getUserById, getUsersByIds, type User } from "../../core/users.ts";
import { autonomyStatus, pickBuilder } from "../../crew/autonomy.ts";
import { CHECK_FAILED_LIMIT } from "../../crew/dispatch.ts";
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
import { flashTo, page, redirect } from "../layout.ts";
import { liveClientJs, liveMount } from "../live.ts";
import { isMode, modeCookie } from "../mode.ts";
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
import { onYouCard } from "./site.ts";

// ---- decisions: what asks a person ----

export type DecisionKind = "stopped" | "look" | "paused";

export interface Decision {
  readonly kind: DecisionKind;
  readonly repo: Repo;
  readonly pull?: Pull | undefined;
  readonly who: string;
  /** Three sentences at most: what, why, what happens next. */
  readonly says: string;
}

/** When a person last spoke on a conversation, or its start. */
function lastHumanWord(ctx: Ctx, issue: Issue, agentName: string): string {
  let latest = issue.createdAt;
  for (const c of listComments(ctx.app.db, issue.id))
    if (c.authorName !== agentName && c.createdAt > latest)
      latest = c.createdAt;
  for (const r of listReviews(ctx.app.db, issue.id))
    if (r.authorName !== agentName && r.createdAt > latest)
      latest = r.createdAt;
  return latest;
}

/**
 * The crew's open pulls the viewer may land, sorted into what asks them:
 * stopped (red past the crew's own limit since a person last spoke), or
 * green and waiting for a look. Plus a repository paused at its ceiling.
 */
export function decisionsFor(ctx: Ctx, repos: readonly Repo[]): Decision[] {
  const db = ctx.app.db;
  const out: Decision[] = [];
  const byId = new Map(repos.map((r) => [r.id, r]));
  const user = ctx.auth.user;
  if (!user) return out;
  const pulls = listOpenAgentPullsVisibleTo(db, user, 50).filter((p) =>
    byId.has(p.repoId),
  );
  const checks = latestRunsForIssues(
    db,
    pulls.map((p) => p.id),
  );
  const joined = new Map(joinMany(db, pulls).map((p) => [p.id, p]));
  for (const issue of pulls) {
    const repo = byId.get(issue.repoId)!;
    const pull = joined.get(issue.id);
    if (!pull) continue;
    const check = checks.get(issue.id);
    const who = issue.authorName;
    if (check?.state === "failed") {
      const since = lastHumanWord(ctx, issue, who);
      const tries = automaticRunsSince(db, issue.id, since);
      if (tries >= CHECK_FAILED_LIMIT)
        out.push({
          kind: "stopped",
          repo,
          pull,
          who,
          says: `${who} tried ${tries + 1} times and the check still fails. The crew stopped here. Say what to try, or close it.`,
        });
    } else if (check?.state === "ok" && repo.autonomy !== "autonomous") {
      out.push({
        kind: "look",
        repo,
        pull,
        who,
        says: `${who} finished "${pull.title}" and the check is green. Look at the preview, then ship it or say what is off.`,
      });
    }
  }
  for (const repo of repos) {
    if (repo.autonomy === "off") continue;
    const s = autonomyStatus(ctx.app, repo);
    if (s.paused === "ceiling")
      out.push({
        kind: "paused",
        repo,
        who: "the crew",
        says: `${repo.name} reached its $${s.ceilingUsd.toFixed(0)} for today. The crew picks nothing more until 00:00 UTC. Raise the ceiling in settings to go on now.`,
      });
  }
  return out;
}

function decisionOptions(ctx: Ctx, d: Decision): Html {
  const base = repoBase(d.repo);
  const pull = d.pull;
  const preview =
    pull === undefined
      ? undefined
      : getAppByRepo(ctx.app.db, d.repo.id) === undefined
        ? undefined
        : `${base}/app/pull-${pull.number}/open`;
  if (d.kind === "stopped" && pull)
    return html`<form
        method="post"
        action="${base}/pulls/${pull.number}/say"
        class="studio-say"
      >
        <label class="sr-only" for="say-${pull.number}">What to try</label>
        <input
          class="input"
          id="say-${pull.number}"
          name="text"
          placeholder="Tell ${d.who} what to try"
          required
        />
        ${btn("Send", { size: "sm", variant: "primary" })}
      </form>
      <form method="post" action="${base}/pulls/${pull.number}/state">
        <input type="hidden" name="state" value="closed" />
        ${btn("Close it", { size: "sm" })}
      </form>
      ${btn("See the change", {
        href: `${base}/pulls/${pull.number}`,
        size: "sm",
      })}`;
  if (d.kind === "look" && pull)
    return html`${when(preview, (href) =>
        btn("Open the preview", { href, size: "sm" }),
      )}
      <form method="post" action="${base}/pulls/${pull.number}/ship">
        ${btn("Ship it", { size: "sm", variant: "primary" })}
      </form>
      <form
        method="post"
        action="${base}/pulls/${pull.number}/say"
        class="studio-say"
      >
        <label class="sr-only" for="say-${pull.number}">What is off</label>
        <input
          class="input"
          id="say-${pull.number}"
          name="text"
          placeholder="Not like this — say what is off"
          required
        />
        ${btn("Send", { size: "sm" })}
      </form>`;
  return html`${btn("Settings", {
    href: `${base}/settings/autonomy`,
    size: "sm",
  })}`;
}

function decisionCard(ctx: Ctx, d: Decision): Html {
  return html`<div class="studio-decision" data-kind="${d.kind}">
    <p class="studio-decision-says">
      <strong>${d.repo.name}</strong> · ${d.says}
    </p>
    <div class="studio-decision-options">${decisionOptions(ctx, d)}</div>
  </div>`;
}

// ---- studio words for what the crew is doing ----

type Word = "working" | "look" | "shipped" | "stopped" | "waiting" | "planned";

function wordFor(run: Run): { word: Word; note: string } {
  if (run.state === "queued") return { word: "waiting", note: "queued" };
  if (run.state === "running") return { word: "working", note: "now" };
  return { word: "waiting", note: "paused, resumes soon" };
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

function tellForm(repo: Repo, builders: readonly Agent[]): Html {
  const base = repoBase(repo);
  return html`<form method="post" action="${base}/tell" class="studio-tell">
    <label class="sr-only" for="tell">Tell the crew</label>
    <textarea
      class="input"
      id="tell"
      name="text"
      rows="2"
      required
      placeholder="${builders.length === 0
        ? "Add a crew member under Settings → Crew, then tell them what you want."
        : "Make the greeting page load in under a second on my phone."}"
    ></textarea>
    ${btn("Tell the crew", { variant: "primary", type: "submit" })}
  </form>`;
}

function previewBlock(ctx: Ctx, repo: Repo, record: AppRecord): Html {
  const runtime = appsRuntime(ctx.app);
  const base = repoBase(repo);
  const envs: EnvStatus[] = runtime === undefined ? [] : runtime.status(record);
  const production = envs.find((e) => e.env === "production");
  const url = runtime?.urlFor(record, "production");
  const state = production?.state ?? "stopped";
  const words: Record<string, string> = {
    running: "live",
    starting: "starting",
    deploying: "starting",
    failed: "not up",
    stopped: "not running",
  };
  return html`<div class="studio-preview" data-state="${state}">
    <div class="studio-preview-head">
      <span class="studio-live" data-state="${state}"
        >${words[state] ?? state}</span
      >
      ${when(
        url,
        (u) =>
          html`<a href="${base}/app/production/open" class="mono"
            >${u.replace(/^https?:\/\//, "")}</a
          >`,
      )}
      <span class="spacer"></span>
      ${btn("Open", {
        href: `${base}/app/production/open`,
        size: "sm",
        variant: "primary",
      })}
    </div>
    ${production?.commitOid
      ? html`<p class="muted small">
          serving
          ${production.commitOid.slice(0, 7)}${production.since
            ? html` since ${time(production.since)}`
            : null}
        </p>`
      : html`<p class="muted small">Nothing is serving yet.</p>`}
  </div>`;
}

export function studioApp(ctx: Ctx, repo: Repo, record: AppRecord): Response {
  const db = ctx.app.db;
  const base = repoBase(repo);
  const crew = listCrewRoles(db, repo.id);
  const builders = crew.filter((c) => c.role === "builder").map((c) => c.agent);
  const runs = listRuns(db, repo.id, { kind: "agent", limit: 8 });
  const actors = new Map<string, User>();
  for (const r of runs)
    if (r.actorId !== null && !actors.has(r.actorId)) {
      const u = getUserById(db, r.actorId);
      if (u) actors.set(r.actorId, u);
    }
  const issues = new Map<string, Issue>();
  for (const r of runs)
    if (r.issueId !== null && !issues.has(r.issueId)) {
      const i = getIssueById(db, r.issueId);
      if (i) issues.set(r.issueId, i);
    }
  const decisions = decisionsFor(ctx, [repo]);
  const openPulls = listPulls(db, repo.id, { state: "open", limit: 10 });
  const week = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
  const weekRuns = listRuns(db, repo.id, { kind: "agent", limit: 200 }).filter(
    (r) => r.createdAt >= week,
  );
  const spent = weekRuns.reduce((s, r) => s + r.costUsd, 0);
  const shipped = listPulls(db, repo.id, {
    state: "closed",
    limit: 100,
  }).filter((p) => p.mergedAt !== null && p.mergedAt >= week).length;
  const autonomy =
    repo.autonomy === "off" ? undefined : autonomyStatus(ctx.app, repo);
  const moving = runs.some(
    (r) => r.state === "running" || r.state === "queued",
  );

  // What was told and not yet picked up: assigned to the crew, no run yet.
  const ran = new Set(runs.map((r) => r.issueId));
  const told = listIssues(db, repo.id, {
    kind: "issue",
    state: "open",
    limit: 20,
  })
    .filter((i) => i.assigneeIsAgent && !ran.has(i.id))
    .slice(0, 5);
  const now = html`<section class="studio-now">
    <h2>Now</h2>
    ${runs.length === 0 && openPulls.length === 0 && told.length === 0
      ? html`<p class="muted small">Nothing yet. Tell the crew something.</p>`
      : html`<ul class="studio-list">
          ${told.map(
            (i) =>
              html`<li data-word="waiting">
                ${icon(WORD_ICON.waiting)}
                <span class="studio-who">${i.assigneeName}</span>
                <a href="${base}/issues/${i.number}">${i.title}</a>
                <span class="studio-word">waiting</span>
              </li>`,
          )}
          ${openPulls.map((p) => {
            const check = latestRunsForIssues(db, [p.id]).get(p.id);
            const state =
              check?.state === "ok"
                ? "look"
                : check?.state === "failed"
                  ? "stopped"
                  : "working";
            return html`<li data-word="${state}">
              ${icon(WORD_ICON[state])}
              <span class="studio-who">${p.authorName}</span>
              <a href="${base}/pulls/${p.number}">${p.title}</a>
              <span class="studio-word"
                >${state === "look"
                  ? "look"
                  : state === "stopped"
                    ? "stopped"
                    : "checking"}</span
              >
            </li>`;
          })}
          ${runs.map((r) => {
            const { word, note } = wordFor(r);
            const who =
              r.actorId === null
                ? "crew"
                : (actors.get(r.actorId)?.username ?? "crew");
            const about =
              r.issueId === null ? undefined : issues.get(r.issueId);
            return html`<li data-word="${word}">
              ${icon(WORD_ICON[word])}
              <span class="studio-who">${who}</span>
              <a href="${base}/runs/${r.id}">${about?.title ?? note}</a>
              <span class="studio-word"
                >${word}${word === "working"
                  ? ""
                  : html` · ${time(r.finishedAt ?? r.createdAt)}`}</span
              >
            </li>`;
          })}
        </ul>`}
  </section>`;

  const asks = when(
    decisions.length > 0,
    () =>
      html`<section class="studio-asks">
        <h2>Asks you</h2>
        ${decisions.map((d) => decisionCard(ctx, d))}
      </section>`,
  );

  const rail = html`<aside class="studio-rail">
    <section>
      <h3>Crew on this app</h3>
      ${crew.length === 0
        ? html`<p class="muted small">
            Nobody yet. <a href="${base}/settings/crew">Add someone.</a>
          </p>`
        : html`<ul class="studio-crew">
            ${crew.map(
              (c) =>
                html`<li>
                  <b>${c.agent.user.username}</b
                  ><span
                    >${c.role === "builder"
                      ? "builds"
                      : c.role === "planner"
                        ? "plans"
                        : "reviews"}</span
                  >
                </li>`,
            )}
          </ul>`}
    </section>
    <section>
      <h3>This week</h3>
      <ul class="studio-crew">
        <li>
          <b>shipped</b
          ><span>${shipped} change${shipped === 1 ? "" : "s"}</span>
        </li>
        <li><b>runs</b><span>${weekRuns.length}</span></li>
        <li>
          <b>spent</b
          ><span
            >$${spent.toFixed(2)}${shipped > 0
              ? ` · $${(spent / shipped).toFixed(2)} per shipped change`
              : ""}</span
          >
        </li>
      </ul>
    </section>
    ${when(
      autonomy,
      (a) =>
        html`<section>
          <h3>On its own</h3>
          <p class="small">
            ${repo.autonomy === "autonomous" ? "Autonomous" : "Assisted"} ·
            $${a.spentTodayUsd.toFixed(2)} of $${a.ceilingUsd.toFixed(0)} today
            · ${a.active} of ${a.slots} slots
            ${a.paused ? html`· <strong>paused</strong>` : null}
          </p>
          <p class="muted small">
            <a href="${base}/settings/autonomy">Change</a> ·
            <a href="${base}/map">the map</a>
          </p>
        </section>`,
    )}
    <section>
      <p class="muted small">
        <a href="${base}/map">Map</a> ·
        <a href="${base}/issues">Everything told</a> ·
        <a href="${base}/pulls">Every change</a>
      </p>
    </section>
  </aside>`;

  const body = html`${repoHeader(ctx, repo, "code", { compact: true })}
    <div class="studio">
      <div class="studio-main">
        ${previewBlock(ctx, repo, record)} ${tellForm(repo, builders)} ${asks}
        ${now}
      </div>
      ${rail}
    </div>
    ${when(moving, () => liveMount({ repo: base }))}`;
  return page({
    ctx,
    title: `${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(repo),
    body,
    styleCss: studioCss,
    scriptJs: liveClientJs,
  });
}

// ---- the studio home ----

/**
 * The home in the studio: what asks you first, then every app as one row
 * that carries a real signal — live or not, what the crew last did there,
 * how many things wait on you — and beside it what is happening right now
 * across all of them, and what a person put on you. Built from the same
 * rows and cards as the rest of the forge, so it reads as the forge.
 */
export function studioHome(ctx: Ctx, user: User): Response {
  const db = ctx.app.db;
  const repos = listReposVisibleTo(db, user, { limit: 200 });
  const records = appsForRepos(
    db,
    repos.map((r) => r.id),
  );
  const runtime = appsRuntime(ctx.app);
  const appRepos = repos.filter((r) => records.has(r.id));
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
  const decisions = decisionsFor(ctx, appRepos);
  const asksByRepo = new Map<string, number>();
  for (const d of decisions)
    asksByRepo.set(d.repo.id, (asksByRepo.get(d.repo.id) ?? 0) + 1);

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
            ${btn("New app", { href: "/apps/new", size: "sm", icon: "plus" })}`,
        });

  const asks = when(decisions.length > 0, () =>
    listCard(
      decisions.map((d) => decisionRow(ctx, d)),
      {
        head: html`${icon("alert")}
          <h2>Asks you</h2>
          <span class="muted small">decide, and the crew carries on</span>`,
      },
    ),
  );

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
  const now =
    running.length === 0
      ? card(html`<p class="muted small">Nobody is working right now.</p>`, {
          head: html`${icon("activity")}
            <h2>Happening now</h2>`,
        })
      : listCard(
          running.map((r) => {
            const repo = byId.get(r.repoId)!;
            const who =
              r.actorId === null
                ? "crew"
                : (runActors.get(r.actorId)?.username ?? "crew");
            return row({
              href: `${repoBase(repo)}/runs/${r.id}`,
              nav: true,
              lead: icon(r.state === "running" ? "loader" : "clock"),
              title: html`${who} · ${repo.name}`,
              meta: html`${r.state === "running"
                ? "working"
                : "waiting"}${r.startedAt
                ? html` since ${time(r.startedAt)}`
                : null}`,
            });
          }),
          {
            head: html`${icon("activity")}
              <h2>Happening now</h2>`,
          },
        );

  const body = html`<div class="dash">
    <div class="dash-main stack">${asks} ${apps}</div>
    <aside class="dash-rail stack">
      ${now} ${onYouCard(ctx, user) ?? null}
    </aside>
  </div>`;
  return page({
    ctx,
    title: "Studio",
    body,
    styleCss: studioCss,
    scriptJs: liveClientJs,
  });
}

/** One decision as a row: what it says, and the options in place. */
function decisionRow(ctx: Ctx, d: Decision): Html {
  return html`<div class="row studio-decision" data-kind="${d.kind}">
    <div class="row-body">
      <p class="studio-decision-says">
        <strong>${d.repo.name}</strong> · ${d.says}
      </p>
      <div class="studio-decision-options">${decisionOptions(ctx, d)}</div>
    </div>
  </div>`;
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
  const text = field(form, "text").trim();
  if (text === "")
    return flashTo(ctx, base, {
      tone: "danger",
      message: "Say something first.",
    });
  const firstLine = text.split(/\n/)[0]!.trim();
  const title =
    firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 77).trimEnd()}…`;
  const opened = openIssue(ctx.app, ctx.auth.user, repo, {
    title,
    body: text === firstLine ? "" : text,
  });
  if (!opened.ok)
    return flashTo(ctx, base, {
      tone: "danger",
      message: "That could not be told.",
    });
  const crew = listCrewRoles(ctx.app.db, repo.id);
  const builders = crew.filter((c) => c.role === "builder").map((c) => c.agent);
  const inFlight = new Map<string, number>();
  for (const r of listRuns(ctx.app.db, repo.id, { kind: "agent", limit: 50 }))
    if ((r.state === "running" || r.state === "queued") && r.actorId !== null)
      inFlight.set(r.actorId, (inFlight.get(r.actorId) ?? 0) + 1);
  const builder = pickBuilder(opened.value, builders, inFlight);
  if (builder === undefined)
    return flashTo(ctx, base, {
      message: `Told. Nobody is on the crew to take it yet — add someone under Settings → Crew.`,
    });
  const assigned = assignIssue(
    ctx.app,
    ctx.auth.user,
    repo,
    opened.value,
    builder.user,
  );
  return flashTo(ctx, base, {
    message: assigned.ok
      ? `${builder.user.username} is on it. Watch it work below.`
      : `Told as #${opened.value.number}, but ${builder.user.username} could not take it.`,
  });
}

/** POST /:owner/:name/pulls/:number/ship — land a green change. */
export async function shipSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const base = repoBase(repo);
  const number = Number(ctx.params.number);
  const pull = Number.isInteger(number)
    ? getPull(ctx.app.db, repo.id, number)
    : undefined;
  if (!pull) return notFoundPage(ctx);
  const merged = await mergePull(ctx.app, ctx.auth.user, repo, pull, "squash");
  return flashTo(ctx, base, {
    ...(merged.ok
      ? { message: `Shipped "${pull.title}". Production is redeploying.` }
      : {
          tone: "danger" as const,
          message: `That could not ship: ${String(merged.error).replace(/_/g, " ")}.`,
        }),
  });
}

/** POST /:owner/:name/pulls/:number/say  { text } — feedback to the crew. */
export async function saySubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const base = repoBase(repo);
  const number = Number(ctx.params.number);
  const pull = Number.isInteger(number)
    ? getPull(ctx.app.db, repo.id, number)
    : undefined;
  if (!pull) return notFoundPage(ctx);
  const text = field(form, "text").trim();
  if (text === "")
    return flashTo(ctx, base, {
      tone: "danger",
      message: "Say something first.",
    });
  const said = addComment(ctx.app, ctx.auth.user, repo, pull, text);
  return flashTo(ctx, base, {
    ...(said.ok
      ? { message: `Told ${pull.authorName}. It picks the change back up.` }
      : { tone: "danger" as const, message: "That could not be said." }),
  });
}

/** POST /mode  { mode } — studio or dev, for this browser. */
export async function modeSubmit(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx);
  if (form instanceof Response) return form;
  const choice = field(form, "mode");
  const back = field(form, "back") || ctx.request.headers.get("referer") || "/";
  const secure = ctx.url.protocol === "https:";
  return redirect(
    back.startsWith("/") || back.startsWith(ctx.url.origin) ? back : "/",
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
.studio-tell { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: start; }
.studio-tell textarea { min-height: 52px; resize: vertical; }
.studio-now h2, .studio-asks h2 { font-size: 14px; margin: 0 0 8px; }
.studio-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.studio-list li { display: grid; grid-template-columns: 18px 84px minmax(0, 1fr) auto; gap: 10px; align-items: baseline; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 14px; }
.studio-list li svg { vertical-align: -3px; }
.studio-who { font-weight: 600; }
.studio-word { font-family: var(--mono); font-size: 11.5px; opacity: .8; white-space: nowrap; }
.row-meta .studio-word { font-family: inherit; font-size: inherit; opacity: 1; font-weight: 560; }
.studio-list li[data-word="working"] .studio-word { color: var(--accent); opacity: 1; }
.studio-list li[data-word="look"] .studio-word { color: var(--merged); opacity: 1; }
.studio-list li[data-word="stopped"] .studio-word { color: var(--danger, #c33); opacity: 1; }
.studio-decision { display: grid; gap: 10px; padding: 12px 14px; border-left: 3px solid var(--accent); }
.studio-asks .studio-decision { border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 10px; background: var(--bg); }
.studio-decision[data-kind="stopped"] { border-left-color: var(--danger, #c33); }
.studio-decision[data-kind="paused"] { border-left-color: var(--border); }
.studio-decision-says { margin: 0; font-size: 14.5px; }
.studio-decision-options { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.studio-decision-options form { display: flex; gap: 6px; align-items: center; margin: 0; }
.studio-say .input { min-width: 240px; }
.studio-rail { display: grid; gap: 18px; align-content: start; }
.studio-rail h3 { font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; opacity: .7; margin: 0 0 6px; font-weight: 600; }
.studio-crew { list-style: none; margin: 0; padding: 0; display: grid; gap: 5px; font-size: 13.5px; }
.studio-crew li { display: grid; grid-template-columns: 74px 1fr; gap: 8px; }
.studio-crew li b { font-weight: 600; }
.studio-crew li span { opacity: .85; }
`;
