/**
 * /flow, for a forge admin: the pipeline from a ready issue to a live
 * deploy as rows, one per stage, each with how much is in it now, how long
 * its oldest waiting item has waited, and the capacity that limits it
 * (#1554). One sentence above names the stage with the longest wait — the
 * bottleneck. The numbers are `flow/pipeline.ts`'s; the knobs stay on
 * Settings → Capacity, linked from here.
 *
 * Beside what each stage holds, what it let out (#1779): items out in the
 * last hour and a 24-bar sparkline per stage, and a headline line of
 * landings and the median ask→live — `flow/throughput.ts`'s numbers, the
 * same ones the MCP `flow` tool and the terminal's Flow command read. Every
 * count links back here with `?out=<what>[&hour=<0–23>]`, which lists the
 * items it counted under the table.
 *
 * Under it, the merge queue (#2036): per repository, what is queued for the
 * next candidate, what the candidate at the gate carries, and what landed
 * in the last hour — `flow/queue.ts`'s numbers, which the terminal's Flow
 * command and the MCP `flow` tool read too.
 *
 * Beside the conflicted pulls, the pulls with changes requested (#2172):
 * those waiting on a builder apart from those waiting on a reviewer, by
 * age — `flow/requested.ts`'s, the rows the tick moves.
 *
 * Under the pipeline, why ready issues cannot start (#2244): per autonomous
 * repository, its ready list as one bar, startable beside each filter that
 * holds the rest — `flow/held.ts`'s rows, the same the tick line says and
 * the terminal's Flow command prints.
 */

import { noteRead, telemetryReader } from "../../actions/telemetry.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";
import { flowPanel, flowPanelCss } from "./flow-panel.ts";

// GET /flow
export function flowPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  const reader = telemetryReader(ctx.app, ctx.auth.user);
  if (!reader) return notFoundPage(ctx);
  noteRead(ctx.app, ctx.auth.user, reader, "flow");
  const body = html`<div class="page-head">
      <h1>Flow</h1>
      <p class="muted">
        From a ready issue to a live deploy: what is in each stage now, how
        long its oldest has waited, and what limits it. The limits are set on
        <a href="/settings/capacity">Capacity</a> and in each repository's
        autonomy settings. How the forge stands against its threats is on
        <a href="/resilience">Resilience</a>. Where an outside agent can
        help is on <a href="/contribute">Contribute</a>.
      </p>
    </div>
    ${flowPanel(ctx.app, reader, ctx.url, "/flow")}`;
  return page({ ctx, title: "Flow", body, styleCss: flowPanelCss });
}
