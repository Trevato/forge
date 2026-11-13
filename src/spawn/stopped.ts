/**
 * A child forge its host stopped for going over a limit (#11975): what
 * happened, kept in memory per parent, so the forge starts again after a
 * backoff and its pages say so instead of "the forge is full".
 */
import type { App } from "../app.ts";

export type Stop = { name: string; at: number; why: string; stops: number };

/**
 * Starts a stopped forge again; true when it is awake or a retry is armed, false when the
 * start was skipped.
 */
export type Restart = (parent: App, name: string) => Promise<boolean>;

/** First wait before the restart, ms; it doubles per stop in the hour, to the ceiling. */
export const RESTART_BASE_MS = 5_000;
export const RESTART_MAX_MS = 5 * 60_000;
export const HOUR_MS = 3_600_000;

/** Everything kept for one parent. */
type State = {
  restart: Restart | undefined;
  stops: Map<string, Stop>;
  times: Map<string, number[]>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
};
const states = new WeakMap<App, State>();

function stateOf(parent: App): State {
  let s = states.get(parent);
  if (!s) states.set(parent, (s = { restart: undefined, stops: new Map(), times: new Map(), timers: new Map() }));
  return s;
}

/** The host says how a stopped forge is started again (this module imports no host). */
export function useRestart(parent: App, restart: Restart): void {
  stateOf(parent).restart = restart;
}

/** The wait before the restart after the `n`th stop within the hour. */
export const backoffMs = (n: number): number => Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** Math.max(0, n - 1));

/** Record a stop and arm the restart. */
export function noteStop(parent: App, bodyId: string, name: string, why: string, now = Date.now(), waitMs?: number): Stop {
  const s = stateOf(parent);
  const recent = (s.times.get(bodyId) ?? []).filter((x) => now - x < HOUR_MS);
  recent.push(now);
  s.times.set(bodyId, recent);
  const stop: Stop = { name, at: now, why, stops: recent.length };
  s.stops.set(bodyId, stop);
  const was = s.timers.get(bodyId);
  if (was !== undefined) clearTimeout(was);
  const timer = setTimeout(() => {
    s.timers.delete(bodyId);
    const restart = s.restart;
    if (restart === undefined) return clearStop(parent, bodyId);
    restart(parent, name).then(
      (coming) => coming || clearStop(parent, bodyId),
      () => clearStop(parent, bodyId),
    );
  }, waitMs ?? backoffMs(stop.stops));
  timer.unref?.();
  s.timers.set(bodyId, timer);
  return stop;
}

/** The stop to explain a refusal with; one older than an hour is forgotten, not shown. */
export function lastStop(parent: App, bodyId: string, now = Date.now()): Stop | undefined {
  const s = states.get(parent);
  const stop = s?.stops.get(bodyId);
  if (stop === undefined) return undefined;
  if (now - stop.at >= HOUR_MS) {
    s!.stops.delete(bodyId);
    return undefined;
  }
  return stop;
}

/**
 * The forge is running again, or will not be started: forget the stop (the count in the
 * hour stays).
 */
export function clearStop(parent: App, bodyId: string): void {
  states.get(parent)?.stops.delete(bodyId);
}

const hhmm = (at: number): string => new Date(at).toISOString().slice(11, 16);

/** One sentence for a stopped forge's pages; the sentence for a full host is a different one. */
export function stopSentence(stop: Stop): string {
  const what = /memory/.test(stop.why) ? "ran out of memory" : "went over a limit";
  const again = stop.stops > 1 ? ` It has been stopped ${stop.stops} times in the last hour; a larger plan would fit it.` : "";
  return `This forge ${what} and was stopped at ${hhmm(stop.at)} UTC; the host starts it again by itself.${again}`;
}

/** Drop everything kept for a parent and cancel its pending restarts. */
export function cancelRestarts(parent: App): void {
  for (const t of states.get(parent)?.timers.values() ?? []) clearTimeout(t);
  states.delete(parent);
}
