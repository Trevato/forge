/**
 * `/asks`: the one screen that answers "is everything fine?". A sentence —
 * *All fine*, or *N things need you* — and under it the decision cards
 * (`asks.ts`), then, for a site admin, one card per thing the forge itself
 * needs. First paint is the whole page; every button is a plain form post.
 */

import type { Ctx } from "../../http/context.ts";
import { repoBase, signInFirst } from "../chrome.ts";
import { listReposVisibleTo } from "../../core/repos.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { btn, card, icon, listCard, row } from "../ui.ts";
import {
  askAnchor,
  askRows,
  askSentence,
  ASK_WORDS,
  decisionActions,
  decisionForm,
  decisionsFor,
  forgeNeedsFor,
  type AskRow,
  type Consequence,
  type Decision,
} from "./asks.ts";
import { changeHref } from "./nouns.ts";

/** The kinds a bulk action takes: a ceiling and a planner's decline are decided where they live. */
const BULK_KINDS: ReadonlySet<Decision["kind"]> = new Set(["look", "stopped", "parked"]);

/** A row's box for the bulk form, which sits apart (`form="asks-bulk"`): forms do not nest. */
const pick = (d: Decision): Html | null =>
  BULK_KINDS.has(d.kind)
    ? html`<input
        type="checkbox"
        class="ask-pick"
        name="item"
        value="${d.id}"
        form="asks-bulk"
        aria-label="Select ${d.pull?.title ?? d.issue?.title ?? d.id}"
      />`
    : null;

/** "Select all of this kind": the one box on a collapsed row's head. */
const SELECT_ALL_JS = `document.addEventListener('change', function (e) {
  var t = e.target;
  if (!t || !t.matches || !t.matches('[data-select-all]')) return;
  var card = t.closest('.card');
  if (card) card.querySelectorAll('input[name="item"]').forEach(function (b) { b.checked = t.checked; });
});`;

/** The rows shown before "N more": the few that matter most. */
export const ASKS_SHOWN = 5;

/** Why it ranks high, when that is more than its kind: security, money, held-up work. */
const weight = (c: Consequence): Html | null =>
  c.score >= 60 ? html`<b>${c.why}</b> · ` : null;

/** One clause, and what happens if nobody acts — never the same sentence twice. */
const clause = (d: Decision | undefined, kind: Decision["kind"], c: Consequence): Html =>
  html`<p>
    ${weight(c)}${d === undefined ? null : html`${d.short.charAt(0).toUpperCase()}${d.short.slice(1)}. `}<span class="muted"
      >If nobody acts, ${ASK_WORDS[kind].ifNothing}.</span
    >
  </p>`;

function decisionCard(ctx: Ctx, d: Decision): Html {
  const base = repoBase(d.repo);
  const title = d.pull
    ? html`<a href="${changeHref(base, d.pull.number)}">${d.pull.title}</a>`
    : d.issue
      ? html`<a href="${base}/issues/${d.issue.number}">${d.issue.title}</a>`
      : html`<a href="${base}/settings/autonomy">Paused</a>`;
  return card(
    html`${clause(d, d.kind, d.consequence)}
      <div class="bar mt">${decisionActions(ctx, d)}</div>`,
    {
      id: askAnchor(d.id),
      head: html`${pick(d) ?? icon(d.kind === "look" ? "eye" : "pull")}
        <h2>${title}</h2>
        <span class="muted small">${d.repo.ownerName}/${d.repo.name}</span>`,
    },
  );
}

/** What a collapsed row says it holds. */
const rowHead = (kind: Decision["kind"], n: number): string =>
  kind === "parked"
    ? `${n} issues parked after three failed runs`
    : kind === "stopped"
      ? `The crew stopped on ${n} changes`
      : `${n} green changes wait for your look`;

/** One card for one kind in one repository: a line per ask, each with its own actions. */
function rowCard(ctx: Ctx, r: AskRow<Decision>): Html {
  const only = r.items.length === 1 ? r.items[0] : undefined;
  if (only) return decisionCard(ctx, only);
  const base = repoBase(r.repo);
  return listCard(
    r.items.map((d) => {
      const number = d.pull?.number ?? d.issue?.number;
      const href = d.pull
        ? changeHref(base, d.pull.number)
        : `${base}/issues/${String(number)}`;
      const box = pick(d);
      return row({
        ...(box === null ? {} : { lead: box }),
        title: html`<a href="${href}">${d.pull?.title ?? d.issue?.title ?? ""}</a>`,
        meta: html`<span class="bar">${decisionActions(ctx, d)}</span>`,
      });
    }),
    {
      id: askAnchor(r.id),
      head: html`${BULK_KINDS.has(r.kind)
          ? html`<input
              type="checkbox"
              class="ask-pick"
              data-select-all
              aria-label="Select all ${r.items.length}"
            />`
          : icon(r.kind === "look" ? "eye" : "pull")}
        <h2>${rowHead(r.kind, r.items.length)}</h2>
        <span class="muted small">${r.repo.ownerName}/${r.repo.name}</span>`,
      foot: clause(undefined, r.kind, r.consequence),
    },
  );
}

const forgeCard = (sentence: string): Html =>
  card(html`<p>${sentence}</p>`, {
    tone: "danger",
    head: html`${icon("shield")}
      <h2>The forge</h2>
      <span class="spacer"></span>
      ${btn("Health", { href: "/api/v1/health", size: "sm" })}`,
  });

export function asksPage(ctx: Ctx): Response {
  const user = ctx.auth.user;
  if (!user) return signInFirst(ctx);
  const decisions = decisionsFor(
    ctx,
    listReposVisibleTo(ctx.app.db, user, { limit: 200 }),
  );
  const needs = forgeNeedsFor(ctx, user);
  const rows = askRows(decisions);
  const count = rows.length + needs.length;
  // The forge's own health first, then the few asks that matter most;
  // the rest are one tap away, in the same order.
  const first = rows.slice(0, ASKS_SHOWN);
  const rest = rows.slice(ASKS_SHOWN);
  const pickable = decisions.filter((d) => BULK_KINDS.has(d.kind)).length;
  const body = html`<h1 id="asks-sentence">${askSentence(count)}</h1>
    ${pickable < 2
      ? null
      : html`<form id="asks-bulk" method="post" action="/asks/bulk" class="bar mb">
          <select name="action" class="input" aria-label="What to do with the selected asks">
            <option value="dismiss">Dismiss</option>
            <option value="ship">Ship</option>
            <option value="close">Close</option>
            <option value="replan">Hand back to the planner</option>
          </select>
          ${btn("Preview", { size: "sm" })}
          <span class="muted small">on the selected asks</span>
        </form>`}
    <div class="stack">
      ${needs.map(forgeCard)} ${first.map((r) => rowCard(ctx, r))}
    </div>
    ${rest.length === 0
      ? null
      : html`<details class="mt" id="asks-more">
          <summary>${rest.length} more</summary>
          <div class="stack mt">${rest.map((r) => rowCard(ctx, r))}</div>
        </details>`}
    ${decisions.map((d) => decisionForm(d))}`;
  return page({
    ctx,
    title: askSentence(count),
    body,
    ...(pickable < 2 ? {} : { scriptJs: SELECT_ALL_JS }),
  });
}
