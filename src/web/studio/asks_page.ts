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
  decisionActions,
  decisionForm,
  decisionsFor,
  forgeNeedsFor,
  type AskRow,
  type Decision,
} from "./asks.ts";
import { changeHref } from "./nouns.ts";

function decisionCard(ctx: Ctx, d: Decision): Html {
  const base = repoBase(d.repo);
  const title = d.pull
    ? html`<a href="${changeHref(base, d.pull.number)}">${d.pull.title}</a>`
    : d.issue
      ? html`<a href="${base}/issues/${d.issue.number}">${d.issue.title}</a>`
      : html`<a href="${base}/settings/autonomy">Paused</a>`;
  return card(
    html`<p>${d.says}</p>
      <div class="bar mt">${decisionActions(ctx, d)}</div>`,
    {
      id: askAnchor(d.id),
      head: html`${icon(d.kind === "look" ? "eye" : "pull")}
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
      return row({
        title: html`<a href="${href}">${d.pull?.title ?? d.issue?.title ?? ""}</a>`,
        meta: html`<span class="bar">${decisionActions(ctx, d)}</span>`,
      });
    }),
    {
      id: askAnchor(r.id),
      head: html`${icon(r.kind === "look" ? "eye" : "pull")}
        <h2>${rowHead(r.kind, r.items.length)}</h2>
        <span class="muted small">${r.repo.ownerName}/${r.repo.name}</span>`,
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
  const body = html`<h1 id="asks-sentence">${askSentence(count)}</h1>
    <div class="stack">
      ${rows.map((r) => rowCard(ctx, r))}
      ${needs.map(forgeCard)}
    </div>
    ${decisions.map((d) => decisionForm(d))}`;
  return page({ ctx, title: askSentence(count), body });
}
