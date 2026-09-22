/**
 * The board: a live wall of the crews at work, for a second monitor. Four
 * regions — what is being worked on now, what landed, what the decider
 * decided, and today's spend against each app's ceiling — each a live
 * region that swaps itself when a matching event lands. Nothing on it
 * needs a click, and everything on it links somewhere. It reads the same
 * tables as the studio and adds no state of its own.
 */

import { appsForRepos, type AppRecord } from "../../core/apps.ts";
import {
  listDecisionsForRepos,
  type Decision,
  type DecisionKind,
} from "../../core/decisions.ts";
import { getIssue, getIssuesByIds, type Issue } from "../../core/issues.ts";
import { looksForApps } from "../../core/looks.ts";
import { listPulls, mergedPullsForRepos, type Pull } from "../../core/pulls.ts";
import {
  canSeeOwnerFacts,
  listReposVisibleTo,
  type Repo,
} from "../../core/repos.ts";
import { listActiveRuns, listRuns, type Run } from "../../core/runs.ts";
import { getUsersByIds } from "../../core/users.ts";
import { autonomyStatus, startOfTodayUtc } from "../../crew/autonomy.ts";
import type { Ctx } from "../../http/context.ts";
import { repoBase, signInFirst } from "../chrome.ts";
import { boardJs, liveRegionsJs } from "../client.ts";
import { html, when, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { avatar, icon, time } from "../ui.ts";
import { voiceFor } from "../studio/voice.ts";
import { lookUrl, thumbLook } from "./looks.ts";

// ---- words ----

/** Why a run exists, as a person reads it on a card. */
function reasonWords(reason: string): string {
  switch (reason) {
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
      return reason.replace(/_/g, " ");
  }
}

type StateWord = "queued" | "working" | "paused";

function stateWord(run: Run): StateWord {
  if (run.state === "running") return "working";
  return run.notBefore === null ? "queued" : "paused";
}

const KIND_WORDS: Record<DecisionKind, string> = {
  next: "next issue",
  land: "ship or show",
  retry: "try again",
  lean: "which way",
};

const money = (n: number): string => `$${n.toFixed(2)}`;

/** A whole percentage, for the width rules in `boardCss`. */
const pct = (n: number): number =>
  Math.max(0, Math.min(100, Math.round(n * 100)));

/** The apps on the board: every one the viewer can see, or the named few. */
interface Scope {
  readonly repos: readonly Repo[];
  readonly ids: readonly string[];
  readonly byId: ReadonlyMap<string, Repo>;
  readonly records: ReadonlyMap<string, AppRecord>;
  /** Repos whose spend, runs and decisions this viewer may see — write
   * access, same as the studio. A repo the viewer can only read is on the
   * board (it is still theirs to watch land) but carries none of that. */
  readonly ownerFacts: ReadonlySet<string>;
}

// ---- the page ----

/** GET /board — signed in; every app the viewer can see, or `?apps=` some. */
export function boardPage(ctx: Ctx): Response {
  const user = ctx.auth.user;
  if (!user) return signInFirst(ctx);
  const db = ctx.app.db;
  const visible = listReposVisibleTo(db, user, { limit: 200 });
  const records = appsForRepos(
    db,
    visible.map((r) => r.id),
  );
  const wanted = new Set(
    (ctx.url.searchParams.get("apps") ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const repos = visible.filter(
    (r) =>
      records.has(r.id) &&
      (wanted.size === 0 ||
        wanted.has(r.name.toLowerCase()) ||
        wanted.has(`${r.ownerName}/${r.name}`.toLowerCase())),
  );
  const scope: Scope = {
    repos,
    ids: repos.map((r) => r.id),
    byId: new Map(repos.map((r) => [r.id, r])),
    records,
    ownerFacts: new Set(
      repos.filter((r) => canSeeOwnerFacts(db, r, user)).map((r) => r.id),
    ),
  };

  const body = html`<div class="board">
    <header class="board-top">
      <a class="board-brand" href="/"><span class="mark"></span>forge</a>
      <span class="board-scope"
        >${repos.length === 1
          ? repos[0]!.name
          : `${repos.length} app${repos.length === 1 ? "" : "s"}`}</span
      >
      <span class="spacer"></span>
      <span class="board-keys" aria-hidden="true"
        ><kbd>f</kbd> fullscreen <kbd>1</kbd>–<kbd>4</kbd> one region
        <kbd>0</kbd> all</span
      >
      <span
        class="board-live"
        id="board-live"
        data-state="connecting"
        title="The live stream"
        ><span class="board-dot"></span
      ></span>
      <time class="board-clock" id="board-clock"></time>
    </header>
    <div class="board-grid">
      ${working(ctx, scope)} ${landed(ctx, scope)} ${decided(ctx, scope)}
      ${today(ctx, scope)}
    </div>
  </div>`;
  return page({
    ctx,
    title: "Board",
    body,
    bare: true,
    theme: "dark",
    scriptJs: `${liveRegionsJs}\n${boardJs}`,
  });
}

/** One region: a heading with its key and count, then the list or a quiet line. */
function region(
  id: string,
  key: string,
  title: string,
  live: string,
  rows: Html[],
  quiet: string,
): Html {
  return html`<section
    class="board-region"
    id="${id}"
    data-live="${live}"
    aria-labelledby="${id}-h"
  >
    <h2 class="board-h" id="${id}-h">
      <span class="board-key" aria-hidden="true">${key}</span>${title}
      ${when(
        rows.length > 0,
        () => html`<span class="board-count">${rows.length}</span>`,
      )}
    </h2>
    ${rows.length === 0
      ? html`<p class="board-quiet">${quiet}</p>`
      : html`<ul class="board-list">
          ${rows}
        </ul>`}
  </section>`;
}

// ---- working now ----

function working(ctx: Ctx, scope: Scope): Html {
  const db = ctx.app.db;
  const runs = listActiveRuns(db, scope.ids);
  // Working first, by when it started; then what waits, by when it was queued.
  const at = (r: Run): string => r.startedAt ?? r.createdAt;
  runs.sort((a, b) => {
    if ((a.state === "running") !== (b.state === "running"))
      return a.state === "running" ? -1 : 1;
    return at(a).localeCompare(at(b));
  });
  const actors = getUsersByIds(
    db,
    runs.map((r) => r.actorId).filter((id): id is string => id !== null),
  );
  const about = getIssuesByIds(
    db,
    runs.map((r) => r.issueId).filter((id): id is string => id !== null),
  );
  const rows = runs.map((run) => {
    const repo = scope.byId.get(run.repoId)!;
    // The same rule the app's page signs its rows by, `voiceFor`
    // (`studio/voice.ts`): the crew's own work reads as the app's own story
    // for a viewer who cannot see the roster; a person is always named.
    const actor = run.actorId === null ? undefined : actors.get(run.actorId);
    const who = voiceFor(
      {
        name: actor?.username,
        isAgent: actor === undefined || actor.kind === "agent",
      },
      scope.ownerFacts.has(repo.id),
    );
    const issue = run.issueId === null ? undefined : about.get(run.issueId);
    const word = stateWord(run);
    return html`<li>
      <a
        class="board-card board-run"
        data-state="${word}"
        href="${repoBase(repo)}/runs/${run.id}"
      >
        ${avatar(who)}
        <span class="board-run-who"><b>${who}</b> · ${repo.name}</span>
        <span class="board-elapsed" data-started="${at(run)}"></span>
        <span class="board-run-title"
          >${issue?.title ?? (run.summary || "on the repository")}</span
        >
        <span class="board-run-meta">
          <span class="board-state">${word}</span>
          <span
            >${word === "paused"
              ? "resumes soon"
              : reasonWords(run.reason)}</span
          >
          ${when(
            run.costUsd > 0 && scope.ownerFacts.has(repo.id),
            () => html`<span class="num">${money(run.costUsd)}</span>`,
          )}
        </span>
      </a>
    </li>`;
  });
  return region(
    "working",
    "1",
    "Working now",
    "run.*",
    rows,
    scope.repos.length === 0
      ? "No apps to watch."
      : "Nobody is working right now.",
  );
}

// ---- landed ----

function landed(ctx: Ctx, scope: Scope): Html {
  const db = ctx.app.db;
  const pulls = mergedPullsForRepos(db, scope.ids, 12);
  // The newest production picture of each app, on a phone, in one read.
  const looks = looksForApps(
    db,
    scope.repos
      .map((r) => scope.records.get(r.id)?.id)
      .filter((id): id is string => id !== undefined),
  );
  const pictureOf = (repo: Repo): string | undefined => {
    const record = scope.records.get(repo.id);
    if (record === undefined) return undefined;
    const look = thumbLook(
      looks.filter((l) => l.appId === record.id && l.env === "production"),
    );
    return (
      look &&
      lookUrl(repoBase(repo), "production", look.commitOid, look.page, look.kind)
    );
  };
  const rows = pulls.map((pull: Pull) => {
    const repo = scope.byId.get(pull.repoId)!;
    const picture = pictureOf(repo);
    const author = voiceFor(
      { name: pull.authorName, isAgent: pull.authorIsAgent },
      scope.ownerFacts.has(repo.id),
    );
    return html`<li>
      <a
        class="board-card board-landed"
        href="${repoBase(repo)}/pulls/${pull.number}"
      >
        <span class="board-thumb"
          >${picture === undefined
            ? icon("merge")
            : html`<img
                src="${picture}"
                width="34"
                height="46"
                alt=""
                loading="lazy"
              />`}</span
        >
        <span class="board-landed-title">${pull.title}</span>
        <span class="board-when">${time(pull.mergedAt ?? pull.createdAt)}</span>
        <span class="board-landed-meta">${repo.name} · ${author}</span>
      </a>
    </li>`;
  });
  return region(
    "landed",
    "2",
    "Landed",
    "pull.merged,run.finished",
    rows,
    scope.repos.length === 0 ? "No apps to watch." : "Nothing has shipped yet.",
  );
}

// ---- decided ----

function decided(ctx: Ctx, scope: Scope): Html {
  const db = ctx.app.db;
  // The decision ledger is the owner's own record of what the crew chose —
  // never shown for a repository this viewer can only read.
  const ids = scope.repos
    .filter((r) => scope.ownerFacts.has(r.id))
    .map((r) => r.id);
  const decisions = listDecisionsForRepos(db, ids, 12);
  const about = getIssuesByIds(
    db,
    decisions.map((d) => d.issueId).filter((id): id is string => id !== null),
  );
  const rows = decisions.map((d: Decision) => {
    const repo = scope.byId.get(d.repoId)!;
    const base = repoBase(repo);
    // What the decision was about: the issue picked for `next`, the pull
    // for the rest. A pick names its issue by number.
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
    return html`<li>
      <a class="board-card board-decision" href="${href}" data-kind="${d.kind}">
        <span class="board-kind">${KIND_WORDS[d.kind]}</span>
        <span class="board-decision-main">
          <span class="board-answer">${answer}</span>
          <span class="board-about"
            >${issue?.title ?? repo.name} ·
            ${d.by === "rule" ? "by the rule" : `by ${d.by}`}</span
          >
        </span>
        <span class="board-p" title="${Math.round(d.p * 100)}% sure">
          <span class="board-bar"
            ><span class="board-fill" data-w="${pct(d.p)}"></span
          ></span>
          <span class="num">${Math.round(d.p * 100)}%</span>
        </span>
        <span class="board-outcome" data-outcome="${d.outcome ?? ""}"
          >${d.outcome ?? "—"}</span
        >
        <span class="board-when">${time(d.createdAt)}</span>
      </a>
    </li>`;
  });
  return region(
    "decided",
    "3",
    "Decided",
    "run.*,pull.*",
    rows,
    "Nothing decided yet.",
  );
}

// ---- today ----

function today(ctx: Ctx, scope: Scope): Html {
  const db = ctx.app.db;
  const since = startOfTodayUtc(new Date()).toISOString();
  // Today's spend against the ceiling is the owner's own dashboard.
  const rows = scope.repos
    .filter((r) => r.autonomy !== "off" && scope.ownerFacts.has(r.id))
    .map((repo) => {
      const s = autonomyStatus(ctx.app, repo);
      const runs = listRuns(db, repo.id, { kind: "agent", limit: 200 }).filter(
        (r) => r.createdAt >= since,
      ).length;
      const shipped = listPulls(db, repo.id, {
        state: "closed",
        limit: 100,
      }).filter((p) => p.mergedAt !== null && p.mergedAt >= since).length;
      const share = s.ceilingUsd > 0 ? s.spentTodayUsd / s.ceilingUsd : 0;
      const note =
        s.paused === "ceiling"
          ? "at its ceiling until 00:00 UTC"
          : s.paused === "nobody"
            ? "nobody turned it on"
            : s.paused === "no crew"
              ? "no crew"
              : repo.autonomy;
      return html`<li>
        <a
          class="board-card board-app"
          href="${repoBase(repo)}"
          ${s.paused === null ? null : html`data-paused="${s.paused}"`}
        >
          <span class="board-app-name"
            >${repo.name} <span class="board-app-mode">${note}</span></span
          >
          <span class="board-app-nums">
            <span
              ><b>${money(s.spentTodayUsd)}</b> of
              $${s.ceilingUsd.toFixed(0)}</span
            >
            <span><b>${runs}</b> run${runs === 1 ? "" : "s"}</span>
            <span><b>${shipped}</b> shipped</span>
          </span>
          <span class="board-spend"
            ><span class="board-fill" data-w="${pct(share)}"></span
          ></span>
        </a>
      </li>`;
    });
  return region(
    "today",
    "4",
    "Today",
    "run.*,pull.merged",
    rows,
    scope.repos.length === 0
      ? "No apps to watch."
      : "No app runs on its own yet.",
  );
}

// ---- style ----

/** Width rules for the bars: a whole percentage as `data-w`, since an inline style is not allowed. */
const widths = Array.from(
  { length: 101 },
  (_, n) => `.board-fill[data-w="${n}"] { width: ${n}%; }`,
).join("\n");

/**
 * The board's own components, assembled into the served stylesheet by
 * `web/style.ts` rather than sent inline with the page. Every rule here is
 * a `.board-*` selector nothing else in the sheet mentions, so the
 * `components` layer is where they read the same as they always did.
 */
export const boardCss = /* css */ `
@layer components {
.board { --pad: clamp(16px, 2.2vw, 32px); display: flex; flex-direction: column; min-height: 100dvh; font-size: 16px; }
.board-top { display: flex; align-items: center; gap: 14px; padding: 14px var(--pad) 0; color: var(--faint); font-size: 13px; }
.board-brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 650; letter-spacing: -0.03em; font-size: 15px; color: var(--muted-fg); }
.board-brand:hover { color: var(--fg); }
.board-brand .mark { width: 10px; height: 10px; border-radius: 3px; background: linear-gradient(135deg, var(--accent), var(--merged)); }
.board-scope { color: var(--faint); }
.board-keys { display: none; align-items: center; gap: 6px; }
.board-keys kbd { height: 18px; min-width: 18px; font-size: 10.5px; }
.board-live { display: inline-flex; align-items: center; }
.board-dot { width: 8px; height: 8px; border-radius: 999px; background: var(--faint); transition: background-color 200ms var(--ease), box-shadow 200ms var(--ease); }
.board-live[data-state="open"] .board-dot { background: var(--success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 22%, transparent); }
.board-live[data-state="reconnecting"] .board-dot { background: var(--attn); }
.board-clock { font-family: var(--mono); font-size: 13px; font-variant-numeric: tabular-nums; color: var(--muted-fg); min-width: 5ch; text-align: right; }
.board-grid { flex: 1; display: grid; gap: var(--pad); padding: 12px var(--pad) var(--pad); min-height: 0; }
.board-region { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.board-h {
  position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 10px;
  margin: 0; padding: 4px 0 12px; background: var(--bg);
  font-size: 12.5px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--muted-fg);
}
.board-key { font-family: var(--mono); font-size: 11px; font-weight: 500; letter-spacing: 0; color: var(--faint); border: 1px solid var(--border); border-radius: 4px; padding: 0 5px; line-height: 16px; }
.board-count { color: var(--faint); font-weight: 500; letter-spacing: 0; font-variant-numeric: tabular-nums; }
.board-region[data-fresh] .board-h { color: var(--accent); }
.board-list { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.board-quiet { margin: 2px 0 0; color: var(--faint); font-size: 1em; }
.board-card {
  display: grid; padding: 12px 16px; border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--card); color: inherit; transition: border-color 140ms var(--ease);
}
.board-card:hover { border-color: var(--border-strong); color: inherit; }
.board-when { color: var(--faint); font-size: .875em; font-variant-numeric: tabular-nums; white-space: nowrap; }
.board-bar { display: block; height: 5px; border-radius: 999px; background: var(--muted); overflow: hidden; }
.board-fill { display: block; height: 100%; border-radius: inherit; background: var(--accent); transition: width 400ms var(--ease); }
${widths}

/* Working now: the crew member and app, what it is on, why, and the clock. */
.board-run { grid-template-columns: auto minmax(0, 1fr) auto; gap: 2px 12px; align-items: start; padding: 14px 16px; }
.board-run .avatar { grid-row: 1 / span 3; width: 36px; height: 36px; font-size: 14px; margin-top: 3px; }
.board-run-who { font-size: .9em; color: var(--muted-fg); }
.board-run-who b { color: var(--fg); font-weight: 600; }
.board-elapsed { grid-column: 3; grid-row: 1 / span 2; font-family: var(--mono); font-size: 1.5em; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; line-height: 1.2; min-width: 4ch; text-align: right; }
.board-run-title { grid-column: 2; font-size: 1.2em; font-weight: 550; line-height: 1.3; letter-spacing: -0.01em; text-wrap: pretty; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.board-run-meta { grid-column: 2 / span 2; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 4px; font-size: .9em; color: var(--muted-fg); }
.board-state { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; color: var(--fg); }
.board-state::before { content: ""; width: 8px; height: 8px; border-radius: 999px; background: var(--faint); }
.board-run[data-state="working"] { border-color: color-mix(in srgb, var(--accent) 38%, var(--border)); }
.board-run[data-state="working"] .board-state { color: var(--accent); }
.board-run[data-state="working"] .board-state::before { background: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
.board-run[data-state="working"] .board-elapsed { color: var(--accent); }
.board-run[data-state="queued"] .board-elapsed { color: var(--muted-fg); }
.board-run[data-state="paused"] .board-state { color: var(--attn); }
.board-run[data-state="paused"] .board-state::before { background: var(--attn); }
/* Nothing on the wall animates on its own. A perpetual animation keeps the
   browser painting every frame all day — three pulsing dots measured at over
   100% CPU under software rendering. The ticking clocks are the sign of life. */

/* Landed: the production look on a phone, the change, who, when. */
.board-landed { grid-template-columns: auto minmax(0, 1fr) auto; gap: 2px 14px; align-items: center; padding: 10px 14px; }
.board-thumb { grid-row: 1 / span 2; display: flex; align-items: center; justify-content: center; width: 34px; height: 46px; border: 1px solid var(--border); border-radius: 5px; overflow: hidden; background: var(--muted); color: var(--merged); }
.board-thumb img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top; }
.board-landed-title { font-size: 1.05em; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.board-landed-meta { grid-column: 2; font-size: .875em; color: var(--muted-fg); }
.board-landed .board-when { grid-column: 3; grid-row: 1 / span 2; }

/* Decided: the kind, the answer, how sure, what came of it. */
.board-decision { grid-template-columns: 6.5em minmax(0, 1fr) 7em 4.5em auto; gap: 12px; align-items: center; padding: 10px 14px; }
.board-kind { font-size: .75em; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--muted-fg); }
.board-decision-main { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.board-answer { font-size: 1.05em; font-weight: 600; }
.board-about { font-size: .875em; color: var(--muted-fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.board-p { display: flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: .75em; color: var(--muted-fg); }
.board-p .board-bar { flex: 1; }
.board-outcome { font-size: .875em; color: var(--faint); }
.board-outcome[data-outcome="shipped"], .board-outcome[data-outcome="green"] { color: var(--success); }
.board-outcome[data-outcome="red"] { color: var(--danger); }
.board-outcome[data-outcome="shown"], .board-outcome[data-outcome="closed"] { color: var(--attn); }

/* Today: each app that runs on its own, its spend against the ceiling. */
.board-app { grid-template-columns: minmax(0, 1fr) auto; gap: 8px 14px; align-items: baseline; padding: 12px 16px; }
.board-app-name { font-size: 1.1em; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.board-app-mode { font-size: .8em; font-weight: 500; color: var(--muted-fg); margin-left: 4px; }
.board-app[data-paused] .board-app-mode { color: var(--attn); }
.board-app-nums { display: flex; gap: 14px; font-size: .875em; color: var(--muted-fg); font-variant-numeric: tabular-nums; white-space: nowrap; }
.board-app-nums b { color: var(--fg); font-weight: 600; }
.board-spend { grid-column: 1 / -1; display: block; height: 6px; border-radius: 999px; background: var(--muted); overflow: hidden; }
.board-app[data-paused="ceiling"] .board-fill { background: var(--attn); }

/* Wide: four regions fill the window, each scrolling on its own. */
@media (min-width: 1100px) {
  .board { flex: none; height: 100dvh; min-height: 0; }
  .board-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); }
  .board-region { overflow: auto; scrollbar-width: thin; scrollbar-color: var(--border) transparent; padding-right: 2px; }
  .board-keys { display: inline-flex; }
  .board[data-focus] .board-grid { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
  .board[data-focus] { font-size: 19px; }
}
@media (min-width: 1600px) { .board { font-size: 17px; } .board[data-focus] { font-size: 21px; } }
/* Narrow: stacked, and the decision row folds. */
@media (max-width: 719px) {
  .board-elapsed { font-size: 1.05em; }
  .board-run-title { -webkit-line-clamp: 3; }
  .board-landed-title { white-space: normal; text-wrap: pretty; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .board-app { grid-template-columns: minmax(0, 1fr); }
  .board-app-name { white-space: normal; }
  .board-decision { grid-template-columns: minmax(0, 1fr) auto; }
  .board-kind { grid-column: 1 / -1; }
  .board-p { grid-column: 1; }
  .board-outcome { grid-column: 2; grid-row: 2; }
  .board-decision .board-when { grid-column: 2; grid-row: 3; }
  .board-app-nums { flex-wrap: wrap; white-space: normal; gap: 6px 12px; }
  .board-scope { display: none; }
}
/* One region, full bleed. */
.board[data-focus] .board-region { display: none; }
.board[data-focus="working"] #working, .board[data-focus="landed"] #landed,
.board[data-focus="decided"] #decided, .board[data-focus="today"] #today { display: flex; }
}
`;
