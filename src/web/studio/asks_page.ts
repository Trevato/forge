/**
 * What needs you, pinned at the top of the home (#634): a sentence — *N
 * things need you* — and under it the decision cards (`asks.ts`), then, for
 * a site admin, one card per thing the forge itself needs. Every button is a
 * plain form post. Many asks at once stay here too: tick them, pick one
 * action, and the preview, the receipt and its Undo appear on top
 * (`actions/asks_bulk.ts`). `/asks` was its own screen; it lands here now.
 */

import { UNDO_LABEL, VERB_WORDS } from "../../actions/asks_words.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import type { WaitingFor } from "../../core/waiting_for.ts";
import {
  applyAsksBulk,
  BULK_MAX,
  doneLine,
  latestUndoable,
  ownAsksOperation,
  undoAsksBulk,
  receiptOf,
  previewAsksBulk,
  type Skipped,
} from "../../actions/asks_bulk.ts";
import { getDecision } from "../../core/decisions.ts";
import { giveBack } from "../../actions/give_back.ts";
import { decideAsk, undoDecideAsk } from "../../actions/asks_decide.ts";
import type { FleetValue } from "../../core/fleet_ops.ts";
import { muteRepo, removeMutes } from "../../core/interactions.ts";
import { applyAskFilter, isAskFilterDo, type AskFilterChange } from "../../actions/ask_filter.ts";
import { askFiltersOf, hasAskFilters, hiddenLine, HIDE_APP_DAY_WORDS, HIDE_KIND_WORDS, isAskKind, SHOW_ALL_WORDS } from "../../core/ask_filters.ts";
import { needLine } from "../../actions/health.ts";
import type { Degraded } from "../../kernel/vitals.ts";
import type { Ctx } from "../../http/context.ts";
import type { User } from "../../core/users.ts";
import { onYouAnswer, onYouRegion } from "./home.ts";
import { liveRegionsJs } from "../client.ts";
import { liveClientJs } from "../live.ts";
import { notFoundPage, repoBase, signInFirst, NOT_YOURS_TO_DO, forbiddenPage } from "../chrome.ts";
import { backTo, field, prefersJson, readForm } from "../form.ts";
import { json } from "../../http/respond.ts";
import { MAX_BODY } from "../../core/issues.ts";
import { issueTitles } from "../../core/proposals.ts";
import { actOnProposal, type ProposalVerb } from "../../actions/proposals.ts";
import {
  canRead,
  getRepoById,
  listReposVisibleTo,
  ownerFactRepoIds,
} from "../../core/repos.ts";
import { html, type Html } from "../html.ts";
import { noteLine } from "./note.ts";
import { page, redirect } from "../layout.ts";
import { btn, card, disclosure, icon, row } from "../ui.ts";
import {
  askAnchor,
  askRows,
  askSentence,
  ASK_WORDS,
  ROW_PLURAL,
  forgeNeedsFor,
  silencedRepos,
  putAsideWaves,
  type AskRow,
  type Consequence,
  type Decision,
} from "./asks.ts";
import { decisionButtons, decisionForm, decisionsFor } from "./decisions.ts";
import { changeHref } from "./nouns.ts";

/** The kinds, in a word each, for "select by kind". */
const ASK_KIND_WORDS: Readonly<Record<string, string>> = {
  look: "Looks",
  review: "Reviews",
  stopped: "Stopped",
  parked: "Parked",
  assigned: "Assigned",
  waiting: "Waiting",
  handover: "Handed over",
};

/** The kinds a bulk action takes: a ceiling and a planner's decline are decided where they live. */
const BULK_KINDS: ReadonlySet<Decision["kind"]> = new Set(["look", "review", "stopped", "handover", "waiting", "parked", "assigned"]);

/** A row's box for the bulk form, which sits apart (`form="asks-bulk"`): forms do not nest. */
const pick = (d: Decision, picked: ReadonlySet<string>): Html | null =>
  BULK_KINDS.has(d.kind)
    ? html`<label class="check"><input
        type="checkbox"
        name="item"
        value="${d.id}"
        form="asks-bulk"
        data-repo="${d.repo.id}"
        data-kind="${d.kind}"
        ${picked.has(d.id) ? html`checked` : null}
        aria-label="Select ${d.pull?.title ?? d.issue?.title ?? d.id}"
      /></label>`
    : null;

/**
 * Selecting many, and acting on them in place. A box belongs to a bulk form
 * by `form="<id>"`; a `data-pick` button or the repository chooser ticks
 * the boxes of one form by all, kind or repository. A bulk form marked
 * `data-bulk` posts without leaving the page and swaps the On you region
 * and the top bar's count with what the server answers; on any trouble it
 * falls back to the plain post, which says what happened.
 */
const SELECT_JS = `document.addEventListener('change', function (e) {
  var t = e.target;
  if (!t || !t.matches) return;
  if (t.matches('[data-select-all]')) {
    var card = t.closest('.card');
    if (card) card.querySelectorAll('input[name="item"]').forEach(function (b) { b.checked = t.checked; });
  } else if (t.matches('select[data-pick-repo]') && t.value) {
    pick(t.form, function (b) { return b.getAttribute('data-repo') === t.value; });
    t.value = '';
  }
});
function pick(form, test) {
  if (!form || !form.id) return;
  document.querySelectorAll('input[form="' + form.id + '"][name="item"]').forEach(function (b) { b.checked = test(b); });
}
document.addEventListener('click', function (e) {
  var t = e.target && e.target.closest && e.target.closest('[data-pick]');
  if (!t) return;
  var want = t.getAttribute('data-pick');
  pick(t.form, function (b) { return want === 'all' || 'kind:' + b.getAttribute('data-kind') === want; });
});
document.addEventListener('submit', function (e) {
  var f = e.target;
  if (!f || !f.matches || !f.matches('form[data-bulk]') || !window.fetch) return;
  if (!new FormData(f).has('item')) return;
  e.preventDefault();
  var region = document.getElementById('live-on-you');
  if (region) region.setAttribute('data-busy', '');
  fetch(f.action, { method: 'POST', body: new URLSearchParams(new FormData(f)), credentials: 'same-origin', headers: { 'x-forge-fragment': '1' } })
    .then(function (r) { return r.ok ? r.text() : Promise.reject(r); })
    .then(function (text) {
      var t = document.createElement('template');
      t.innerHTML = text;
      var fresh = t.content.getElementById('live-on-you');
      if (region && fresh) region.innerHTML = fresh.innerHTML;
    })
    .catch(function () { f.removeAttribute('data-bulk'); f.submit(); })
    .then(function () { if (region) region.removeAttribute('data-busy'); });
});`;

/** The rows shown before "N more": the few that matter most. */
export const ASKS_SHOWN = 5;

/** The rows a phone shows before its own "N more" (#883's follow-up). */
export const ASKS_SHOWN_PHONE = 2;

/**
 * Why it ranks high, when that is more than its kind: security, money,
 * held-up work — and, on a collapsed row, which of its asks that is.
 */
const weight = (c: Consequence, which?: string): Html | null =>
  c.score >= 60
    ? html`<b>${c.why}</b>${which === undefined ? null : html`: \u201c${which}\u201d`} · `
    : null;

/** One clause, and what happens if nobody acts — never the same sentence twice. */
const clause = (
  d: Decision | undefined,
  kind: Decision["kind"],
  c: Consequence,
  which?: string,
): Html =>
  html`<p>
    ${weight(c, which)}${d === undefined ? null : html`${d.short.charAt(0).toUpperCase()}${d.short.slice(1)}${d.note === undefined ? null : html`: \u201c${noteLine(d.note)}\u201d`}. `}<span class="muted"
      >If nobody acts, ${ASK_WORDS[kind].ifNothing}.</span
    >
  </p>`;

/** The kind, in two words: what a phone's row says in place of the sentence under it. */
const KIND_LABEL: Readonly<Record<Decision["kind"], string>> = {
  look: "Ready to ship",
  review: "Needs review",
  stopped: "Stopped",
  handover: "Handed over",
  waiting: "Waiting",
  parked: "Parked",
  declined: "Declined",
  proposal: "Proposed",
  paused: "Paused",
  assigned: "Assigned",
};

/** An ask's actions in a line: the one that decides, then the rest. */
function acts(ctx: Ctx, d: Decision): Html {
  const { primary, others } = decisionButtons(ctx, d);
  return html`<div class="bar mt">${primary}${others}</div>`;
}

/** What the crew advised on a pull waiting for a person, in one plain line; nothing when it wrote none. */
const adviceLine = (d: Decision): Html | null =>
  d.recommendation === undefined
    ? null
    : html`<p class="small muted">The crew advises: ${d.recommendation.verdict}${d.recommendation.reason === "" ? "" : html` — ${d.recommendation.reason}`}</p>`;

/** A wave proposal's why, its issue titles and the Redirect box; nothing for any other ask. */
function proposalBody(ctx: Ctx, d: Decision): Html | null {
  if (!d.proposal) return null;
  return html`<p class="small">${d.proposal.why}</p>
    <ul class="small">
      ${issueTitles(d.proposal).map((t) => html`<li>${t}</li>`)}
    </ul>
    <form method="post" action="/asks/proposal/${d.proposal.id}/redirect" class="bar">
      <input type="hidden" name="back" value="${ctx.url.pathname}" />
      <label class="sr-only" for="redirect-${d.proposal.id}">Redirect the planner</label>
      <textarea id="redirect-${d.proposal.id}" name="words" rows="2" maxlength="${MAX_BODY}" required placeholder="Plan this instead…"></textarea>
      ${btn("Redirect", { size: "sm" })}
    </form>`;
}

function decisionCard(ctx: Ctx, d: Decision, picked: ReadonlySet<string>): Html {
  const base = repoBase(d.repo);
  const title = d.pull
    ? html`<a href="${changeHref(base, d.pull.number)}" data-nav>${d.pull.title}</a>`
    : d.issue
      ? html`<a href="${base}/issues/${d.issue.number}" data-nav>${d.issue.title}</a>`
      : d.proposal
        ? html`${d.proposal.title}`
        : html`<a href="${base}/settings/autonomy">Paused</a>`;
  return card(
    html`${clause(d, d.kind, d.consequence)}
      ${adviceLine(d)}
      ${proposalBody(ctx, d)}
      ${acts(ctx, d)}`,
    {
      id: askAnchor(d.id),
      head: html`${pick(d, picked)}
        <h2>${title}</h2>
        <span class="muted small"><b>${KIND_LABEL[d.kind]}</b> · ${d.repo.ownerName}/${d.repo.name}</span
        >${waitChip(d.waiting)}`,
    },
  );
}

/** What the row waits for and on whom: "ready to land · on you". */
const waitChip = (w: WaitingFor): Html =>
  html`<span class="badge" data-variant="outline" data-waiting="${w.word}"
    ><span class="sr-only">waiting for </span>${w.word} · on ${w.on}</span
  >`;

/** What a collapsed row says it holds. */
const rowHead = (kind: Decision["kind"], n: number): string => {
  const line = ROW_PLURAL[kind](n);
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}`;
};

/** The flash's own query keys: dropped from the page a decision returns to, so Undo does not carry them. */
const FLASH_KEYS = ["muted", "listened"] as const;

/** This page as a path and query without the flash, for a form's `back`. */
function here(ctx: Ctx): string {
  const q = new URLSearchParams(ctx.url.searchParams);
  for (const k of FLASH_KEYS) q.delete(k);
  const rest = q.toString();
  return ctx.url.pathname === "/asks" && rest !== "" ? `/asks?${rest}` : "/asks";
}

/** A `back` worth following after a mute: `/asks` or `/asks?…`, nothing else. */
function asksBack(form: Parameters<typeof backTo>[0]): string {
  const back = backTo(form, "/asks");
  return back === "/asks" || (back.startsWith("/asks?") && !back.includes("#")) ? back : "/asks";
}

/** The same page with one flash key set, the others cleared. */
function withFlash(back: string, key: (typeof FLASH_KEYS)[number], repoId: string): string {
  const [path = "/asks", query = ""] = back.split("?");
  const q = new URLSearchParams(query);
  for (const k of FLASH_KEYS) q.delete(k);
  q.set(key, repoId);
  return `${path}?${q.toString()}`;
}

/** "Muted owner/name" or "Listening to owner/name again", with Undo, when the page was reached from a mute or listen. */
function muteFlash(ctx: Ctx, user: NonNullable<Ctx["auth"]["user"]>): Html | null {
  for (const key of FLASH_KEYS) {
    const id = ctx.url.searchParams.get(key);
    if (id === null || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue;
    const repo = getRepoById(ctx.app.db, id);
    if (!repo || !canRead(ctx.app.db, repo, user)) continue;
    const name = `${repo.ownerName}/${repo.name}`;
    const muted = key === "muted";
    return html`<div class="toast" data-tone="success" role="status">
      ${icon("check")}
      <div class="toast-body">${muted ? `Muted ${name}` : `Listening to ${name} again`}</div>
      <form class="bar" method="post" action="${muted ? "/asks/listen" : "/asks/mute"}">
        <input type="hidden" name="repo" value="${repo.id}" />
        <input type="hidden" name="back" value="${here(ctx)}" />
        ${btn("Undo", { size: "sm" })}
      </form>
    </div>`;
  }
  return null;
}

/** A one-field form: a pick from `options`, saved as the viewer's filter by `asksFilter`. */
function filterPick(
  ctx: Ctx,
  change: string,
  field: "repo" | "kind",
  options: readonly { value: string; label: string }[],
  label: string,
  tap: string,
): Html {
  return html`<form class="bar" method="post" action="/asks/filter">
    <input type="hidden" name="do" value="${change}" />
    <input type="hidden" name="back" value="${here(ctx)}" />
    <select name="${field}" class="input" aria-label="${label}">
      ${options.map((o) => html`<option value="${o.value}">${o.label}</option>`)}
    </select>
    ${btn(tap, { size: "sm", variant: "ghost" })}
  </form>`;
}

/**
 * The ask filters, once for the whole list: what they hide with the one tap
 * that clears them, and, closed, the two picks that set them (an app for a
 * day, a kind). The apps and kinds offered are those in the rows below.
 */
function filterNote(ctx: Ctx, rows: readonly AskRow<Decision>[], hidden: number): Html | null {
  const on = hasAskFilters(askFiltersOf(ctx.app.db, ctx.auth.user!.id));
  if (!on && rows.length < 2) return null;
  const apps = [...new Map(rows.map((r) => [r.repo.id, `${r.repo.ownerName}/${r.repo.name}`])).entries()].map(
    ([value, label]) => ({ value, label }),
  );
  const kinds = [...new Set(rows.map((r) => r.kind))].map((k) => ({ value: k, label: ASK_KIND_WORDS[k] ?? k }));
  const clear = !on
    ? null
    : html`<form class="bar" method="post" action="/asks/filter">
        <input type="hidden" name="do" value="clear" />
        <input type="hidden" name="back" value="${here(ctx)}" />
        <span class="muted small">${hiddenLine(hidden)}</span>
        ${btn(SHOW_ALL_WORDS, { size: "sm", variant: "ghost" })}
      </form>`;
  const picks = rows.length === 0
    ? null
    : disclosure(
        "Filter",
        html`${filterPick(ctx, "hide_app_day", "repo", apps, "App to hide", HIDE_APP_DAY_WORDS)}
        ${filterPick(ctx, "hide_kind", "kind", kinds, "Kind to hide", HIDE_KIND_WORDS)}`,
        { small: true },
      );
  return html`<div id="asks-filters" class="stack">${clear}${picks}</div>`;
}

/** A row and, under it, the chip that mutes its repository (`asksMute`). */
function mutableRow(ctx: Ctx, r: AskRow<Decision>, picked: ReadonlySet<string>): Html {
  return html`${rowCard(ctx, r, picked)}
    <form class="bar" method="post" action="/asks/mute">
      <input type="hidden" name="repo" value="${r.repo.id}" />
      <input type="hidden" name="back" value="${here(ctx)}" />
      <button
        type="submit"
        class="btn" data-variant="ghost" data-size="sm"
        title="Stop its asks reaching your home, inbox and phone"
        >Mute ${r.repo.ownerName}/${r.repo.name}</button
      >
    </form>`;
}

/** One card for one kind in one repository: a line per ask, each with its own actions. */
function rowCard(ctx: Ctx, r: AskRow<Decision>, picked: ReadonlySet<string>): Html {
  const only = r.items.length === 1 ? r.items[0] : undefined;
  if (only) return decisionCard(ctx, only, picked);
  const base = repoBase(r.repo);
  const lines = r.items.map((d) => {
      const number = d.pull?.number ?? d.issue?.number;
      const href = d.pull
        ? changeHref(base, d.pull.number)
        : `${base}/issues/${String(number)}`;
      const box = pick(d, picked);
      return row({
        ...(box === null ? {} : { lead: box }),
        title: html`<a href="${href}" data-nav>${d.pull?.title ?? d.issue?.title ?? ""}</a>`,
        meta: acts(ctx, d),
      });
  });
  return card(
    html`<ul class="list">
      ${lines}
    </ul>`,
    {
      pad: false,
      id: askAnchor(r.id),
      head: html`${BULK_KINDS.has(r.kind)
          ? html`<label class="check"><input
              type="checkbox"
              data-select-all
              aria-label="Select all ${r.items.length}"
            /></label>`
          : null}
        <h2>${rowHead(r.kind, r.items.length)}</h2>
        <span class="muted small">${r.repo.ownerName}/${r.repo.name}</span>${waitChip(r.items[0]!.waiting)}`,
      // The row ranks by its weightiest ask (first, `askRows`): name it.
      foot: clause(
        undefined,
        r.kind,
        r.consequence,
        r.items[0]?.pull?.title ?? r.items[0]?.issue?.title,
      ),
    },
  );
}

/** The forge is degraded: an alert line, marked in the danger tone, under its head; Health on its own row so it never wraps into the sentence. */
export const forgeCard = (d: Degraded): Html =>
  html`<section class="stack">
    <h2>The forge</h2>
    <p role="alert"><span class="dot" data-tone="danger" aria-hidden="true"></span> <a href="${d.href}">${needLine(d)}</a></p>
    <div class="bar">${btn("Health", { href: "/api/v1/health", size: "sm" })}</div>
  </section>`;

/** What sits above the asks after a bulk step: a preview to confirm, a receipt, or why nothing was done. */
export interface AsksTop {
  readonly banner: Html;
  /** The asks the preview is about, kept ticked. */
  readonly picked?: ReadonlySet<string>;
  readonly action?: string;
  readonly reason?: string;
}

/** GET /asks — what needs you as its own page: the home's section and its
 * live script; `?op=<id>` (a bulk action's receipt) rides along. */
export function asksPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  return renderAsks(ctx, timePhase(ctx.request, "top", () => homeTop(ctx)));
}

/** The asks page, with a bulk step's preview or receipt on top. */
function renderAsks(ctx: Ctx, top: AsksTop | undefined): Response {
  const user = ctx.auth.user;
  if (!user) return signInFirst(ctx);
  const section = needsYouSection(ctx, user, top);
  const rendering = performance.now();
  const response = page({
    ctx,
    title: "Asks",
    body: html`<main class="stack"><h1 class="sr-only">Asks</h1>${muteFlash(ctx, user)}${onYouRegion(ctx, user, undefined, section.body)}<p class="small muted"><a href="/review">Review: one row per ask</a></p></main>`,
    scriptJs: `${liveClientJs}\n${liveRegionsJs}\n${section.scriptJs}`,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

/** The receipt `?op=<id>` names on the home, when it is the viewer's own. */
export function homeTop(ctx: Ctx): AsksTop | undefined {
  const decided = ctx.url.searchParams.get("decided");
  if (decided !== null) return handedTop(ctx, decided);
  const op = ctx.url.searchParams.get("op");
  return op === null ? undefined : receiptTop(ctx, op);
}

/** What the decider said about a hand-over, and the day's undo; only for the one who asked it. */
function handedTop(ctx: Ctx, decisionId: string): AsksTop | undefined {
  const user = ctx.auth.user;
  const d = getDecision(ctx.app.db, decisionId);
  if (!user || d === undefined || d.kind !== "hand") return undefined;
  const repo = getRepoById(ctx.app.db, d.repoId);
  if (repo === undefined || !ownerFactRepoIds(ctx.app.db, [repo], user).has(repo.id))
    return undefined;
  const reason = (d.state as { reason?: unknown } | null)?.reason;
  const undoable = d.outcome === "set_aside";
  return {
    banner: card(
      html`<p>${typeof reason === "string" ? reason : d.answer}</p>
        ${undoable
          ? html`<form method="post" action="/asks/decide/${d.id}/undo" class="bar">
              ${btn("Undo", { size: "sm" })}
              <span class="muted small">kept for a day</span>
            </form>`
          : null}`,
      { id: "asks-bulk-result", head: html`<h2>The decider: ${d.outcome === "undone" ? "undone" : d.outcome ?? d.answer}</h2>` },
    ),
  };
}

/**
 * The one status bar a decision leaves, always in this slot so nothing moves:
 * for a minute the Done line (`Done.` and an Undo, or why a landed merge has
 * none), then, up to a day, the receipt with its Undo.
 */
function undoSlot(ctx: Ctx, user: User | undefined): Html | null {
  const done = doneLine(ctx.app, user);
  if (done !== undefined) return undoBar(done.say, done.undo ? done.operation.id : undefined);
  const last = latestUndoable(ctx.app, user);
  return last === undefined ? null : undoBar(receiptOf(last), last.id, "kept for a day");
}

/** One bar: what was done, and, when it can be taken back, the Undo (a same-origin POST) and a note. */
function undoBar(say: string, operationId?: string, note?: string): Html {
  if (operationId === undefined) return html`<p class="bar small" role="status">${say}</p>`;
  return html`<form class="bar" method="post" action="/asks/bulk/${operationId}/undo" role="status">
    <span class="small">${say}</span>
    ${btn(UNDO_LABEL, { size: "sm" })}
    ${note === undefined ? null : html`<span class="muted small">${note}</span>`}
  </form>`;
}

/** What needs you, as the home's pinned section: what asks you, with a
 * bulk step's preview or receipt on top. Nothing on screen when nothing
 * asks — the header's Asks link says so — but the sentence stays for a
 * screen reader. */
export function needsYouSection(
  ctx: Ctx,
  user: User,
  top?: AsksTop,
): { body: Html; scriptJs: string } {
  const picked = top?.picked ?? new Set<string>();
  const visible = listReposVisibleTo(ctx.app.db, user, { limit: 200, withoutArchived: true });
  let hidden = 0;
  const read = () => decisionsFor(ctx, visible, { onHidden: (n) => (hidden = n) });
  // Callers that build the section outside a request have none to time against.
  const decisions = ctx.request instanceof Request ? timePhase(ctx.request, "asks", read) : read();
  const needs = forgeNeedsFor(ctx, user);
  const rows = askRows(decisions);
  const filtered = filterNote(ctx, rows, hidden);
  const silenced = silencedRepos(ctx.app.db, user);
  const silencedNote =
    silenced.length === 0
      ? null
      : html`<form class="bar" method="post" action="/asks/listen">
          ${silenced.map((r) => html`<input type="hidden" name="repo" value="${r.id}" />`)}
          <span class="muted small" title="${silenced.map((r) => `${r.ownerName}/${r.name}`).join(", ")}"
            >${silenced.length} muted ${silenced.length === 1 ? "repository still asks" : "repositories still ask"}</span
          >
          <button type="submit" class="btn" data-variant="ghost" data-size="sm">Listen again</button>
        </form>`;
  const aside = putAsideWaves(ctx.app.db, user);
  const asideNote =
    aside.length === 0
      ? null
      : html`<details class="bar">
          <summary class="muted small"
            >${aside.length} ${aside.length === 1 ? "wave" : "waves"} put aside</summary
          >
          ${aside.map(
            (w) => html`<form method="post" action="/asks/proposal/${w.id}/again" class="bar">
              <input type="hidden" name="back" value="${ctx.url.pathname}" />
              <span class="small">${w.title}</span>
              ${btn("Bring back", { size: "sm" })}
            </form>`,
          )}
        </details>`;
  const undo = undoSlot(ctx, user);
  const count = rows.length + needs.length;
  if (count === 0 && top === undefined)
    return {
      body: html`<h2 id="asks-sentence" class="sr-only">${askSentence(0)}</h2>${filtered}${silencedNote}${asideNote}${undo}`,
      scriptJs: "",
    };
  // The forge's own health first, then the few asks that matter most;
  // the rest are one tap away, in the same order. A phone shows fewer
  // (ASKS_SHOWN_PHONE) so the composer stays near the fold: the outer
  // "more" is the phone's and opens in place to every ask; a wider screen
  // flattens it and keeps the inner "more" for what is past ASKS_SHOWN.
  const first = rows.slice(0, ASKS_SHOWN_PHONE);
  const middle = rows.slice(ASKS_SHOWN_PHONE, ASKS_SHOWN);
  const rest = rows.slice(ASKS_SHOWN);
  const pickable = decisions.filter((d) => BULK_KINDS.has(d.kind)).length;
  const more = (id: string, n: number, inner: Html): Html =>
    html`<details id="${id}">
      <summary>${n} more</summary>
      <div class="stack mt">${inner}</div>
    </details>`;
  const restMore =
    rest.length === 0
      ? null
      : more("asks-more", rest.length, html`${rest.map((r) => mutableRow(ctx, r, picked))}`);
  // The asks come first, so the first Tab after #needs-you lands on one;
  // the bulk step acts on what was picked, after them.
  const body = html`<section id="needs-you" class="stack">
    <h2 id="asks-sentence">${askSentence(count)}</h2>
    ${top?.banner ?? null}
    ${needs.map(forgeCard)} ${first.map((r) => mutableRow(ctx, r, picked))}
    ${middle.length === 0
      ? null
      : more(
          "asks-phone-more",
          rows.length - first.length,
          html`${middle.map((r) => mutableRow(ctx, r, picked))} ${restMore}`,
        )}
    ${pickable < 2
      ? null
      : html`<form id="asks-bulk" method="post" action="/asks/bulk" class="bar">
          ${pickControls(
            "asks-bulk",
            [...new Map(decisions.filter((d) => BULK_KINDS.has(d.kind)).map((d) => [d.kind, { id: d.kind, label: ASK_KIND_WORDS[d.kind] ?? d.kind }])).values()],
            [...new Map(decisions.filter((d) => BULK_KINDS.has(d.kind)).map((d) => [d.repo.id, { id: d.repo.id, label: `${d.repo.ownerName}/${d.repo.name}` }])).values()],
          )}
          <select name="action" class="input" aria-label="What to do with the selected asks">
            ${ASK_VERBS.map(
              (value) =>
                html`<option value="${value}" ${top?.action === value ? html`selected` : null}>${VERB_WORDS[value]}</option>`,
            )}
          </select>
          ${reasonInput(top?.reason)} ${btn("Preview", { size: "sm" })}
          <span class="muted small">on the selected asks</span>
        </form>`}
    ${filtered} ${silencedNote} ${asideNote} ${undo}
    ${decisions.map((d) => decisionForm(d, ctx.url.pathname))}
  </section>`;
  return { body, scriptJs: SELECT_JS };
}

/** The asks page with a bulk step's preview or receipt on top — where every bulk answer lands. */
async function asksScreen(ctx: Ctx, top: AsksTop): Promise<Response> {
  return renderAsks(ctx, top);
}

// ---- many at once: select, preview, do it, undo — all on this screen ----

/** What the asks below can be given in one move. */
const ASK_VERBS = ["decline", "ship", "close", "replan", "mute"] as const;

/** One reason, written on each pull or issue closed. */
const reasonInput = (value = ""): Html =>
  html`<input
    class="input"
    name="reason"
    maxlength="300"
    value="${value}"
    placeholder="Reason, written on each closed"
    aria-label="Reason, written on each closed"
  />`;

/**
 * Pick-by-set controls for the bulk form `formId`: all, by kind, by
 * repository. Plain buttons the page's script answers; the boxes still work alone.
 */
export function pickControls(
  formId: string,
  kinds: readonly { id: string; label: string }[],
  repos: readonly { id: string; label: string }[],
): Html {
  return html`<span class="bar" role="group" aria-label="Select">
    <button type="button" class="btn" data-size="sm" form="${formId}" data-pick="all">Select all</button>
    ${kinds.length < 2
      ? null
      : kinds.map(
          (k) =>
            html`<button type="button" class="btn" data-size="sm" form="${formId}" data-pick="kind:${k.id}">${k.label}</button>`,
        )}
    ${repos.length < 2
      ? null
      : html`<select class="input" form="${formId}" data-pick-repo aria-label="Select by repository">
          <option value="">By repository…</option>
          ${repos.map((r) => html`<option value="${r.id}">${r.label}</option>`)}
        </select>`}
  </span>`;
}

const shown = (v: FleetValue): string =>
  v === null ? "nobody" : Array.isArray(v) ? v.join(", ") : String(v);

interface RowView {
  readonly label: string;
  readonly before: FleetValue;
  readonly after: FleetValue;
  readonly outcome: string;
  readonly reason: string;
}

/** Each row of a plan or receipt in one line: what it was, what it is, and why not. */
const bulkRows = (rows: readonly RowView[], skipped: readonly Skipped[]): Html =>
  html`<ul class="list">
    ${rows.map((r) =>
      row({
        title: r.label,
        meta: html`${shown(r.before)} → ${shown(r.after)}${r.reason === "" ? "" : ` · ${r.reason}`}`,
        trail: html`<span class="badge" data-outcome="${r.outcome}">${r.outcome}</span>`,
      }),
    )}
    ${skipped.map((s) =>
      row({
        title: s.item,
        meta: html`${s.reason}`,
        trail: html`<span class="badge" data-outcome="skipped">skipped</span>`,
      }),
    )}
  </ul>`;

const bulkCard = (head: string, body: Html, foot: Html | null): Html =>
  card(body, {
    id: "asks-bulk-result",
    pad: false,
    head: html`<h2 id="asks-bulk-title">${head}</h2>`,
    ...(foot === null ? {} : { foot }),
  });

const nothingDone = (message: string): AsksTop => ({
  banner: html`<p id="asks-bulk-result" role="alert">Nothing done: ${message}.</p>`,
});

/** The receipt of a bulk action on asks, for the person who acted; nothing for anyone else. */
function receiptTop(ctx: Ctx, opId: string): AsksTop | undefined {
  const op = ownAsksOperation(ctx.app, ctx.auth.user, opId);
  if (op === undefined) return undefined;
  const done = op.rows.filter((r) => r.outcome === "ok").length;
  const head = receiptOf(op);
  const undoable = op.reversible && op.undoOf === null && op.undoneBy === null && done > 0;
  return {
    banner: bulkCard(
      head,
      bulkRows(op.rows, []),
      undoable
        ? html`<form method="post" action="/asks/bulk/${op.id}/undo">${btn("Undo", { size: "sm" })}</form>`
        : null,
    ),
  };
}

/** POST /asks/bulk — the preview on this screen, or with `apply` the deed, then its receipt here. */
export async function asksBulkSubmit(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const action = field(form, "action");
  const reason = field(form, "reason").trim();
  const items = form.getAll("item").filter((i): i is string => typeof i === "string");
  if (items.length === 0)
    return await asksScreen(ctx, nothingDone("select at least one ask first"));
  const verb = VERB_WORDS[action] ?? action;
  if (field(form, "apply") === "1") {
    const op = await applyAsksBulk(ctx.app, ctx.auth.user, action, items, reason);
    const inPlace = ctx.request.headers.get("x-forge-fragment") === "1";
    // The script falls back to the plain post on a refusal, which says why.
    if (!op.ok)
      return inPlace
        ? new Response(op.error.message, { status: 422 })
        : await asksScreen(ctx, nothingDone(op.error.message));
    // The page's own script asks for the card alone, and swaps it in place.
    if (inPlace) {
      const why = [
        ...op.value.rows.filter((r) => r.outcome !== "ok").map((r) => r.reason),
        ...op.value.skipped.map((s) => s.reason),
      ];
      const note =
        why.length === 0
          ? undefined
          : `${why.length} not done: ${[...new Set(why.filter((w) => w !== ""))].join("; ") || "refused"}`;
      return onYouAnswer(ctx, ctx.auth.user, note);
    }
    return redirect(`/asks?op=${op.value.id}#asks-bulk-result`);
  }
  const plan = previewAsksBulk(ctx.app, ctx.auth.user, action, items, reason);
  if (!plan.ok) return await asksScreen(ctx, nothingDone(plan.error.message));
  const p = plan.value;
  const foot = html`<form method="post" action="/asks/bulk" class="bar">
    <input type="hidden" name="action" value="${action}" />
    <input type="hidden" name="apply" value="1" />
    <input type="hidden" name="reason" value="${reason}" />
    ${items.map((i) => html`<input type="hidden" name="item" value="${i}" />`)}
    ${p.counts.change > 0 ? btn(`${verb} ${p.counts.change}`, { size: "sm", variant: "primary" }) : null}
    <span class="muted small"
      >${p.counts.refused + p.skipped.length} refused or skipped ·
      ${p.reversible ? "undo afterwards" : "not undone afterwards"}</span
    >
  </form>`;
  return await asksScreen(ctx, {
    banner: bulkCard(`${verb}: ${p.counts.change} of ${items.length}`, bulkRows(p.rows, p.skipped), foot),
    picked: new Set(items),
    action,
    reason,
  });
}

/** POST /asks/bulk/:id/undo — reverse a bulk action on asks, once; its receipt lands here. */
export async function asksBulkUndo(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const op = await undoAsksBulk(ctx.app, ctx.auth.user, ctx.params.id ?? "");
  if (!op.ok)
    return op.error.code === "not_found"
      ? notFoundPage(ctx)
      : await asksScreen(ctx, nothingDone(op.error.message));
  return redirect(`/asks?op=${op.value.id}#asks-bulk-result`);
}

/** POST /asks/decide — hand one hand-over card to the decider; the ledger keeps what it saw. */
export async function asksDecide(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const done = await decideAsk(ctx.app, ctx.auth.user, field(form, "ask"));
  if (!done.ok) return await asksScreen(ctx, nothingDone(done.error.message));
  return redirect(`/asks?decided=${done.value.id}#asks-bulk-result`);
}

/** POST /asks/give-back — hand a handed-over pull back to the builder that opened it; its card leaves. */
export async function asksGiveBack(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const done = giveBack(ctx.app, ctx.auth.user, field(form, "ask"));
  if (!done.ok)
    return done.error.code === "not_found"
      ? notFoundPage(ctx)
      : await asksScreen(ctx, nothingDone(done.error.message));
  return redirect(backTo(form, "/asks"));
}

/** POST /asks/proposal/:id/(approve|redirect|later|again) — one wave proposal, then back to the page the person came from. */
export function asksProposal(verb: ProposalVerb) {
  return async (ctx: Ctx): Promise<Response> => {
    if (!ctx.auth.user) return signInFirst(ctx);
    const form = await readForm(ctx, "rw");
    if (form instanceof Response) return form;
    const done = actOnProposal(ctx.app, ctx.auth.user, verb, ctx.params.id, form.get("words"));
    if (!done.ok)
      return done.error.code === "not_found"
        ? notFoundPage(ctx)
        : done.error.code === "forbidden" || done.error.code === "unauthorized"
          ? forbiddenPage(ctx, NOT_YOURS_TO_DO)
          : prefersJson(ctx)
            ? json({ ok: false, error: done.error.message }, 422)
            : await asksScreen(ctx, nothingDone(done.error.message));
    return prefersJson(ctx) ? json({ ok: true, flash: "Done." }) : redirect(backTo(form, "/asks"));
  };
}

/** POST /asks/decide/:id/undo — put a set-aside card back on the board, within a day. */
export async function asksDecideUndo(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const undone = undoDecideAsk(ctx.app, ctx.auth.user, ctx.params.id);
  if (!undone.ok)
    return undone.error.code === "not_found"
      ? notFoundPage(ctx)
      : await asksScreen(ctx, nothingDone(undone.error.message));
  return redirect(`/asks?decided=${undone.value.id}#asks-bulk-result`);
}

/** POST /asks/listen — take back the viewer's own mute of the repositories named. */
export async function asksListen(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const repos = form
    .getAll("repo")
    .filter((r): r is string => typeof r === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(r))
    .slice(0, BULK_MAX);
  removeMutes(ctx.app.db, ctx.auth.user.id, repos.map((r) => `repo:${r}`));
  const only = repos.length === 1 ? repos[0] : undefined;
  const back = asksBack(form);
  return redirect(only === undefined ? back : withFlash(back, "listened", only));
}

/** POST /asks/mute — the viewer mutes one repository they can read: its asks leave their home, inbox and phone. */
export async function asksMute(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const id = form.get("repo");
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id))
    return notFoundPage(ctx);
  const repo = getRepoById(ctx.app.db, id);
  if (!repo || !canRead(ctx.app.db, repo, ctx.auth.user)) return notFoundPage(ctx);
  muteRepo(ctx.app.db, ctx.auth.user.id, repo.id);
  return redirect(withFlash(asksBack(form), "muted", repo.id));
}

/** POST /asks/filter — `do` (hide_app_day, hide_app, show_app, hide_kind, show_kind, clear) with `repo` or `kind`: one tap, saved for the viewer. */
export async function asksFilter(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const what = form.get("do");
  let change: AskFilterChange | undefined;
  if (what === "clear") change = { do: "clear" };
  else if (what === "hide_kind" || what === "show_kind") {
    const kind = form.get("kind");
    if (isAskKind(kind)) change = { do: what, kind };
  } else if (isAskFilterDo(what)) {
    const id = form.get("repo");
    const repo = typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? getRepoById(ctx.app.db, id) : undefined;
    if (repo !== undefined && canRead(ctx.app.db, repo, ctx.auth.user) && (what === "hide_app_day" || what === "hide_app" || what === "show_app"))
      change = { do: what, repo };
  }
  if (change === undefined) return notFoundPage(ctx);
  applyAskFilter(ctx.app.db, ctx.auth.user, change);
  return redirect(asksBack(form));
}
