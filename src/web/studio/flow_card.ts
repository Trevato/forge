/**
 * A stalled flow step on the home: one card per pull whose check has not
 * been asked for, or is red, for longer than its stage allows — the pull,
 * its stage, how long it has been stuck, and the one button that unblocks
 * it. The button is a plain form post to the pull's own checks route, which
 * checks the origin and write access and, told `next=/`, comes back to the
 * home with a flash rather than leaving it. A step that moves on is gone on the
 * next render; nothing is stored.
 */

import { readStalled, STALLED_SHOWN, type StalledStep } from "../../flow/stalled.ts";
import type { User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { html, type Html } from "../html.ts";
import { btn, timeAgo } from "../ui.ts";

const BUTTON: Record<StalledStep["action"], string> = { run: "Run check", rerun: "Re-run" };

function stalledCard(s: StalledStep): Html {
  const base = `/${s.ownerName}/${s.repoName}/pulls/${s.pull}`;
  return html`<article class="fcard" data-flow-card="${s.repo}#${String(s.pull)}">
    <div class="fcard-head">
      <strong class="fcard-who">${s.stage}</strong>
      <span class="fcard-app muted small">${s.ownerName}/${s.repoName} · stuck since ${timeAgo(s.since)}</span>
    </div>
    <p class="fcard-reason"><a href="${base}">${s.title}</a>${s.issue === null ? null : html` <span class="muted small">for #${String(s.issue)}</span>`}</p>
    <form method="post" action="${base}/checks" class="inline-form">
      <input type="hidden" name="next" value="/">
      ${btn(BUTTON[s.action], { size: "sm", icon: "loader" })}
      <span class="muted small">${s.unblock}</span>
    </form>
  </article>`;
}

/** The cards, oldest stall first; nothing at all when nothing is stalled. */
export function flowCards(ctx: Ctx, user: User): Html | null {
  const steps = readStalled(ctx.app.db, user, new Date());
  if (steps.length === 0) return null;
  return html`<section class="feed" aria-label="Stalled">
    ${steps.slice(0, STALLED_SHOWN).map(stalledCard)}
  </section>`;
}
