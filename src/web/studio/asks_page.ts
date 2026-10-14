/**
 * What needs you, pinned at the top of the home (#634): a sentence — *N
 * things need you* — and under it the decision cards (`asks.ts`), then, for
 * a site admin, one card per thing the forge itself needs. Every button is a
 * plain form post. Many asks at once stay here too: tick them, pick one
 * action, and the preview, the receipt and its Undo appear on top
 * (`actions/asks_bulk.ts`). `/asks` was its own screen; it lands here now.
 */

import {
  applyAsksBulk,
  ownAsksOperation,
  undoAsksBulk,
  previewAsksBulk,
  type Skipped,
} from "../../actions/asks_bulk.ts";
import type { FleetValue } from "../../core/fleet_ops.ts";
import type { Ctx } from "../../http/context.ts";
import type { User } from "../../core/users.ts";
import { studioHome } from "./home.ts";
import { notFoundPage, repoBase, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { listReposVisibleTo } from "../../core/repos.ts";
import { html, type Html } from "../html.ts";
import { redirect } from "../layout.ts";
import { btn, card, icon, row } from "../ui.ts";
import {
  askAnchor,
  askRows,
  askSentence,
  ASK_WORDS,
  ROW_PLURAL,
  decisionButtons,
  decisionForm,
  decisionsFor,
  forgeNeedsFor,
  type AskRow,
  type Consequence,
  type Decision,
} from "./asks.ts";
import { changeHref } from "./nouns.ts";

/** The kinds a bulk action takes: a ceiling and a planner's decline are decided where they live. */
const BULK_KINDS: ReadonlySet<Decision["kind"]> = new Set(["look", "review", "stopped", "parked"]);

/** A row's box for the bulk form, which sits apart (`form="asks-bulk"`): forms do not nest. */
const pick = (d: Decision, picked: ReadonlySet<string>): Html | null =>
  BULK_KINDS.has(d.kind)
    ? html`<input
        type="checkbox"
        class="ask-pick"
        name="item"
        value="${d.id}"
        form="asks-bulk"
        ${picked.has(d.id) ? html`checked` : null}
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
    ${weight(c, which)}${d === undefined ? null : html`<span class="ask-short">${d.short.charAt(0).toUpperCase()}${d.short.slice(1)}. </span>`}<span class="muted"
      >If nobody acts, ${ASK_WORDS[kind].ifNothing}.</span
    >
  </p>`;

/** The kind, in two words: what a phone's row says in place of the sentence under it. */
const KIND_LABEL: Readonly<Record<Decision["kind"], string>> = {
  look: "Ready to ship",
  review: "Needs review",
  stopped: "Stopped",
  parked: "Parked",
  declined: "Declined",
  paused: "Paused",
};

/**
 * An ask's actions: the one that decides, then the rest. A wide screen
 * lays them in a line; a phone puts the decider at the trailing edge, 44 px
 * tall, and the rest behind one tap ("More").
 */
function acts(ctx: Ctx, d: Decision): Html {
  const { primary, others } = decisionButtons(ctx, d);
  return html`<div class="ask-acts">
    ${primary}
    ${others.length === 0
      ? null
      : html`<details class="ask-more-acts">
          <summary class="btn" data-size="sm">More</summary>
          ${others}
        </details>`}
  </div>`;
}

function decisionCard(ctx: Ctx, d: Decision, picked: ReadonlySet<string>): Html {
  const base = repoBase(d.repo);
  const title = d.pull
    ? html`<a href="${changeHref(base, d.pull.number)}">${d.pull.title}</a>`
    : d.issue
      ? html`<a href="${base}/issues/${d.issue.number}">${d.issue.title}</a>`
      : html`<a href="${base}/settings/autonomy">Paused</a>`;
  return card(
    html`${clause(d, d.kind, d.consequence)}
      ${acts(ctx, d)}`,
    {
      id: askAnchor(d.id),
      extra: "ask-card",
      head: html`${pick(d, picked)}
        <h2>${title}</h2>
        <span class="ask-meta muted small"
          ><b class="ask-kind">${KIND_LABEL[d.kind]}</b>${d.repo.ownerName}/${d.repo.name}</span
        >`,
    },
  );
}

/** What a collapsed row says it holds. */
const rowHead = (kind: Decision["kind"], n: number): string => {
  const line = ROW_PLURAL[kind](n);
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}`;
};

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
        title: html`<a href="${href}">${d.pull?.title ?? d.issue?.title ?? ""}</a>`,
        meta: acts(ctx, d),
      });
  });
  // On a phone a group is its head line, its asks one tap away, so two
  // groups never push the composer past the fold; a wider screen holds the
  // details open and shows every line, as before.
  return card(
    html`<details class="ask-group">
      <summary>Show all ${r.items.length}</summary>
      <ul class="list">
        ${lines}
      </ul>
    </details>`,
    {
      pad: false,
      id: askAnchor(r.id),
      extra: "ask-card",
      head: html`${BULK_KINDS.has(r.kind)
          ? html`<input
              type="checkbox"
              class="ask-pick"
              data-select-all
              aria-label="Select all ${r.items.length}"
            />`
          : null}
        <h2>${rowHead(r.kind, r.items.length)}</h2>
        <span class="muted small">${r.repo.ownerName}/${r.repo.name}</span>`,
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

const forgeCard = (sentence: string): Html =>
  card(html`<p>${sentence}</p>`, {
    tone: "danger",
    head: html`${icon("shield")}
      <h2>The forge</h2>
      <span class="spacer"></span>
      ${btn("Health", { href: "/api/v1/health", size: "sm" })}`,
  });

/** What sits above the asks after a bulk step: a preview to confirm, a receipt, or why nothing was done. */
export interface AsksTop {
  readonly banner: Html;
  /** The asks the preview is about, kept ticked. */
  readonly picked?: ReadonlySet<string>;
  readonly action?: string;
}

/** GET /asks — the home, scrolled to what needs you; `?op=<id>` (a bulk
 * action's receipt) rides along. */
export function asksPage(ctx: Ctx): Response {
  const op = ctx.url.searchParams.get("op");
  return redirect(
    op === null
      ? "/#needs-you"
      : `/?op=${encodeURIComponent(op)}#asks-bulk-result`,
  );
}

/** The receipt `?op=<id>` names on the home, when it is the viewer's own. */
export function homeTop(ctx: Ctx): AsksTop | undefined {
  const op = ctx.url.searchParams.get("op");
  return op === null ? undefined : receiptTop(ctx, op);
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
  const decisions = decisionsFor(
    ctx,
    listReposVisibleTo(ctx.app.db, user, { limit: 200 }),
  );
  const needs = forgeNeedsFor(ctx, user);
  const rows = askRows(decisions);
  const count = rows.length + needs.length;
  if (count === 0 && top === undefined)
    return {
      body: html`<h2 id="asks-sentence" class="sr-only">${askSentence(0)}</h2>`,
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
      : more("asks-more", rest.length, html`${rest.map((r) => rowCard(ctx, r, picked))}`);
  // The asks come first, so the first Tab after #needs-you lands on one;
  // the bulk step acts on what was picked, after them.
  const body = html`<section id="needs-you" class="needs-you stack">
    <h2 id="asks-sentence">${askSentence(count)}</h2>
    ${top?.banner ?? null}
    ${needs.map(forgeCard)} ${first.map((r) => rowCard(ctx, r, picked))}
    ${middle.length === 0
      ? null
      : more(
          "asks-phone-more",
          rows.length - first.length,
          html`${middle.map((r) => rowCard(ctx, r, picked))} ${restMore}`,
        )}
    ${pickable < 2
      ? null
      : html`<form id="asks-bulk" method="post" action="/asks/bulk" class="bar">
          <select name="action" class="input" aria-label="What to do with the selected asks">
            ${Object.entries(VERB_WORDS).map(
              ([value, words]) =>
                html`<option value="${value}" ${top?.action === value ? html`selected` : null}>${words}</option>`,
            )}
          </select>
          ${btn("Preview", { size: "sm" })}
          <span class="muted small">on the selected asks</span>
        </form>`}
    ${decisions.map((d) => decisionForm(d))}
  </section>`;
  return { body, scriptJs: pickable < 2 ? "" : SELECT_ALL_JS };
}

/** The home with a bulk step's preview or receipt on top of what needs
 * you — where every bulk answer lands. */
async function asksScreen(ctx: Ctx, top: AsksTop): Promise<Response> {
  const user = ctx.auth.user;
  if (!user) return signInFirst(ctx);
  return await studioHome(ctx, user, top);
}

// ---- many at once: select, preview, do it, undo — all on this screen ----

const VERB_WORDS: Readonly<Record<string, string>> = {
  dismiss: "Dismiss",
  ship: "Ship",
  close: "Close",
  replan: "Hand back to the planner",
};

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
  banner: card(html`<p>Nothing done: ${message}.</p>`, {
    id: "asks-bulk-result",
    tone: "danger",
  }),
});

/** The receipt of a bulk action on asks, for the person who acted; nothing for anyone else. */
function receiptTop(ctx: Ctx, opId: string): AsksTop | undefined {
  const op = ownAsksOperation(ctx.app, ctx.auth.user, opId);
  if (op === undefined) return undefined;
  const verb = VERB_WORDS[op.verb] ?? op.verb;
  const done = op.rows.filter((r) => r.outcome === "ok").length;
  const head = op.undoOf === null ? `${verb}: ${done} done` : `${verb} undone: ${done}`;
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
  const items = form.getAll("item").filter((i): i is string => typeof i === "string");
  if (items.length === 0)
    return await asksScreen(ctx, nothingDone("select at least one ask first"));
  const verb = VERB_WORDS[action] ?? action;
  if (field(form, "apply") === "1") {
    const op = await applyAsksBulk(ctx.app, ctx.auth.user, action, items);
    if (!op.ok) return await asksScreen(ctx, nothingDone(op.error.message));
    return redirect(`/?op=${op.value.id}#asks-bulk-result`);
  }
  const plan = previewAsksBulk(ctx.app, ctx.auth.user, action, items);
  if (!plan.ok) return await asksScreen(ctx, nothingDone(plan.error.message));
  const p = plan.value;
  const foot = html`<form method="post" action="/asks/bulk" class="bar">
    <input type="hidden" name="action" value="${action}" />
    <input type="hidden" name="apply" value="1" />
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
  return redirect(`/?op=${op.value.id}#asks-bulk-result`);
}
