/**
 * Home names a run the forge's restarts stopped twice (#11583): one plain
 * line per such run in the last 24 hours — its issue, the reason in the
 * words the run carries, and Try again, which posts to the run's re-queue
 * route. One bounded query; no line when there is none, and none once a
 * newer run of the same issue exists (Try again made one).
 */

import type { Repo } from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { stoppedTwiceRuns } from "../../runs/stopped_twice.ts";
import { repoBase } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { btn } from "./../ui.ts";

/** The lines for runs stopped twice that this person may try again; nothing where none is. */
export function stoppedTwiceLine(ctx: Ctx, writable: readonly Repo[], now = Date.now()): Html | null {
  const rows = stoppedTwiceRuns(ctx.app.db, writable, now);
  if (rows.length === 0) return null;
  return html`<section class="stack stack-tight" id="stopped-twice" aria-label="Stopped runs">
    ${rows.map((row) => {
      const repo = row.repo;
      return html`<form class="bar small" method="post" action="${repoBase(repo)}/runs/${row.runId}/requeue">
        <span
          ><a href="${repoBase(repo)}/issues/${row.number}">${repo.name}#${row.number} ${row.title}</a>:
          ${row.reason}</span
        >
        ${btn("Try again", { size: "sm", variant: "outline" })}
      </form>`;
    })}
  </section>`;
}
