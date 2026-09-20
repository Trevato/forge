/**
 * A run's log, windowed: the bound, the truncation notice, and the box both
 * a run's full transcript (`studio/run.ts`) and a compact tail beside a
 * running row (`studio/app.ts`, and any page that wants the same peek)
 * render into. One place for the shape, so a second page never grows a
 * second copy of it.
 */

import { logLine } from "../pages/runs.ts";
import { html, when, type Html } from "../html.ts";

/** At most this many of a run's own lines held in a full transcript at
 * once — the live script drops the oldest as a new one lands, past this. */
export const RUN_TRANSCRIPT_CAP = 400;

/** A tail beside a row names only the last handful of lines — enough to say
 * the crew is working, not a second transcript. */
export const LOG_TAIL_CAP = 6;

/** The last `cap` lines of a log, and how many were left out. */
export function logWindow(
  lines: readonly string[],
  cap: number,
): { shown: readonly string[]; hidden: number } {
  const shown = lines.slice(-cap);
  return { shown, hidden: lines.length - shown.length };
}

/**
 * A bounded window of a run's log: the truncation notice when lines were
 * left out, the lines themselves in the page's own voice (`logLine`), the
 * pulse for a run still going, and any control the caller wants inside the
 * same box (the run page's "newer below" button, say) — the live script
 * appends before that control, whichever one is there.
 */
export function logBox(opts: {
  id: string;
  who: string;
  cap: number;
  lines: readonly string[];
  stream?: string;
  pulse?: boolean;
  className?: string;
  extra?: Html;
}): Html {
  const { shown, hidden } = logWindow(opts.lines, opts.cap);
  return html`<div
    class="run-log${opts.className ? ` ${opts.className}` : ""}"
    id="${opts.id}"
    data-who="${opts.who}"
    data-cap="${opts.cap}"
    ${opts.stream ? html`data-stream="${opts.stream}"` : null}
  >
    ${when(
      hidden > 0,
      () =>
        html`<p class="muted small">
          Holding the last ${opts.cap} lines here; the run's own log keeps
          the rest.
        </p>`,
    )}
    ${shown.map((l) => logLine(l, opts.who))}
    ${when(
      opts.pulse === true,
      () =>
        html`<div class="ln ln-pulse" id="${opts.id}-pulse">
          <span class="who">${opts.who}</span
          ><span class="txt"><i></i><i></i><i></i></span>
        </div>`,
    )}
    ${opts.extra ?? null}
  </div>`;
}
