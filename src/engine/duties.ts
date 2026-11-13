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
import { runDelivery } from "../core/webhooks.ts";
import { pruneSessions } from "../core/sessions.ts";
import { pruneTokens } from "../core/tokens.ts";
import { getRepoById } from "../core/repos.ts";
import { plannedRepoIds, tickWeeks } from "../flow/retro.ts";
import { during } from "../perf/jobs.ts";
import { sweepAssigned } from "../crew/dispatch.ts";
import { startClogTick } from "../flow/clog_tick.ts";
import { startKeeper } from "../flow/keeper.ts";
import { recordAskLedger } from "../web/studio/asks.ts";
import { noteDbSize } from "../system/db_size.ts";
import { adoptObserved } from "./observed.ts";
import { startRetention } from "../system/retention.ts";

const HOUR_MS = 3_600_000;

/**
 * Start every duty; the returned function stops them all. `onWorker` is on
 * for the engine's own thread: there the engine retires what has left its
 * window but the machine samples (`system/retention.ts`; those stay on the serving thread's
 * connection) and owns the write-ahead log's checkpoints.
 */
export function startDuties(app: App, options: { onWorker: boolean }): () => void {
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
  const stops: (() => void)[] = [];
  if (options.onWorker) {
    // What reads what the serving thread observes (`engine/observed.ts`): the throughput keeper (#7645)
    // each minute, the clog watch (#6524) each minute, and the asks ledger with the database's size.
    const adopt = (): void => void adoptObserved(app.db);
    stops.push(startKeeper(app, () => sweepAssigned(app), 60_000, Date.now, adopt));
    stops.push(startClogTick(app.db, app.bus, (error) => app.log.warn("clog tick failed", { error: String(error) }), 60_000, adopt));
    timers.push(
      setInterval(
        () =>
          during("asks-ledger", () => {
            adopt();
            try {
              recordAskLedger(app.db);
            } catch (error) {
              app.log.error("asks ledger failed", { error: String(error) });
            }
            try {
              noteDbSize(app.db, app.config.dataDir);
            } catch (error) {
              app.log.warn("database size reading failed", { error: String(error) });
            }
          }),
        120_000,
      ),
    );
    // The one checkpointer: the serving thread's commits never pay for it (`main.ts`). A passive one
    // takes what no reader still needs and waits for none; a log nobody reads is reset by the next write.
    timers.push(setInterval(() => during("checkpoint", () => app.db.exec("PRAGMA wal_checkpoint(PASSIVE)")), 2_000));
    // What has left its window goes a bounded slice at a time on a pace (`system/retention.ts`); the machine samples are the serving thread's.
    stops.push(startRetention(app, { samples: false, rest: true }));
  }
  return () => {
    for (const timer of timers) clearInterval(timer);
    for (const stop of stops) stop();
  };
}
