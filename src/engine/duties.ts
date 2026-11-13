/**
 * The engine's duties: what runs on a timer and reads and writes only the
 * database, the outbox and the network. One list, started by whoever runs the
 * engine: `main.ts` on its one thread (`inline`), or the engine's Worker
 * (`worker.ts`). Never both: a duty here may write, and two of it would act twice.
 *
 * What is not here is not here because it holds something the pages read from
 * this thread's memory (the apps runtime, the merge queue, the crew's running
 * runs, the run-log taps, the snapshot service's last pass) or reads what
 * only the serving thread fills (`docs/ARCHITECTURE.md`, "Two threads").
 */

import type { App } from "../app.ts";
import { runModelReview } from "../actions/model_review.ts";
import { expireCrewHolds } from "../actions/holds.ts";
import { settleDue } from "../actions/estimates_settle.ts";
import { sweepStarts } from "../actions/start_sweep.ts";
import { retain } from "../boards/sampler.ts";
import { FINE_MS } from "../boards/ring.ts";
import { runDelivery } from "../core/webhooks.ts";
import { pruneSessions } from "../core/sessions.ts";
import { pruneTokens } from "../core/tokens.ts";
import { getRepoById } from "../core/repos.ts";
import { plannedRepoIds, tickWeeks } from "../flow/retro.ts";
import { during } from "../perf/jobs.ts";

const HOUR_MS = 3_600_000;

/**
 * Start every duty; the returned function stops them all. `retention` is on
 * where the sampler's tick does not retire what has left its window itself.
 */
export function startDuties(app: App, options: { retention: boolean }): () => void {
  const timers: ReturnType<typeof setInterval>[] = [];
  // The webhook delivery worker: poll the outbox for due deliveries. The event
  // row is the source of truth, so a missed tick only delays delivery, never
  // loses it. runDelivery never throws into the timer. Expired sessions and
  // run tokens ride the same tick: cheap DELETEs, never worth a worker.
  const delivery = (): void => {
    runDelivery(app.db, app.log, app.bus);
    pruneSessions(app.db);
    pruneTokens(app.db);
  };
  timers.push(setInterval(() => during("delivery", delivery), 5_000));
  // Sweep anything queued while we were down.
  during("delivery", delivery);
  // Estimates of "done" come due as time passes (#11955).
  timers.push(setInterval(() => during("estimates-due", () => void settleDue(app.db)), 300_000));
  // Accounts an agent started and nobody claimed sleep after a week and are
  // archived after a month (`actions/start_sweep.ts`, #10912): hourly, and on boot.
  timers.push(setInterval(() => during("starts", () => void sweepStarts(app)), HOUR_MS));
  during("starts", () => void sweepStarts(app));
  // An agent's hold that has stood 24 h is released each minute (#6918).
  timers.push(
    setInterval(
      () =>
        during("holds", () => {
          try {
            expireCrewHolds(app);
          } catch (error) {
            app.log.warn("hold expiry failed", { error: String(error) });
          }
        }),
      60_000,
    ),
  );
  // The weekly model review (#7815): settles last week's changes, then proposes this week's; it runs once a week whatever the tick.
  timers.push(
    setInterval(
      () =>
        during("model-review", () => {
          try {
            runModelReview(app);
          } catch (error) {
            app.log.warn("model review failed", { error: String(error) });
          }
        }),
      HOUR_MS,
    ),
  );
  // The week is the sprint (#8704): at each weekly reset the forge writes its retrospective, unasked.
  timers.push(
    setInterval(
      () =>
        during("week", () => {
          try {
            const repos = plannedRepoIds(app.db).flatMap((id) => getRepoById(app.db, id) ?? []);
            for (const repo of tickWeeks(app.db, repos, new Date()))
              app.bus.append({ kind: "week.retro", repoId: repo.id, payload: {} });
          } catch (error) {
            app.log.warn("week retrospective failed", { error: String(error) });
          }
        }),
      HOUR_MS,
    ),
  );
  // What has left its window goes, on the sampler's clock (`boards/sampler.ts`).
  if (options.retention) {
    const flight = { draining: false };
    timers.push(setInterval(() => during("retention", () => retain(app, Date.now(), flight)), FINE_MS));
  }
  return () => {
    for (const timer of timers) clearInterval(timer);
  };
}
