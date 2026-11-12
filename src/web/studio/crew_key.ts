/**
 * Bring your own key (#11154): the one field that makes a forge's crew work,
 * the words for each state of the crew's means (own key, included credit
 * with money left, credit spent, nothing), and the POST that seals the key.
 * The key is sealed in this forge's database by `addSubscription`, offered to
 * the crew of the owner's apps, and goes nowhere else: never logged, never
 * echoed, never sent to the host.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../../app.ts";
import { listAgents } from "../../core/agents.ts";
import { saveCrewKey } from "../../actions/crew_key.ts";
import { wokeWords } from "../../crew/wake.ts";
import { crewHasCredential } from "../../core/subscriptions.ts";
import { leftUsd, usdWords } from "../../spawn/credit.ts";
import { fundingOf } from "../../spawn/funding.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { icon } from "../icons.ts";
import { flashTo } from "../layout.ts";
import { btn } from "../ui.ts";

export const KEY_ACTION = "/settings/crew/key";
/** The form is the key and little else: far under the general body limit. */
const KEY_FORM_MAX = 2048;

export interface Included {
  readonly capUsd: number;
  /** What the host counted the runs actually cost; a reservation or a run's declared budget is never in it. */
  readonly spentUsd: number;
  readonly leftUsd: number;
}

/** The credit this forge came with and what is left of it (last heard from its host), or undefined when it has none. */
export function includedCredit(app: App): Included | undefined {
  const f = fundingOf(app.config.dataDir);
  if (f === undefined || f.capUsd === null) return undefined;
  const spentUsd = f.spentUsd ?? 0;
  return { capUsd: f.capUsd, spentUsd, leftUsd: leftUsd({ capUsd: f.capUsd, spentUsd }) };
}

/** Whether a forge is a hosted child: its host's file is in its data directory. */
export const isHostedForge = (app: App): boolean => existsSync(join(app.config.dataDir, "parent.json"));

/** Whether the crew has anything to run on: a key of the owner's, or included credit with money left. */
export function crewCanRun(app: App): boolean {
  if (crewHasCredential(app.db)) return true;
  const c = includedCredit(app);
  return c !== undefined && c.leftUsd > 0;
}

/** Whether the forge has a crew at all, so a line about it is true. */
export const hasCrew = (app: App): boolean => listAgents(app.db).length > 0;

/** Said once where a forge of its own runs on its own key. */
const OWN_KEY_NOTE = "The crew works on this forge's own model key; the host's included credit is not drawn on.";

/** What the crew runs on, in one sentence and no field: the first screen's line, said the same on the page and in the terminal. */
export function crewNote(app: App): string {
  if (crewHasCredential(app.db))
    return isHostedForge(app) ? OWN_KEY_NOTE : "The crew works on this forge's own model key.";
  const credit = includedCredit(app);
  if (credit !== undefined && credit.leftUsd > 0)
    return `The crew is building on ${usdWords(credit.leftUsd)} of ${usdWords(credit.capUsd)} included credit.`;
  if (credit !== undefined) return "The included credit is spent; the crew needs a model key to go on.";
  return NO_CREDIT_WORDS;
}

/** What a forge whose crew has nothing to run on says, on the page and in the terminal. */
export const NO_CREDIT_WORDS = "The crew cannot build until you add a model key or pick a plan.";

/** The first screen's line as plain text, for the terminal: the same words as `crewFirstLine`, no links. */
export function crewFirstText(app: App): string {
  return crewCanRun(app) ? `${crewNote(app)} Next: make an app or bring a repository.` : NO_CREDIT_WORDS;
}

/** The first screen's one line: with credit the next step, without it the two ways forward, each a link (#11240). */
export function crewFirstLine(app: App, admin: boolean): Html {
  if (crewCanRun(app))
    return html`${crewNote(app)} Next: <a href="/apps/new">make an app</a> or <a href="/new">bring a repository</a>.`;
  return html`The crew cannot build until you ${admin ? html`<a href="/settings/subscriptions">add a model key</a>` : "add a model key"} or <a href="/pricing">pick a plan</a>.`;
}

const keyField = (): Html => html`<form class="stack" method="post" action="${KEY_ACTION}" id="crew-key-form">
  <div class="field">
    <label for="crew-key">Your Anthropic API key or Claude login</label>
    <input class="input" id="crew-key" name="token" type="password" required maxlength="512" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" />
  </div>
  <div>${btn("Save key", { variant: "primary", size: "sm", icon: "key" })}</div>
</form>`;

/** On a forge of its own that has its own key: which one is paying, so nobody wonders whether the host's credit is drawn on. */
function payingCard(app: App, compact: boolean): Html | null {
  if (compact || !isHostedForge(app)) return null;
  return html`<p class="small muted" id="crew-key-note" role="status">${icon("key")} ${OWN_KEY_NOTE}</p>`;
}

/** What the crew runs on, said once, with the field when a key would change anything (`compact`: a line and a link, no field). */
export function crewKeyCard(ctx: Ctx, compact = false): Html | null {
  // Credit left is something to run on: the card never asks for a key then, in any form (#11508).
  if (crewHasCredential(ctx.app.db)) return payingCard(ctx.app, compact);
  const admin = ctx.auth.user?.isAdmin === true;
  // On a repository page: one line and a link, the field lives on the home page.
  if (compact) {
    if (crewCanRun(ctx.app)) return null;
    return html`<p class="small muted" id="crew-key-note" role="status">${icon("alert")} The crew needs a model key to start.
      ${admin ? html`<a href="/#crew-key-note">Add one on the home page</a>.` : "Ask this forge's admin to add one."}</p>`;
  }
  const credit = includedCredit(ctx.app);
  if (credit !== undefined && credit.leftUsd > 0)
    return html`<section class="settings-block" id="crew-key-note" role="status">
      <p class="small muted">${icon("key")} The crew is building on ${usdWords(credit.leftUsd)} of ${usdWords(credit.capUsd)} included credit.
        ${admin ? "Add your own key any time to keep building after it:" : "Its admin can add a key to keep building after it."}</p>
      ${admin ? keyField() : null}
    </section>`;
  const said =
    credit !== undefined
      ? "The included credit is spent. Add your own key to keep building, or wait for next month."
      : "The crew needs a model key to start. Paste yours.";
  return html`<section class="settings-block" id="crew-key-note" role="status">
    <p class="small muted">${icon("alert")} ${said}${admin ? "" : " Ask this forge's admin."}</p>
    ${admin ? keyField() : null}
  </section>`;
}

// POST /settings/crew/key
export async function crewKeyAdd(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (!user) return signInFirst(ctx);
  if (!user.isAdmin) return notFoundPage(ctx);
  const form = await readForm(ctx, "admin", KEY_FORM_MAX);
  if (form instanceof Response) return form;
  const saved = await saveCrewKey(ctx.app, user, field(form, "token"));
  if (!saved.ok)
    return saved.error === "not_found"
      ? notFoundPage(ctx)
      : flashTo(ctx, "/", { tone: "danger", message: "That key could not be saved. Check that it is the whole key and try again." });
  return flashTo(ctx, "/", { message: `Key saved. The crew can work now. ${wokeWords(saved.woken)}`.trim() });
}
