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
import { btn, card, icon } from "../ui.ts";
import {
  askSentence,
  decisionActions,
  decisionForm,
  decisionsFor,
  forgeNeedsFor,
  type Decision,
} from "./asks.ts";
import { changeHref } from "./nouns.ts";

function decisionCard(ctx: Ctx, d: Decision): Html {
  const base = repoBase(d.repo);
  const title = d.pull
    ? html`<a href="${changeHref(base, d.pull.number)}">${d.pull.title}</a>`
    : html`<a href="${base}/settings/autonomy">Paused</a>`;
  return card(
    html`<p>${d.says}</p>
      <div class="bar mt">${decisionActions(ctx, d)}</div>`,
    {
      id: d.id.replace(/[^a-z0-9-]/g, "-"),
      head: html`${icon(d.kind === "look" ? "eye" : "pull")}
        <h2>${title}</h2>
        <span class="muted small">${d.repo.ownerName}/${d.repo.name}</span>`,
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
  const count = decisions.length + needs.length;
  const body = html`<h1 id="asks-sentence">${askSentence(count)}</h1>
    <div class="stack">
      ${decisions.map((d) => decisionCard(ctx, d))}
      ${needs.map(forgeCard)}
    </div>
    ${decisions.map((d) => decisionForm(d))}`;
  return page({ ctx, title: askSentence(count), body });
}
