/**
 * /pipeline, open to anyone: the one path a change follows, in four words
 * (#7703). A newcomer reads it top to bottom and can say how a change gets
 * from a pull to production; each step's finer machinery is one click down
 * (the row folds), and the live counts per stage are on /boards. Every pull
 * page links here from its path line (`changeHead`), and the MCP `pull`
 * answers the same four words as `step`.
 */
import type { Ctx } from "../../http/context.ts";
import { STEP_MEANS, STEPS, type Step } from "../../flow/path.ts";
import { cachedStepStats, statParts, STEP_WINDOW_DAYS, type StepStat } from "../../flow/pipeline.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";
import { reportPath } from "../../checks/report.ts";
import { stat } from "../ui.ts";

/** What a pull waits on at each step, what only that step catches, and the parts inside it. */
export const STEP_DETAIL: Record<Step, { waits: string; catches: string; inside: readonly string[] }> = {
  check: {
    waits: "a free check slot, then the check itself (minutes).",
    catches: "a change that does not type-check, breaks the lint, or fails a test its own files reach.",
    inside: [
      "The gate script and the type check, on the pull's head.",
      "The tests the change reaches (the fast tier), sharded across the check's machine.",
      "A red main pauses pulls' checks for a while, so a pull is not blamed for main's red.",
    ],
  },
  review: {
    waits: "a reviewer: an agent for agent pulls, or a person who can write the repository.",
    catches: "what no test asks: the wrong change, an unsafe one, or one nobody asked for.",
    inside: [
      "A verdict counts for the head it was given on; a new push asks for a fresh look.",
      "Changes asked send the pull back to its builder, who pushes and is checked again.",
    ],
  },
  land: {
    waits: "the merge queue, which merges approved, green pulls into the default branch in order.",
    catches: "a pull that no longer merges onto the base as it is now.",
    inside: [
      "The merge queue's gate: lint and types on the pull merged with the base's tip.",
      "A conflicting pull goes back to its builder to rebase before it can land.",
    ],
  },
  live: {
    waits: "the next release of the default branch.",
    catches: "a tree that builds and checks but does not boot or answer as a website.",
    inside: [
      "The release build, and a boot of the built image on an empty data directory.",
      "The new version takes over the port only once it answers healthy.",
      "After the swap the forge loads its own public pages; a failure is paged.",
    ],
  },
};

/** Which measured parts sit inside each step of the path. */
export const STEP_MEASURES: Record<Step, readonly StepStat["key"][]> = {
  check: ["pull-check"],
  review: ["review"],
  land: ["gate"],
  live: ["main-check", "release", "boot", "verify"],
};

const title = (s: Step) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

// GET /pipeline
export function pipelinePage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const rendering = performance.now();
  // Public repositories alone: this page is open to anyone.
  const stats = new Map(cachedStepStats(ctx.app.db, new Date(), true).map((m) => [m.key, m]));
  const body = html`<div class="page-head">
      <h1>How a change lands</h1>
      <p class="muted">
        Every change follows the same four steps:
        <strong>check, review, land, live</strong>. A pull's page says which
        one it is at and, in one sentence, why it waits there.
      </p>
    </div>
    <div id="path">
      ${STEPS.map((s, i) => {
        const d = STEP_DETAIL[s];
        return html`<section class="mb" id="${s}" data-step="${s}">
          <h2>${i + 1}. ${title(s)}</h2>
          <p>${STEP_MEANS[s]}</p>
          <details id="inside-${s}">
            <summary class="small">What is inside</summary>
            <p class="small">It waits for ${d.waits} Only this step catches ${d.catches}</p>
            <ul class="small">${d.inside.map((line) => html`<li>${line}</li>`)}</ul>
            <p class="small muted">Measured, last ${STEP_WINDOW_DAYS} days, public repositories: median time, then how often red.</p>
            <div class="stats" data-measures="${s}">${STEP_MEASURES[s].map((k) => {
              const m = stats.get(k);
              if (m === undefined) return "";
              const p = statParts(m);
              return stat({ label: m.label, value: p.value, title: m.medianMs === null ? "no median" : `median ${p.value}`, note: p.note, noteTitle: p.note });
            })}</div>
          </details>
        </section>`;
      })}
    </div>
    <section class="mb">
      <h2>Where to look next</h2>
      <p class="small">
        The whole test suite does not stand in the path: a pull's check runs the tests its change reaches,
        and the rest of the path runs lint and types. An admin sees how many changes sit at each step right now on
        <a href="/boards">Boards</a>.
      </p>
      <p class="small" id="full-suite">
        The whole suite still runs, as a report: after a landing, on a schedule, against the default branch's tip.
        Each test file it finds failing gets one issue labelled <span class="mono">full-suite</span>, listed
        <a href="${reportPath()}">here</a>. The report holds no pull, batch or release.
      </p>
      <p class="muted small">For agents: the MCP tool <span class="mono">pull</span> answers <span class="mono">step: { step, why, done }</span> with these four words.</p>
    </section>`;
  const response = page({ ctx, title: "How a change lands", body });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}
