/**
 * The four words of home's Now line, each opening what it counts: the checks,
 * the reviews, the approved pulls waiting to land, the deploys that are live.
 * The list is `readNowRows`, so its length is the number on home. A site
 * admin's, as the line is: the counts cover every repository.
 */

import { mayReadNow, NOW_HOLDS, NOW_LISTED, NOW_STAGES, NOW_WORDS, readNowRows, type NowStage } from "../../flow/now_rows.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";
import { row, timeAgo } from "../ui.ts";

/** Where a word of the Now line goes. */
export const nowHref = (stage: NowStage): string => `/now/${stage}`;

// GET /now/:stage
export function nowPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const user = ctx.auth.user;
  if (user === undefined) return signInFirst(ctx);
  const stage = NOW_STAGES.find((s) => s === ctx.params["stage"]);
  if (stage === undefined || !mayReadNow(user)) return notFoundPage(ctx);
  const reading = performance.now();
  const { total, rows } = readNowRows(ctx.app.db, stage);
  const body =
    total === 0
      ? html`<p class="muted">Nothing in ${NOW_WORDS[stage].toLowerCase()} right now.</p>`
      : html`<ul class="list setting-list">
          ${rows.map((r) =>
            row({
              href: r.href,
              nav: true,
              title: html`${r.title}`,
              meta: html`${r.repo} · ${r.note}`,
              trail: html`<span class="muted small">${timeAgo(r.at)}</span>`,
            }),
          )}
        </ul>`;
  notePhase(ctx.request, "render", performance.now() - reading);
  return page({
    ctx,
    title: NOW_WORDS[stage],
    body: html`<div data-now><div class="page-head"><h1>${NOW_WORDS[stage]}</h1></div>
      <p class="muted small" id="now-count"><strong>${String(total)}</strong> · ${NOW_HOLDS[stage]}${total > rows.length ? ` Showing the newest ${NOW_LISTED}.` : ""}</p>
      ${body}</div>`,
  });
}
