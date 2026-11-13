/**
 * Home names a run the host interrupted until it was given up on (#11583): one plain
 * line per such run in the last 24 hours — its issue, the reason in the
 * words the run carries, and Try again, which posts to the run's re-queue
 * route. One bounded query; no line when there is none, and none once a
 * newer run of the same issue exists (Try again made one).
 */

import type { Repo } from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { interruptedOutRuns } from "../../runs/interrupted_out.ts";
import { repoBase } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { btn } from "./../ui.ts";

/** The lines for runs given up after interruptions that this person may try again; nothing where none is. */
export function interruptedOutLine(ctx: Ctx, writable: readonly Repo[], now = Date.now()): Html | null {
  const rows = interruptedOutRuns(ctx.app.db, writable, now);
  if (rows.length === 0) return null;
  return html`<section class="stack stack-tight" id="interrupted-out" aria-label="Stopped runs">
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
