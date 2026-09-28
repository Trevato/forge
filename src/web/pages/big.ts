/**
 * The big view: the whole forge as one full-screen, keyboard-first frame
 * — a header line, a body of panes, a footer line of keys — with the feel
 * of k9s, lazygit and btop, in the browser, and from a couch with a
 * gamepad. A second front door, not a re-skin: every pane reads the same
 * tables the studio and the board read, and every action is one key that
 * presses a real control.
 *
 * Views are server-rendered pages under one shell (`/big`, `?app=`,
 * `?run=`, `?view=board|map`, `&list=runs|issues|pulls|map`); the client
 * script is the same on every one, the focus is remembered per address,
 * and the live regions keep the page fresh in place.
 */

import { getAppByRepo, appsForRepos } from "../../core/apps.ts";
import { listDecisionsForRepos } from "../../core/decisions.ts";
import { criticalPath, readyNow, repoGraph } from "../../core/dependencies.ts";
import {
  getIssue,
  getIssueById,
  getIssuesByIds,
  listIssues,
  type Issue,
} from "../../core/issues.ts";
import { listPulls, mergedPullsForRepos, type Pull } from "../../core/pulls.ts";
import {
  canRead,
  canWrite,
  getRepo,
  getRepoById,
  listReposVisibleTo,
  type Repo,
} from "../../core/repos.ts";
import {
  getRun,
  isTerminal,
  latestRunsForIssues,
  listActiveRuns,
  listRuns,
  type Run,
} from "../../core/runs.ts";
import { getUsersByIds, type User } from "../../core/users.ts";
import { autonomyStatus } from "../../crew/autonomy.ts";
import type { Ctx } from "../../http/context.ts";
import {
  backUrl,
  bigUrl,
  COMMANDS,
  footKeysFor,
  keysFor,
  type ListKind,
  type View,
  type Where,
} from "../big-model.ts";
import { bigJs } from "../big.ts";
import { notFoundPage, repoBase, signInFirst } from "../chrome.ts";
import { liveRegionsJs, runLogJs } from "../client.ts";
import { html, when, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { bigCss } from "../style/big.ts";
import { avatar, runStateBadge, time } from "../ui.ts";
import { boardCss, boardRegions, boardScope } from "./board.ts";
import {
  countWords,
  drawMap,
  drawingWidth,
  emphasisFor,
  globalLanes,
  laneHtml,
  layout,
  mapCss,
  mapViewJs,
  marksFor,
  wordFor as mapWordFor,
} from "./map.ts";
import {
  costText,
  durationText,
  logLine,
  reasonWords,
  runTitle,
} from "./runs.ts";
import { runLog } from "../../actions/runs.ts";

// ---- words ----

const money = (n: number): string => `$${n.toFixed(2)}`;
const pct = (n: number): number =>
  Math.max(0, Math.min(100, Math.round(n * 100)));

type RunWord = "working" | "queued" | "paused";
function runWord(run: Run): RunWord {
  if (run.state === "running") return "working";
  return run.notBefore === null ? "queued" : "paused";
}
const startedAt = (r: Run): string => r.startedAt ?? r.createdAt;

/** Why a run exists, as a person reads it beside its clock. */
function why(run: Run): string {
  switch (run.reason) {
    case "assigned":
      return "building it";
    case "feedback":
      return "on what you said";
    case "check_failed":
      return "fixing the check";
    case "conflict":
      return "catching up with main";
    case "review":
      return "reviewing it";
    case "":
      return "working";
    default:
      return run.reason.replace(/_/g, " ");
  }
}

const KIND_WORDS = {
  next: "next issue",
  land: "landing",
  retry: "try again",
  lean: "a lean",
};

// ---- the shell ----

interface Shell {
  readonly view: View;
  readonly layout: "home" | "app" | "run" | "wall" | "lanes" | "list";
  readonly title: string;
  /** After `home`: the path down to here. */
  readonly crumbs: readonly { label: string; href?: string }[];
  readonly panes: Html;
  readonly where: Where;
  /** The app open here, `owner/name`, for the command line and the footer. */
  readonly here?: string | undefined;
  readonly back: string;
  /** Where a word goes when nothing more specific is focused. */
  readonly say?: string | undefined;
  readonly sayWho?: string | undefined;
  /** The web UI's page for this view, for `o`. */
  readonly open?: string | undefined;
  readonly apps: readonly string[];
  readonly css?: string | undefined;
  readonly js?: string | undefined;
}

const chips = (keys: readonly string[]): Html =>
  html`${keys.map((k) => html`<kbd>${k}</kbd>`)}`;

/** The footer: what fits on one line. A letter that opens a view carries where. */
function foot(s: Shell): Html {
  const go: Record<string, string> = {};
  if (s.here !== undefined) {
    go["r"] = bigUrl({ app: s.here, list: "runs" });
    go["i"] = bigUrl({ app: s.here, list: "issues" });
    go["p"] = bigUrl({ app: s.here, list: "pulls" });
    go["m"] = bigUrl({ app: s.here, list: "map" });
  }
  return html`<footer class="big-foot" id="big-foot">
    ${footKeysFor(s.view).map((k) => {
      const first = k.keys[0] ?? "";
      const target = k.keys.length === 1 ? go[first] : undefined;
      return html`<span
        class="big-key"
        data-k="${first}"
        ${target === undefined ? null : html`data-go="${target}"`}
        >${chips(k.keys)}${k.does}</span
      >`;
    })}
    <span class="spacer"></span>
    <span class="big-foot-view">${s.view}</span>
  </footer>`;
}

/** The sheet `?` opens: every key for this view, then the command line's words. */
function sheet(s: Shell): Html {
  return html`<dialog class="modal big-help" id="big-help" aria-label="Keys">
    <div class="big-help-cols">
      <div>
        <h2>Keys · ${s.view}</h2>
        <table>
          <tbody>
            ${keysFor(s.view).map(
              (k) =>
                html`<tr>
                  <td>${chips(k.keys)}</td>
                  <td>${k.does}</td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
      <div>
        <h2>Commands · <kbd>:</kbd></h2>
        <table>
          <tbody>
            ${COMMANDS.map(
              (c) =>
                html`<tr>
                  <td>
                    <span class="big-cmd"
                      >:${c.name}${c.arg === undefined
                        ? null
                        : html` <i>${c.arg}</i>`}</span
                    >
                  </td>
                  <td>${c.does}</td>
                </tr>`,
            )}
          </tbody>
        </table>
        <p>
          A gamepad works too: the d-pad and left stick move, A opens, B goes
          back, Y is this sheet, the bumpers switch panes.
        </p>
      </div>
    </div>
  </dialog>`;
}

function shell(ctx: Ctx, s: Shell): Response {
  const body = html`<div
    class="big"
    id="big"
    data-view="${s.view}"
    data-back="${s.back}"
    data-here="${s.here ?? ""}"
    data-apps="${s.apps.join(" ")}"
    ${when(s.say, (v) => html`data-say="${v}"`)}
    ${when(s.sayWho, (v) => html`data-say-who="${v}"`)}
    ${when(s.open, (v) => html`data-open="${v}"`)}
  >
    <header class="big-top">
      <a class="big-brand" href="/"><span class="mark"></span>forge</a>
      <nav class="big-crumbs" aria-label="Where you are">
        <a href="/big">home</a>
        ${s.crumbs.map(
          (c, i) =>
            html`<span aria-hidden="true">›</span>${i === s.crumbs.length - 1 ||
              c.href === undefined
                ? html`<b>${c.label}</b>`
                : html`<a href="${c.href}">${c.label}</a>`}`,
        )}
      </nav>
      <span class="spacer"></span>
      <span
        class="big-hint"
        id="big-hint"
        role="status"
        aria-live="polite"
      ></span>
      <span class="big-pad" aria-hidden="true">gamepad</span>
      <span
        class="big-live"
        id="big-live"
        data-state="connecting"
        title="The live stream"
        ><span class="big-dot"></span
      ></span>
      <time class="big-clock" id="big-clock"></time>
    </header>
    <div class="big-body" data-layout="${s.layout}">${s.panes}</div>
    ${foot(s)}
    <form class="big-line" id="big-line" method="post" action="" hidden>
      <span class="big-line-mark" id="big-line-mark" aria-hidden="true">:</span>
      <label class="sr-only" for="big-line-in">The line</label>
      <input
        class="big-line-in"
        id="big-line-in"
        name="text"
        autocomplete="off"
        spellcheck="false"
      />
      <span class="big-line-note" id="big-line-note"></span>
    </form>
    ${sheet(s)}
  </div>`;
  return page({
    ctx,
    title: s.title,
    body,
    bare: true,
    theme: "dark",
    styleCss: `${bigCss}\n${s.css ?? ""}`,
    scriptJs: `${liveRegionsJs}\n${s.js ?? ""}\n${bigJs}`,
  });
}

/** One pane: a numbered heading, then rows that scroll. */
function pane(o: {
  name: string;
  n: number;
  title: string;
  count?: number | undefined;
  note?: Html | undefined;
  body: Html;
  live?: string | undefined;
  repo?: Repo | undefined;
  say?: string | undefined;
  sayWho?: string | undefined;
  cls?: string | undefined;
}): Html {
  return html`<section
    class="big-pane${o.cls === undefined ? "" : ` ${o.cls}`}"
    data-pane="${o.name}"
    data-n="${o.n}"
    id="big-${o.name}"
    ${when(o.live, (v) => html`data-live="${v}"`)}
    ${when(o.repo, (r) => html`data-live-repo="${r.ownerName}/${r.name}"`)}
    ${when(o.say, (v) => html`data-say="${v}"`)}
    ${when(o.sayWho, (v) => html`data-say-who="${v}"`)}
    aria-labelledby="big-${o.name}-h"
  >
    <h2 class="big-h" id="big-${o.name}-h">
      <kbd aria-hidden="true">${o.n}</kbd>${o.title}
      ${when(
        o.count !== undefined && o.count > 0,
        () => html`<span class="big-count">${o.count}</span>`,
      )}
      <span class="spacer"></span>
      ${when(o.note, (v) => html`<span class="big-h-note">${v}</span>`)}
    </h2>
    <div class="big-scroll">${o.body}</div>
  </section>`;
}

const rows = (items: Html[], quiet: string): Html =>
  items.length === 0
    ? html`<p class="big-quiet">${quiet}</p>`
    : html`<ul class="big-rows">
        ${items}
      </ul>`;

/** A `<kbd>` chip on a control, so the key and the button are one thing. */
const act = (key: string, label: string, form: string, lead = false): Html =>
  html`<button
    class="big-act"
    type="submit"
    form="${form}"
    data-act="${key}"
    ${lead ? html`data-lead=""` : null}
  >
    <kbd>${key}</kbd>${label}
  </button>`;

const sayChip = (lead = false): Html =>
  html`<button
    class="big-act"
    type="button"
    data-say-open=""
    ${lead ? html`data-lead=""` : null}
  >
    <kbd>t</kbd>tell
  </button>`;

// ---- the route ----

/** The apps the viewer can see, as repositories: the big view's whole world. */
function visibleApps(ctx: Ctx, user: User): Repo[] {
  const repos = listReposVisibleTo(ctx.app.db, user, { limit: 200 });
  const records = appsForRepos(
    ctx.app.db,
    repos.map((r) => r.id),
  );
  return repos.filter((r) => records.has(r.id));
}

const slug = (repo: Repo): string => `${repo.ownerName}/${repo.name}`;

const isList = (v: string | null): v is ListKind =>
  v === "runs" || v === "issues" || v === "pulls" || v === "map";

/** GET /big — signed in. `?app=owner/name`, `?run=id`, `?view=board|map`. */
export function bigPage(ctx: Ctx): Response {
  const user = ctx.auth.user;
  if (!user) return signInFirst(ctx);
  const q = ctx.url.searchParams;
  const apps = visibleApps(ctx, user);
  const names = apps.map(slug);

  const runId = q.get("run");
  if (runId !== null) {
    const run = getRun(ctx.app.db, runId);
    const repo =
      run === undefined ? undefined : getRepoById(ctx.app.db, run.repoId);
    if (!run || !repo || !canRead(ctx.app.db, repo, user))
      return notFoundPage(ctx);
    return runView(ctx, user, repo, run, names);
  }
  const appName = q.get("app");
  if (appName !== null) {
    const [owner, name] = appName.split("/");
    const repo = owner && name ? getRepo(ctx.app.db, owner, name) : undefined;
    if (!repo || !canRead(ctx.app.db, repo, user)) return notFoundPage(ctx);
    if (getAppByRepo(ctx.app.db, repo.id) === undefined)
      return notFoundPage(ctx);
    const list = q.get("list");
    return isList(list)
      ? listView(ctx, user, repo, list, names)
      : appView(ctx, user, repo, names);
  }
  const view = q.get("view");
  if (view === "board") return boardView(ctx, user, apps, names);
  if (view === "map") return mapView(ctx, user, names);
  return homeView(ctx, user, apps, names);
}

// ---- home: every app, and the focused one at a glance ----

function homeView(
  ctx: Ctx,
  user: User,
  apps: readonly Repo[],
  names: readonly string[],
): Response {
  const db = ctx.app.db;
  const ids = apps.map((r) => r.id);
  const running = listActiveRuns(db, ids);
  const actors = getUsersByIds(
    db,
    running.map((r) => r.actorId).filter((id): id is string => id !== null),
  );
  const about = getIssuesByIds(
    db,
    running.map((r) => r.issueId).filter((id): id is string => id !== null),
  );
  const runsBy = new Map<string, Run[]>();
  for (const r of running)
    runsBy.set(r.repoId, [...(runsBy.get(r.repoId) ?? []), r]);
  const working = running.filter((r) => r.state === "running").length;
  const waiting = running.length - working;

  const appRows = apps.map((repo) => {
    const key = `app:${slug(repo)}`;
    const flying = runsBy.get(repo.id) ?? [];
    const working = flying.filter((r) => r.state === "running").length;
    const status =
      repo.autonomy === "off" ? undefined : autonomyStatus(ctx.app, repo);
    const share =
      status === undefined || status.ceilingUsd <= 0
        ? 0
        : status.spentTodayUsd / status.ceilingUsd;
    return html`<li
      class="big-row"
      data-kind="app"
      data-key="${key}"
      data-href="${bigUrl({ app: slug(repo) })}"
      data-open="${repoBase(repo)}"
      data-say="${repoBase(repo)}/tell"
      data-say-who="${repo.name}'s crew"
      tabindex="-1"
    >
      <span class="big-t"
        >${repo.name}${repo.description === ""
          ? null
          : html` <small>· ${repo.description}</small>`}</span
      >
      <span
        class="big-word"
        data-word="${status?.paused === "ceiling" ? "paused" : repo.autonomy}"
        >${status?.paused === "ceiling" ? "at ceiling" : repo.autonomy}</span
      >
      <span
        class="big-n"
        ${working === 0 ? html`data-zero=""` : html`data-hot=""`}
        ><b>${working}</b> working</span
      >
      ${status === undefined
        ? html`<span class="big-spend"><span></span><span>—</span></span>`
        : html`<span class="big-spend"
            ><span class="big-bar"
              ><span
                class="big-fill"
                data-w="${pct(share)}"
                ${share >= 0.9 ? html`data-near=""` : null}
              ></span></span
            ><span
              >${money(status.spentTodayUsd)} /
              $${status.ceilingUsd.toFixed(0)}</span
            ></span
          >`}
    </li>`;
  });

  const glances = apps.map((repo) => {
    const base = repoBase(repo);
    const flying = runsBy.get(repo.id) ?? [];
    const landed = mergedPullsForRepos(db, [repo.id], 3);
    const decided = listDecisionsForRepos(db, [repo.id], 3);
    const decidedAbout = getIssuesByIds(
      db,
      decided.map((d) => d.issueId).filter((id): id is string => id !== null),
    );
    const status =
      repo.autonomy === "off" ? undefined : autonomyStatus(ctx.app, repo);
    const direction =
      repo.autonomyDirection.split("\n")[0]?.trim() ||
      repo.description ||
      "No direction yet.";
    return html`<div
      class="big-glance"
      data-for="app:${slug(repo)}"
      data-name="${repo.name}"
      hidden
    >
      <p class="big-glance-dir">
        ${direction}
        <small
          >${repo.autonomy === "off"
            ? "not running on its own"
            : `${repo.autonomy} · ${money(status?.spentTodayUsd ?? 0)} of $${(status?.ceilingUsd ?? 0).toFixed(0)} today · ${status?.active ?? 0} of ${status?.slots ?? 0} slots`}</small
        >
      </p>
      <h3 class="big-sub">Working</h3>
      ${rows(
        flying.map((r) => runRow(base, r, actors, about, undefined)),
        "Nobody is working here right now.",
      )}
      <h3 class="big-sub">Landed</h3>
      ${rows(
        landed.map((p) => landedRow(base, p)),
        "Nothing has shipped yet.",
      )}
      <h3 class="big-sub">Decided</h3>
      ${rows(
        decided.map((d) => decisionRow(db, repo, d, decidedAbout)),
        "Nothing decided yet.",
      )}
    </div>`;
  });

  const live = "run.*,pull.*,issue.*,check.*";
  const panes = html`${pane({
    name: "apps",
    n: 1,
    title: "Apps",
    count: apps.length,
    note: html`${working}
    working${waiting > 0 ? html` · ${waiting} waiting` : null}`,
    body: rows(appRows, "No apps yet. Make one at /apps/new."),
    live,
  })}
  ${pane({
    name: "glance",
    n: 2,
    title: "At a glance",
    body: html`${glances}
      <div class="big-glance-empty">Pick an app</div>`,
    live,
  })}`;
  return shell(ctx, {
    view: "home",
    layout: "home",
    title: "Big",
    crumbs: [],
    panes,
    where: {},
    back: "/",
    open: "/",
    apps: names,
  });
}

// ---- rows the views share ----

function runRow(
  base: string,
  run: Run,
  actors: ReadonlyMap<string, User>,
  about: ReadonlyMap<string, Issue>,
  stopForm: string | undefined,
): Html {
  const who =
    run.actorId === null
      ? "crew"
      : (actors.get(run.actorId)?.username ?? "crew");
  const issue = run.issueId === null ? undefined : about.get(run.issueId);
  const word = runWord(run);
  const live = run.state === "running" || run.state === "queued";
  return html`<li
    class="big-row"
    data-kind="run"
    data-key="run:${run.id}"
    data-href="${bigUrl({ run: run.id })}"
    data-open="${base}/runs/${run.id}"
    data-state="${live ? word : run.state}"
    tabindex="-1"
  >
    ${avatar(who)}
    <span class="big-m"><b>${who}</b></span>
    <span class="big-t"
      >${issue?.title ?? (run.summary || "on the repository")}
      <small class="big-m"
        >·
        ${live
          ? word === "paused"
            ? "resumes soon"
            : why(run)
          : run.summary || run.state}</small
      ></span
    >
    ${live
      ? html`<span class="big-el" data-started="${startedAt(run)}"></span>`
      : html`<span class="big-el">${durationText(run) ?? "—"}</span>`}
    <span class="big-cost">${run.costUsd > 0 ? money(run.costUsd) : ""}</span>
    <span class="big-acts"
      >${live
        ? html`<span class="big-word" data-word="${word}">${word}</span>`
        : html`<span class="big-word" data-word="${run.state}"
            >${run.state === "ok" ? "done" : run.state}</span
          >`}${stopForm === undefined
        ? null
        : act("x", run.state === "running" ? "stop" : "cancel", stopForm)}</span
    >
  </li>`;
}

function landedRow(base: string, pull: Pull): Html {
  return html`<li
    class="big-row"
    data-kind="landed"
    data-key="pull:${pull.id}"
    data-href="${base}/pulls/${pull.number}"
    tabindex="-1"
  >
    <span class="big-t">${pull.title}</span>
    <span class="big-m">${pull.authorName}</span>
    <span class="big-when">${time(pull.mergedAt ?? pull.createdAt)}</span>
  </li>`;
}

function decisionRow(
  db: Ctx["app"]["db"],
  repo: Repo,
  d: ReturnType<typeof listDecisionsForRepos>[number],
  about: ReadonlyMap<string, Issue>,
): Html {
  const base = repoBase(repo);
  let issue: Issue | undefined =
    d.issueId === null ? undefined : about.get(d.issueId);
  if (d.kind === "next" && /^\d+$/.test(d.answer))
    issue = getIssue(db, repo.id, Number(d.answer)) ?? issue;
  const href =
    issue === undefined
      ? base
      : `${base}/${issue.kind === "pull" ? "pulls" : "issues"}/${issue.number}`;
  const answer =
    d.kind === "next" && issue !== undefined ? `#${issue.number}` : d.answer;
  return html`<li
    class="big-row"
    data-kind="decision"
    data-key="decision:${d.id}"
    data-href="${href}"
    tabindex="-1"
  >
    <span class="big-word">${KIND_WORDS[d.kind]}</span>
    <span class="big-t">${answer}</span>
    <span class="big-m"
      >${issue?.title ?? repo.name} ·
      ${d.by === "rule" ? "by the rule" : `by ${d.by}`}</span
    >
    <span class="big-p" title="how sure">${Math.round(d.p * 100)}%</span>
    <span class="big-word" data-word="${d.outcome ?? ""}"
      >${d.outcome ?? "—"}</span
    >
    <span class="big-when">${time(d.createdAt)}</span>
  </li>`;
}

/** The hidden form a run's stop chip submits, when the viewer may. */
function stopFormFor(ctx: Ctx, repo: Repo, run: Run): string | undefined {
  if (run.kind !== "agent") return undefined;
  if (run.state !== "running" && run.state !== "queued") return undefined;
  if (!canWrite(ctx.app.db, repo, ctx.auth.user)) return undefined;
  return `stop-${run.id}`;
}

const stopForms = (
  base: string,
  runs: readonly Run[],
  ids: ReadonlyMap<string, string>,
): Html =>
  html`${runs.map((r) =>
    when(
      ids.get(r.id),
      (id) =>
        html`<form
          id="${id}"
          method="post"
          action="${base}/runs/${r.id}/cancel"
          hidden
        ></form>`,
    ),
  )}`;

// ---- app: working, asks, the map, landed ----

function appView(
  ctx: Ctx,
  user: User,
  repo: Repo,
  names: readonly string[],
): Response {
  const db = ctx.app.db;
  const base = repoBase(repo);
  const running = listActiveRuns(db, [repo.id]);
  running.sort((a, b) => {
    if ((a.state === "running") !== (b.state === "running"))
      return a.state === "running" ? -1 : 1;
    return startedAt(a).localeCompare(startedAt(b));
  });
  const actors = getUsersByIds(
    db,
    running.map((r) => r.actorId).filter((id): id is string => id !== null),
  );
  const about = getIssuesByIds(
    db,
    running.map((r) => r.issueId).filter((id): id is string => id !== null),
  );
  const stops = new Map<string, string>();
  for (const r of running) {
    const id = stopFormFor(ctx, repo, r);
    if (id !== undefined) stops.set(r.id, id);
  }
  const status =
    repo.autonomy === "off" ? undefined : autonomyStatus(ctx.app, repo);
  const landed = mergedPullsForRepos(db, [repo.id], 12);

  const graph = repoGraph(db, repo.id);
  const ready = readyNow(graph);
  const marks = marksFor(db, repo.id, graph, running);
  const readySet = new Set(ready.map((r) => r.issue.id));
  const counts = countWords(
    graph.issues.map((i) => mapWordFor(i, readySet, marks)),
  );

  const panes = html`${pane({
    name: "working",
    n: 1,
    title: "Working now",
    count: running.length,
    note:
      status === undefined
        ? html`${repo.autonomy}`
        : html`<b>${status.active}</b> of ${status.slots} slots ·
            <b>${money(status.spentTodayUsd)}</b> of
            $${status.ceilingUsd.toFixed(0)}
            today${status.paused === null
              ? null
              : html` · paused: ${status.paused}`}`,
    body: html`${rows(
      running.map((r) => runRow(base, r, actors, about, stops.get(r.id))),
      "Nobody is working right now. Tell the crew something.",
    )}${stopForms(base, running, stops)}`,
    live: "run.*",
    repo,
  })}
  ${pane({
    name: "map",
    n: 3,
    title: "Map",
    note: html`<b>${counts.ready}</b> ready · <b>${counts.working}</b> working ·
      <b>${counts.blocked}</b> blocked${counts.waiting > 0
        ? html` · <b>${counts.waiting}</b> waiting`
        : null}`,
    body: drawMap(
      repo,
      graph,
      layout(graph),
      emphasisFor(ready, criticalPath(graph), marks),
      { id: "big-map-canvas", cap: 0.42 },
    ),
    live: "run.*,issue.*,pull.*",
    repo,
  })}
  ${pane({
    name: "landed",
    n: 4,
    title: "Landed",
    count: landed.length,
    body: rows(
      landed.map((p) => landedRow(base, p)),
      "Nothing has shipped yet.",
    ),
    live: "pull.merged,run.finished",
    repo,
  })}`;
  return shell(ctx, {
    view: "app",
    layout: "app",
    title: `${repo.name} · big`,
    crumbs: [{ label: repo.name }],
    panes,
    where: { app: slug(repo) },
    here: slug(repo),
    back: "/big",
    say: `${base}/tell`,
    sayWho: `${repo.name}'s crew`,
    open: base,
    apps: names,
    css: mapCss,
    js: mapViewJs,
  });
}

// ---- lists: runs, issues, pulls, the map alone ----

function listView(
  ctx: Ctx,
  user: User,
  repo: Repo,
  kind: ListKind,
  names: readonly string[],
): Response {
  const db = ctx.app.db;
  const base = repoBase(repo);
  const where: Where = { app: slug(repo), list: kind };
  const common = {
    where,
    here: slug(repo),
    back: backUrl(where),
    say: `${base}/tell`,
    sayWho: `${repo.name}'s crew`,
    apps: names,
    crumbs: [
      { label: repo.name, href: bigUrl({ app: slug(repo) }) },
      { label: kind },
    ],
  };
  if (kind === "map") {
    const graph = repoGraph(db, repo.id);
    const ready = readyNow(graph);
    const marks = marksFor(db, repo.id, graph, listActiveRuns(db, [repo.id]));
    return shell(ctx, {
      ...common,
      view: "list",
      layout: "list",
      title: `Map · ${repo.name} · big`,
      open: `${base}/map`,
      panes: pane({
        name: "map",
        n: 1,
        title: "Map",
        note: html`what waits for what · the top edge is ready now`,
        body: drawMap(
          repo,
          graph,
          layout(graph),
          emphasisFor(ready, criticalPath(graph), marks),
          { id: "big-map-canvas", cap: 0.8 },
        ),
        live: "run.*,issue.*,pull.*",
        repo,
      }),
      css: mapCss,
      js: mapViewJs,
    });
  }
  if (kind === "runs") {
    const runs = listRuns(db, repo.id, { limit: 60 });
    const actors = getUsersByIds(
      db,
      runs.map((r) => r.actorId).filter((id): id is string => id !== null),
    );
    const about = getIssuesByIds(
      db,
      runs.map((r) => r.issueId).filter((id): id is string => id !== null),
    );
    const stops = new Map<string, string>();
    for (const r of runs) {
      const id = stopFormFor(ctx, repo, r);
      if (id !== undefined) stops.set(r.id, id);
    }
    return shell(ctx, {
      ...common,
      view: "list",
      layout: "list",
      title: `Runs · ${repo.name} · big`,
      open: `${base}/runs`,
      panes: pane({
        name: "runs",
        n: 1,
        title: "Runs",
        count: runs.length,
        body: html`${rows(
          runs.map((r) => runRow(base, r, actors, about, stops.get(r.id))),
          "No runs yet.",
        )}${stopForms(base, runs, stops)}`,
        live: "run.*",
        repo,
      }),
    });
  }
  if (kind === "issues") {
    const issues = listIssues(db, repo.id, { state: "open", limit: 60 });
    const active = new Set(
      listActiveRuns(db, [repo.id])
        .map((r) => r.issueId)
        .filter((id): id is string => id !== null),
    );
    return shell(ctx, {
      ...common,
      view: "list",
      layout: "list",
      title: `Issues · ${repo.name} · big`,
      open: `${base}/issues`,
      panes: pane({
        name: "issues",
        n: 1,
        title: "Open issues",
        count: issues.length,
        body: rows(
          issues.map(
            (i) =>
              html`<li
                class="big-row"
                data-kind="issue"
                data-key="issue:${i.id}"
                data-href="${base}/issues/${i.number}"
                tabindex="-1"
              >
                <span class="big-num">#${i.number}</span>
                <span class="big-t">${i.title}</span>
                <span class="big-m">${i.assigneeName ?? "nobody on it"}</span>
                <span
                  class="big-word"
                  data-word="${active.has(i.id) ? "working" : "waiting"}"
                  >${active.has(i.id) ? "working" : "open"}</span
                >
                <span class="big-when">${time(i.createdAt)}</span>
              </li>`,
          ),
          "Nothing open. Tell the crew something.",
        ),
        live: "run.*,issue.*",
        repo,
      }),
    });
  }
  const pulls = listPulls(db, repo.id, { state: "open", limit: 60 });
  const checks = latestRunsForIssues(
    db,
    pulls.map((p) => p.id),
  );
  const writer = canWrite(db, repo, user);
  const pullWord = (p: Pull): string => {
    const c = checks.get(p.id);
    return c?.state === "ok"
      ? "green"
      : c?.state === "failed"
        ? "red"
        : "checking";
  };
  return shell(ctx, {
    ...common,
    view: "list",
    layout: "list",
    title: `Pulls · ${repo.name} · big`,
    open: `${base}/pulls`,
    panes: pane({
      name: "pulls",
      n: 1,
      title: "Open pulls",
      count: pulls.length,
      body: html`${rows(
        pulls.map((p) => {
          const word = pullWord(p);
          return html`<li
            class="big-row"
            data-kind="pull"
            data-key="pull:${p.id}"
            data-href="${base}/pulls/${p.number}"
            data-say="${base}/pulls/${p.number}/say"
            data-say-who="${p.authorName}"
            tabindex="-1"
          >
            <span class="big-num">#${p.number}</span>
            <span class="big-t">${p.title}</span>
            <span class="big-m">${p.authorName}</span>
            <span class="big-acts"
              ><span class="big-word" data-word="${word}">${word}</span
              >${writer && word === "green"
                ? act("s", "ship", `ship-${p.id}`, true)
                : null}${writer
                ? act("x", "close", `close-${p.id}`)
                : null}</span
            >
            <span class="big-when">${time(p.createdAt)}</span>
          </li>`;
        }),
        "No open pulls.",
      )}${when(
        writer,
        () =>
          html`${pulls.map(
            (p) =>
              html`<form
                  id="ship-${p.id}"
                  method="post"
                  action="${base}/pulls/${p.number}/ship"
                  hidden
                >
                  <input type="hidden" name="pull" value="${p.number}" />
                </form>
                <form
                  id="close-${p.id}"
                  method="post"
                  action="${base}/pulls/${p.number}/state"
                  hidden
                >
                  <input type="hidden" name="state" value="closed" />
                </form>`,
          )}`,
      )}`,
      live: "run.*,pull.*,check.*",
      repo,
    }),
  });
}

// ---- run: the transcript, followed, and the steer line ----

function runView(
  ctx: Ctx,
  user: User,
  repo: Repo,
  run: Run,
  names: readonly string[],
): Response {
  const found = runLog(ctx.app, user, repo, run.id);
  if (!found.ok) return notFoundPage(ctx);
  const { lines, truncated } = found.value;
  const db = ctx.app.db;
  const base = repoBase(repo);
  const actor =
    run.actorId === null
      ? undefined
      : getUsersByIds(db, [run.actorId]).get(run.actorId);
  const issue =
    run.issueId === null ? undefined : getIssueById(db, run.issueId);
  const title = runTitle(run, actor?.username, issue);
  const unfinished = !isTerminal(run.state);
  const writer = canWrite(db, repo, user);
  const duration = durationText(run);
  const stream = `/api/v1/repos/${repo.ownerName}/${repo.name}/runs/${run.id}/log?follow=1`;
  const who = actor?.username ?? "agent";
  const where: Where = { run: run.id };

  const body = html`<div class="big-run">
    <div class="big-run-meta">
      <h1>${title}</h1>
      <span id="run-state" data-kind="${run.kind}"
        >${runStateBadge(run.state, run.kind)}</span
      >
      <span>${reasonWords(run.reason)}</span>
      ${when(
        issue,
        (i) =>
          html`<a
            href="${base}/${i.kind === "pull" ? "pulls" : "issues"}/${i.number}"
            >#${i.number}</a
          >`,
      )}
      <span class="num" id="run-cost" ${run.costUsd > 0 ? null : html`hidden`}
        >${costText(run.costUsd)} spent</span
      >
      <span class="num" id="run-turns" ${run.turns > 0 ? null : html`hidden`}
        >${run.turns} turn${run.turns === 1 ? "" : "s"}</span
      >
      ${when(
        duration,
        (d) =>
          html`<span
            class="num"
            id="run-elapsed"
            data-started="${run.startedAt ?? ""}"
            data-finished="${run.finishedAt ?? ""}"
            >${run.finishedAt === null ? "running for" : "took"} ${d}</span
          >`,
      )}
      ${when(
        writer && unfinished && issue === undefined,
        () =>
          html`<div class="run-actions" id="run-cancel">
            <form method="post" action="${base}/runs/${run.id}/cancel">
              <button class="big-act" type="submit" data-act="x">
                <kbd>x</kbd>${run.state === "running" ? "stop" : "cancel"}
              </button>
            </form>
          </div>`,
      )}
      ${when(
        run.summary !== "",
        () => html`<p class="run-summary" id="run-summary">${run.summary}</p>`,
      )}
      ${when(
        truncated,
        () =>
          html`<p class="run-summary">Showing the last 512 KB of the log.</p>`,
      )}
    </div>
    ${when(
      lines.length === 0,
      () =>
        html`<p class="big-quiet" id="run-empty">
          Nothing has been logged yet.
        </p>`,
    )}
    <div class="run-live" id="run-live" data-state="${run.state}">
      <div
        class="run-log"
        id="run-log"
        data-who="${who}"
        ${unfinished ? html`data-stream="${stream}"` : null}
      >
        ${lines.map((l) => logLine(l, who))}
        <button type="button" class="run-jump" id="run-jump" hidden>
          newer below
        </button>
      </div>
      ${when(
        writer && run.kind === "agent" && issue !== undefined,
        () =>
          html`<form
            class="run-steer"
            id="run-steer"
            method="post"
            action="${base}/runs/${run.id}/steer"
            data-api="/api/v1/repos/${repo.ownerName}/${repo.name}/runs/${run.id}/steer"
            data-running="${run.state === "running" ? "1" : "0"}"
          >
            <label class="sr-only" for="steer-text"
              >Say something to ${who}</label
            >
            <textarea
              class="input"
              id="steer-text"
              name="text"
              rows="1"
              required
              placeholder="${run.state === "running"
                ? `steer ${who} — enter sends, esc returns to the keys`
                : `tell ${who} for its next run — enter sends`}"
            ></textarea>
            <div class="bar">
              <span class="muted small" id="run-steer-note"
                >${run.state === "running"
                  ? "Heard after the step it is on. Every word is kept in the log."
                  : "The run is over; this goes on the conversation and starts a run."}</span
              >
              <span class="spacer"></span>
              ${when(
                unfinished,
                () =>
                  html`<button
                    type="submit"
                    class="big-act"
                    id="run-stop"
                    data-act="x"
                    formaction="${base}/runs/${run.id}/cancel"
                    formnovalidate
                  >
                    <kbd>x</kbd>${run.state === "running" ? "stop" : "cancel"}
                  </button>`,
              )}
              <button type="submit" class="big-act" data-lead="">
                <kbd>enter</kbd>send
              </button>
            </div>
          </form>`,
      )}
    </div>
  </div>`;
  return shell(ctx, {
    view: "run",
    layout: "run",
    title: `${title} · big`,
    crumbs: [
      { label: repo.name, href: bigUrl({ app: slug(repo) }) },
      { label: who === "agent" ? "run" : `${who}'s run` },
    ],
    panes: pane({
      name: "run",
      n: 1,
      title:
        run.kind === "agent"
          ? "Run"
          : run.kind === "check"
            ? "Check"
            : "Deploy",
      note: html`${run.state === "running"
        ? "following the tail"
        : run.state}${run.costUsd > 0 ? html` · ${money(run.costUsd)}` : null}`,
      body,
      cls: "big-run-pane",
    }),
    where,
    here: slug(repo),
    back: backUrl(where, slug(repo)),
    open: `${base}/runs/${run.id}`,
    apps: names,
    js: runLogJs,
  });
}

// ---- board: the wall's four regions, focusable ----

function boardView(
  ctx: Ctx,
  user: User,
  apps: readonly Repo[],
  names: readonly string[],
): Response {
  const scope = boardScope(ctx, apps);
  const regions = boardRegions(ctx, scope);
  const wrap = (name: string, n: number, region: Html): Html =>
    html`<section
      class="big-pane big-wall"
      data-pane="${name}"
      data-n="${n}"
      aria-label="${name}"
    >
      <div class="big-scroll">${region}</div>
    </section>`;
  return shell(ctx, {
    view: "board",
    layout: "wall",
    title: "Board · big",
    crumbs: [{ label: "board" }],
    panes: html`${wrap("working", 1, regions.working)}${wrap(
      "landed",
      2,
      regions.landed,
    )}${wrap("decided", 3, regions.decided)}${wrap("today", 4, regions.today)}`,
    where: { view: "board" },
    back: "/big",
    open: "/board",
    apps: names,
    css: boardCss,
  });
}

// ---- map: every app, one lane each ----

function mapView(ctx: Ctx, user: User, names: readonly string[]): Response {
  const lanes = globalLanes(ctx.app, user);
  const width = Math.max(0, ...lanes.map((l) => drawingWidth(l.placed)));
  const body =
    lanes.length === 0
      ? html`<p class="big-quiet">
          Nothing to map: no open issues anywhere you can see, and nobody
          working.
        </p>`
      : html`<div class="big-rows">
          ${lanes.map(
            (lane) =>
              html`<div
                class="big-row big-lane"
                data-key="lane:${slug(lane.repo)}"
                data-href="${bigUrl({ app: slug(lane.repo) })}"
                data-open="${repoBase(lane.repo)}/map"
                tabindex="-1"
              >
                ${laneHtml(lane, width)}
              </div>`,
          )}
        </div>`;
  return shell(ctx, {
    view: "map",
    layout: "lanes",
    title: "Map · big",
    crumbs: [{ label: "map" }],
    panes: html`<section
      class="big-pane"
      data-pane="lanes"
      data-n="1"
      id="map-lanes"
      data-live="run.*,issue.*,pull.*"
      aria-labelledby="big-lanes-h"
    >
      <h2 class="big-h" id="big-lanes-h">
        <kbd aria-hidden="true">1</kbd>Every app
        ${when(
          lanes.length > 0,
          () => html`<span class="big-count">${lanes.length}</span>`,
        )}
        <span class="spacer"></span>
        <span class="big-h-note"
          >the top edge of each lane is ready now · a ringed card is where the
          crew is</span
        >
      </h2>
      <div class="big-scroll">${body}</div>
    </section>`,
    where: { view: "map" },
    back: "/big",
    open: "/map",
    apps: names,
    css: mapCss,
    js: mapViewJs,
  });
}
