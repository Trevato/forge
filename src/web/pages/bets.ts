/**
 * Bets (#8713): `/:owner/:name/bets` lists the repository's bets, each in
 * one row with its appetite and what to do about it; `/bets/:id` is one bet
 * on one screen — journeys, scopes (figuring out, executing or a raised
 * hand), what is left, and for a finished bet the "try it" moment. Every
 * change is a same-origin POST that lands back on the page with a flash.
 * Server-rendered, no script.
 */

import {
  backBet, endBet, giveVerdict, oneLine, proposeBets, stopBet, writeLeft, type BetError,
} from "../../actions/bets.ts";
import { type Bet, betRuns, betScopes, getBet, listBets } from "../../core/bets.ts";
import { getUserById } from "../../core/users.ts";
import { canAdmin, type Repo } from "../../core/repos.ts";
import { budgetSeconds, MAX_BACKED, mayBack, scopeState, spentSeconds } from "../../crew/bets.ts";
import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { crumbsFor, loadRepo, notFoundPage, pageHead, repoBase, repoHeader, repoPalette } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { liveClientJs, liveMount } from "../live.ts";
import { badge, btn, card, field as fieldRow, listCard, row } from "../ui.ts";

const betHref = (repo: Repo, id: string) => `${repoBase(repo)}/bets/${id}`;

const STATE_WORDS: Record<Bet["state"], string> = {
  proposed: "proposed", backed: "running", stopped: "stopped", done: "finished", cut: "cut",
};

function whoBacked(b: Bet): string {
  return b.backedBy === "planner" ? "not backed by the owner" : b.backedBy === "owner" ? "backed by the owner" : "";
}

function days(seconds: number): string {
  const d = seconds / 86400;
  return `${d < 10 ? Math.round(d * 10) / 10 : Math.round(d)}d`;
}

/** The share of the week used, as words: `1.2d of 2.8d`. */
function useWords(ctx: Ctx, repo: Repo, b: Bet, now: Date): string {
  const spent = b.backedAt === null ? 0 : spentSeconds(betRuns(ctx.app.db, b.id, b.backedAt), now);
  return `${days(spent)} of ${days(budgetSeconds(b.appetite, repo.autonomySlots))} builder time`;
}

function betRow(ctx: Ctx, repo: Repo, b: Bet, now: Date, owner: boolean): Html {
  // The plan — shares, what is left — is for those who administer; a reader sees names and states.
  if (!owner) return row({ href: betHref(repo, b.id), title: html`${b.name}`, trail: badge(STATE_WORDS[b.state]) });
  const meta = [b.state === "backed" ? useWords(ctx, repo, b, now) : "", whoBacked(b), b.state === "stopped" ? b.leftLine : ""]
    .filter((x) => x !== "")
    .join(" · ");
  return row({
    href: betHref(repo, b.id),
    title: html`${b.name}`,
    meta: html`${meta}`,
    trail: badge(`${STATE_WORDS[b.state]} · ${b.appetite}% of the week`, { tone: b.state === "backed" ? "success" : b.state === "stopped" ? "attn" : "default" }),
  });
}

const post = (repo: Repo, b: Bet, verb: string) => `${betHref(repo, b.id)}/${verb}`;

function backForm(repo: Repo, b: Bet, label: string): Html {
  return html`<form method="post" action="${post(repo, b, "back")}" class="bar">
    ${fieldRow({ name: "share", label: "Share of the week (%)", type: "number", min: 1, max: 100, value: String(b.appetite), required: true, id: `share-${b.id}` })}
    ${btn(label, { variant: "primary" })}
  </form>`;
}

function oneButton(repo: Repo, b: Bet, verb: string, label: string, variant: "danger" | "secondary" = "secondary"): Html {
  return html`<form method="post" action="${post(repo, b, verb)}">${btn(label, { variant })}</form>`;
}

/** Journeys shown at rest; the rest sit behind a disclosure so the card stays one screen tall. */
const SHOWN_JOURNEYS = 3;

/**
 * A proposed bet as one card for the owner: name, journeys, its issues as a
 * count that opens the list, and one button that backs it at the proposed
 * share. When the cap or the week forbids it the button is disabled and the
 * reason sits beside it. Changing the share is one disclosure away.
 */
function proposedCard(ctx: Ctx, repo: Repo, b: Bet, backed: readonly Bet[]): Html {
  const scopes = betScopes(ctx.app.db, b.id);
  const journeys = b.journeys.split("\n").filter((j) => j !== "");
  const why = mayBack(backed, b.appetite);
  const issues = scopes.length === 0
    ? html`<p class="muted">No issues yet.</p>`
    : html`<details><summary>${scopes.length} ${scopes.length === 1 ? "issue" : "issues"}</summary>
        <ul>${scopes.map((s) => html`<li><a href="${repoBase(repo)}/issues/${s.number}">#${s.number} ${s.title}</a></li>`)}</ul>
      </details>`;
  return card(
    html`<div data-bet-card><h2><a href="${betHref(repo, b.id)}">${b.name}</a></h2>
      ${journeys.length === 0 ? null : html`<ul>${journeys.slice(0, SHOWN_JOURNEYS).map((j) => html`<li>${j}</li>`)}</ul>`}
      ${journeys.length <= SHOWN_JOURNEYS ? null : html`<details><summary>${journeys.length - SHOWN_JOURNEYS} more ${journeys.length - SHOWN_JOURNEYS === 1 ? "journey" : "journeys"}</summary>
        <ul>${journeys.slice(SHOWN_JOURNEYS).map((j) => html`<li>${j}</li>`)}</ul></details>`}
      ${issues}
      <form method="post" action="${post(repo, b, "back")}">
        <input type="hidden" name="share" value="${String(b.appetite)}">
        ${btn(`Back it at ${b.appetite}%`, { variant: "primary", disabled: why !== null })}
        ${why === null ? null : html`<p class="muted" role="note">${why[0]!.toUpperCase() + why.slice(1)}.</p>`}
      </form>
      <details class="mt"><summary>Change the share</summary>${backForm(repo, b, "Back it")}</details>
      <div class="mt">${oneButton(repo, b, "cut", "Cut it", "danger")}</div></div>`,
  );
}

/** What the owner can do with a bet, by where it is. */
function ownerActions(repo: Repo, b: Bet): Html | null {
  if (b.state === "proposed") return html`${backForm(repo, b, "Back it")}${oneButton(repo, b, "cut", "Cut it", "danger")}`;
  if (b.state === "backed")
    return html`${backForm(repo, b, "Change the share")}${oneButton(repo, b, "stop", "Stop it")}`;
  if (b.state === "stopped")
    return html`${backForm(repo, b, "Back it again")}${oneButton(repo, b, "cut", "Cut it", "danger")}${oneButton(repo, b, "end", "End it: it's done")}`;
  return null;
}

// GET /:owner/:name/bets
export function betsPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const rendering = performance.now();
  const now = new Date();
  const bets = listBets(ctx.app.db, repo.id);
  const owner = ctx.auth.user !== undefined && ctx.auth.user.kind !== "agent" && canAdmin(ctx.app.db, repo, ctx.auth.user);
  const backed = bets.filter((b) => b.state === "backed");
  const running = backed.length;
  const proposed = owner ? bets.filter((b) => b.state === "proposed") : [];
  const rest = owner ? bets.filter((b) => b.state !== "proposed") : bets;
  const body = html`${repoHeader(ctx, repo, "issues")}
    ${pageHead("Bets", { sub: `A few named wholes, each with a share of the week. ${running} of ${MAX_BACKED} running. Builders pick only from running bets, the owner's own asks and small fixes.` })}
    ${bets.length === 0
      ? html`<p class="muted">No bets yet. The planner proposes them from the open work.</p>`
      : html`${owner ? proposed.map((b) => proposedCard(ctx, repo, b, backed)) : null}
        ${rest.length === 0 ? null : listCard(rest.map((b) => betRow(ctx, repo, b, now, owner)))}`}
    ${owner
      ? html`<form method="post" action="${repoBase(repo)}/bets/propose" class="mt">${btn("Ask the planner to propose bets", { variant: "secondary" })}</form>`
      : null}
    ${liveMount({ repo: repoBase(repo) })}`;
  const response = page({ ctx, scriptJs: liveClientJs, title: `Bets · ${repo.name}`, crumbs: crumbsFor(repo), palette: repoPalette(ctx, repo), body });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// GET /:owner/:name/bets/:id
export function betPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  const bet = repo === undefined ? undefined : getBet(ctx.app.db, ctx.params.id ?? "");
  if (!repo || bet === undefined || bet.repoId !== repo.id) return notFoundPage(ctx);
  const rendering = performance.now();
  const now = new Date();
  const user = ctx.auth.user;
  const owner = user !== undefined && user.kind !== "agent" && canAdmin(ctx.app.db, repo, user);
  const lead = bet.leadId === null ? undefined : getUserById(ctx.app.db, bet.leadId);
  const scopes = betScopes(ctx.app.db, bet.id);
  const scopeRows = scopes.map((s) => {
    const state = scopeState(s, now);
    return row({
      href: `${repoBase(repo)}/issues/${s.number}`,
      title: html`#${s.number} ${s.title}`,
      trail: badge(state, { tone: state === "raised hand" ? "attn" : state === "done" ? "success" : "default" }),
    });
  });
  const finished = bet.state === "done";
  const moment = finished
    ? card(
        html`<h2>This is done. Try it.</h2>
          <p><a href="${bet.tryUrl === "" ? repoBase(repo) : bet.tryUrl}">Open it and try it.</a></p>
          ${bet.verdict !== ""
            ? html`<p>${bet.verdict === "done" ? "The owner says it feels done." : owner ? `The owner says not yet: ${bet.verdictWhy}` : "The owner says not yet."}</p>`
            : owner
              ? html`<div class="bar">
                  <form method="post" action="${post(repo, bet, "verdict")}">
                    ${btn("Feels done", { variant: "primary", name: "verdict", value: "done" })}
                  </form>
                  <form method="post" action="${post(repo, bet, "verdict")}" class="bar">
                    ${fieldRow({ name: "why", label: "Not yet, because", maxlength: 240, required: true, id: "why" })}
                    ${btn("Not yet", { name: "verdict", value: "not_yet" })}
                  </form>
                </div>`
              : null}`,
      )
    : null;
  const leftBox =
    owner && (bet.state === "stopped" || bet.state === "backed")
      ? html`<h2 class="mt">What is left</h2>
          <p>${bet.leftLine === "" ? "Not written yet." : bet.leftLine}</p>
          ${owner || (user !== undefined && user.id === bet.leadId)
            ? html`<form method="post" action="${post(repo, bet, "left")}" class="bar">
                ${fieldRow({ name: "line", label: "In one line", maxlength: 240, required: true, id: "line" })}${btn("Save")}
              </form>`
            : null}`
      : null;
  const body = html`${repoHeader(ctx, repo, "issues")}
    ${pageHead(bet.name, { sub: owner ? `${STATE_WORDS[bet.state]} · ${bet.appetite}% of the week${bet.state === "backed" ? ` · ${useWords(ctx, repo, bet, now)}` : ""}${whoBacked(bet) === "" ? "" : ` · ${whoBacked(bet)}`}${lead === undefined ? "" : ` · lead: ${lead.username}`}` : STATE_WORDS[bet.state] })}
    ${moment}
    ${owner ? html`<h2 class="mt">Done looks like</h2>
    <ul>${bet.journeys.split("\n").filter((j) => j !== "").map((j) => html`<li>${j}</li>`)}</ul>` : null}
    <h2 class="mt">Scopes</h2>
    ${scopes.length === 0 ? html`<p class="muted">No scopes yet.</p>` : listCard(scopeRows)}
    ${leftBox}
    ${owner ? html`<div class="mt">${ownerActions(repo, bet)}</div>` : null}
    ${liveMount({ repo: repoBase(repo) })}`;
  const response = page({ ctx, scriptJs: liveClientJs, title: `${bet.name} · bets · ${repo.name}`, crumbs: crumbsFor(repo), palette: repoPalette(ctx, repo), body });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

const WHY: Record<BetError, string> = { forbidden: "Only the owner can do that.", not_found: "No such bet.", refused: "" };

// POST /:owner/:name/bets/propose
export async function betPropose(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const list = `${repoBase(repo)}/bets`;
  const user = ctx.auth.user;
  if (user === undefined || user.kind === "agent" || !canAdmin(ctx.app.db, repo, user))
    return flashTo(ctx, list, { tone: "danger", message: WHY.forbidden });
  const made = proposeBets(ctx.app, repo);
  return flashTo(ctx, list, { message: made.length === 0 ? "Nothing new to propose." : `${made.length} proposed.` });
}

// POST /:owner/:name/bets/:id/:verb
export async function betAct(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const user = ctx.auth.user;
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const list = `${repoBase(repo)}/bets`;
  if (user === undefined) return flashTo(ctx, list, { tone: "danger", message: "Sign in first." });
  const id = ctx.params.id ?? "";
  const verb = ctx.params.verb ?? "";
  const share = Number(field(form, "share"));
  const verdict = field(form, "verdict");
  const result =
    verb === "back" ? backBet(ctx.app, user, repo, id, share)
      : verb === "stop" ? stopBet(ctx.app, user, repo, id)
      : verb === "cut" ? endBet(ctx.app, user, repo, id, "cut")
      : verb === "end" ? endBet(ctx.app, user, repo, id, "done")
      : verb === "left" ? writeLeft(ctx.app, user, repo, id, field(form, "line"))
      : verb === "verdict" && (verdict === "done" || verdict === "not_yet") ? giveVerdict(ctx.app, user, repo, id, verdict, field(form, "why"))
      : null;
  if (result === null) return notFoundPage(ctx);
  if (!result.ok) return flashTo(ctx, result.error.error === "not_found" ? list : betHref(repo, id), { tone: "danger", message: result.error.message || WHY[result.error.error] });
  return flashTo(ctx, betHref(repo, id), { message: oneLine(`${result.value.name}: ${STATE_WORDS[result.value.state]}.`) });
}
