/**
 * A stalled flow step on the home: one card per pull whose check has not
 * been asked for, or is red, for longer than its stage allows — the pull,
 * its stage, how long it has been stuck, and the one button that unblocks
 * it. The button is a plain form post to the pull's own checks route, which
 * checks the origin and write access and, told `next=/`, comes back to the
 * home with a flash rather than leaving it. A step that moves on is gone on the
 * next render; nothing is stored.
 */

import { readStalled, type StalledStep } from "../../flow/stalled.ts";
import type { User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { html, type Html } from "../html.ts";
import { badge, btn, card, timeAgo } from "../ui.ts";

const BUTTON: Record<StalledStep["action"], string> = { run: "Run check", rerun: "Re-run" };

function stalledCard(s: StalledStep): Html {
  const base = `/${s.ownerName}/${s.repoName}/pulls/${s.pull}`;
  const head = html`${badge(s.stage, { variant: "secondary" })}
      <span class="muted small">${s.ownerName}/${s.repoName} · stuck since ${timeAgo(s.since)}</span>`;
  const body = html`<p class="break"><a href="${base}">${s.title}</a>${s.issue === null ? null : html` <span class="muted small">for #${String(s.issue)}</span>`}</p>
    <form method="post" action="${base}/checks" class="bar">
      <input type="hidden" name="next" value="/">
      ${btn(BUTTON[s.action], { size: "sm", icon: "play" })}
      <span class="muted small break">${s.unblock}</span>
    </form>`;
  return card(body, { head, attrs: html`data-flow-card="${s.repo}#${String(s.pull)}"` });
}

/** The cards, oldest stall first; nothing at all when nothing is stalled. Every one is shown: the
 * flow page is an admin's, so a writer has nowhere else to find a cut-off one. */
export function flowCards(ctx: Ctx, user: User): Html | null {
  const steps = readStalled(ctx.app.db, user, new Date());
  if (steps.length === 0) return null;
  return html`<section class="feed" aria-label="Stalled">
    ${steps.map(stalledCard)}
  </section>`;
}
