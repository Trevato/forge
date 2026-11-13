/**
 * Holding a cell's cores without the kernel: pause its process tree for part
 * of each second. Plain data in (the cores the tree used over the last
 * second, the limit), plain data out (how long to pause it this second). The
 * watch in `contain.ts` sends the signals (SIGSTOP, then SIGCONT, never a
 * kill) where a cell asked for `cpuQuota` and `cpu.max` was not ours to write.
 */

import { during } from "../perf/jobs.ts";

export const DUTY_SECOND_MS = 1_000;

/**
 * Milliseconds to pause the tree this second. `cores` is what it would use
 * running the whole second (its demand): a tree that wants 3 cores under a
 * limit of 1 runs a third of the time, and so is paused for two thirds.
 * Never the whole second: the tree always runs a little, so it can be read.
 */
export function pauseMs(cores: number, limit: number, second = DUTY_SECOND_MS): number {
  if (!Number.isFinite(cores) || !Number.isFinite(limit) || limit <= 0 || cores <= limit) return 0;
  const run = Math.max(MIN_RUN_FRACTION, limit / cores);
  return Math.round(second * (1 - run));
}

const MIN_RUN_FRACTION = 0.02;

/** A stalled tick never earns a pause longer than this. */
const MAX_PAUSE_SPAN_MS = 2_000;

/**
 * The tree's demand from what it used: cores measured over a second in which
 * it was paused for `pausedMs` ran only for the rest, so its demand is the
 * reading over that running share.
 */
export function demandCores(usedCores: number, pausedMs: number, second = DUTY_SECOND_MS): number {
  const running = Math.max(MIN_RUN_FRACTION, 1 - pausedMs / second);
  return Math.max(0, usedCores) / running;
}

/** How a resume is scheduled: `fn` after `ms`. */
export type DutyLater = (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;

/** What the watch sends: to the cell's tree, a signal. */
export type Signaller = (root: number, signal: "SIGSTOP" | "SIGCONT") => void;

/**
 * One cell's pause state: its limit, how long it was paused last interval
 * (of `span` ms), and the resume that is owed.
 */
export interface Duty {
  readonly limit: number;
  paused: number;
  span: number;
  resume: ReturnType<typeof setTimeout> | undefined;
  /** The tree's CPU ticks and the time (ms) at the last reading. */
  last: { ticks: number; at: number } | undefined;
}

export function newDuty(limit: number): Duty {
  return { limit, paused: 0, span: DUTY_SECOND_MS, resume: undefined, last: undefined };
}

/** Every tree stopped right now, so a clean exit of the forge can continue them. */
const stopped = new Map<Duty, { root: number; signal: Signaller }>();
let exitHooked = false;

/**
 * Continue every tree this process stopped. Runs on exit; a killed forge is
 * covered by the cell's `--die-with-parent`.
 */
export function resumeAllPaused(): void {
  for (const [duty, { root, signal }] of [...stopped]) resumeNow(duty, root, signal);
}

/**
 * One step: from the cores used over the last `span` ms (the measured
 * interval, not an assumed second), pause the tree now and resume it after
 * `pauseMs`. Returns the pause chosen.
 */
export function dutyStep(
  duty: Duty,
  root: number,
  usedCores: number,
  signal: Signaller,
  later: DutyLater = (fn, ms) =>
    setTimeout(() => during("cell-duty-resume", fn), ms),
  span = DUTY_SECOND_MS,
): number {
  resumeNow(duty, root, signal);
  const ms = pauseMs(demandCores(usedCores, duty.paused, duty.span), duty.limit, span);
  duty.paused = ms;
  duty.span = span;
  if (ms > 0) {
    signal(root, "SIGSTOP");
    stopped.set(duty, { root, signal });
    if (!exitHooked) {
      exitHooked = true;
      process.once("exit", resumeAllPaused);
    }
    duty.resume = later(() => {
      duty.resume = undefined;
      stopped.delete(duty);
      signal(root, "SIGCONT");
    }, ms);
    (duty.resume as { unref?: () => void }).unref?.();
  }
  return ms;
}

/**
 * A watch tick: the tree's CPU `ticks` (of `clkTck` a second) at `now` ms.
 * The first reading only sets the baseline; each later one steps the duty
 * over the interval between them. Returns the pause chosen, or undefined.
 */
export function dutyTick(
  duty: Duty,
  root: number,
  ticks: number,
  now: number,
  clkTck: number,
  signal: Signaller,
  later?: DutyLater,
): number | undefined {
  const before = duty.last;
  duty.last = { ticks, at: now };
  if (before === undefined || now <= before.at) return undefined;
  const span = now - before.at;
  const used = (ticks - before.ticks) / clkTck / (span / 1000);
  return dutyStep(duty, root, used, signal, later, Math.min(span, MAX_PAUSE_SPAN_MS));
}

/** Resume the tree if it is paused: the close of a cell, and the start of every step. */
export function resumeNow(duty: Duty, root: number, signal: Signaller): void {
  if (duty.resume === undefined) return;
  clearTimeout(duty.resume);
  duty.resume = undefined;
  stopped.delete(duty);
  signal(root, "SIGCONT");
}
