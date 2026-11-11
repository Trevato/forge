/**
 * The duty runner (#11204): on the clock, each duty whose interval has passed since it last
 * started runs once, never twice at the same time, and leaves a `maintenance_run` row. A
 * finding without a probe is refused: the run's outcome says so and no finding is kept.
 */

import type { App } from "../app.ts";
import { during } from "../perf/jobs.ts";
import { clip, refusal, validName, type Duty } from "./duty.ts";
import { duties as registered } from "./registry.ts";
import { lastStarted, prune, record } from "./runs.ts";

export const TICK_MS = 60_000;
const FIRST_MS = 15_000;
/** A duty that has not answered in this long is recorded as timed out and the next duty runs. */
export const DUTY_TIMEOUT_MS = 30_000;
/** Rows kept per duty; older ones are deleted after each run. */
export const KEEP_PER_DUTY = 200;

export interface Maintain {
  /** One pass: every due duty runs; resolves when they have. */
  tick(now?: Date): Promise<void>;
  stop(): void;
}

export function startMaintain(app: App, options: { duties?: readonly Duty[]; everyMs?: number; timeoutMs?: number; keep?: number } = {}): Maintain {
  const list = options.duties ?? registered;
  const seen = new Set<string>();
  for (const d of list) {
    if (!validName(d.name)) throw new Error(`maintenance duty name "${d.name}" is not lowercase words and dashes`);
    if (seen.has(d.name)) throw new Error(`maintenance duty "${d.name}" is registered twice`);
    seen.add(d.name);
  }
  const timeoutMs = options.timeoutMs ?? DUTY_TIMEOUT_MS;
  const running = new Set<string>();

  async function runOne(duty: Duty, now: Date): Promise<void> {
    if (running.has(duty.name)) return;
    running.add(duty.name);
    const started = now;
    let findings: Awaited<ReturnType<Duty["run"]>>["findings"] = [];
    let actions: readonly string[] = [];
    let outcome = "ok";
    try {
      // The duty keeps its `running` slot until it really settles, so a timed-out duty never overlaps itself.
      const work = Promise.resolve().then(() => duty.run({ db: app.db, bus: app.bus, now, app }));
      work.then(() => running.delete(duty.name), () => running.delete(duty.name));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
      });
      const result = await Promise.race([work, deadline]).finally(() => clearTimeout(timer));
      const refused = refusal(result.findings);
      if (refused !== undefined) outcome = refused;
      else {
        findings = result.findings;
        actions = result.actions.map(clip);
      }
    } catch (error) {
      outcome = clip(`failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      record(app.db, { duty: duty.name, started, finished: new Date(), findings, actions, outcome });
      prune(app.db, duty.name, options.keep ?? KEEP_PER_DUTY);
    } catch (error) {
      app.log.error("maintenance run not recorded", { duty: duty.name, error: String(error) });
    }
  }

  async function tick(now = new Date()): Promise<void> {
    for (const duty of list) {
      const last = lastStarted(app.db, duty.name);
      if (last !== undefined && now.getTime() - last < duty.intervalMs) continue;
      if (running.has(duty.name)) continue;
      await runOne(duty, now);
      // Duties take turns: the loop turns between one and the next.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  const first = setTimeout(() => void during("maintain", () => tick()), FIRST_MS);
  const every = setInterval(() => void during("maintain", () => tick()), options.everyMs ?? TICK_MS);
  first.unref?.();
  every.unref?.();
  return {
    tick,
    stop() {
      clearTimeout(first);
      clearInterval(every);
    },
  };
}
