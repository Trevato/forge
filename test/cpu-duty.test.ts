import { expect, test } from "bun:test";
import { dutyStep, dutyTick, demandCores, newDuty, pauseMs, resumeAllPaused, resumeNow } from "../src/apps/cpu_duty.ts";
import { noteCpuHolder, watchTick, watchTree, watchedLimits, type ProcessRow } from "../src/apps/contain.ts";

test("under the limit is never paused", () => {
  expect(pauseMs(0.5, 1)).toBe(0);
  expect(pauseMs(1, 1)).toBe(0);
  expect(pauseMs(Number.NaN, 1)).toBe(0);
});

test("a 3-core load under a 1-core limit is held near 1 core", () => {
  let paused = 0;
  const used: number[] = [];
  for (let second = 0; second < 10; second++) {
    // The tree wants 3 cores while it runs; it runs for what is not paused.
    const cores = 3 * (1 - paused / 1000);
    used.push(cores);
    paused = pauseMs(demandCores(cores, paused), 1);
  }
  for (const c of used.slice(2)) expect(Math.abs(c - 1)).toBeLessThan(0.05);
});

test("it always leaves the tree some time to run", () => {
  expect(pauseMs(10_000, 1)).toBeLessThan(1000);
});

test("a step pauses with SIGSTOP and resumes with SIGCONT, and close resumes a paused tree", () => {
  const sent: string[] = [];
  const duty = newDuty(1);
  const timers: (() => void)[] = [];
  const later = (fn: () => void) => (timers.push(fn), setTimeout(() => {}, 0));
  const ms = dutyStep(duty, 7, 3, (_r, s) => sent.push(s), later);
  expect(ms).toBe(667);
  expect(sent).toEqual(["SIGSTOP"]);
  resumeNow(duty, 7, (_r, s) => sent.push(s));
  expect(sent).toEqual(["SIGSTOP", "SIGCONT"]);
  resumeNow(duty, 7, (_r, s) => sent.push(s));
  expect(sent).toEqual(["SIGSTOP", "SIGCONT"]);
});

/** A fake clock: timers fire only when the test advances time. */
function fakeClock() {
  let now = 0;
  const due: { at: number; fn: () => void }[] = [];
  const later = (fn: () => void, ms: number) => {
    const h = { at: now + ms, fn };
    due.push(h);
    return h as unknown as ReturnType<typeof setTimeout>;
  };
  const advance = (ms: number) => {
    now += ms;
    for (const h of due.filter((d) => d.at <= now)) {
      due.splice(due.indexOf(h), 1);
      h.fn();
    }
  };
  return { later, advance, now: () => now };
}

test("ticks drive pause and resume: a busy tree is stopped, continued, and ends continued", () => {
  const clock = fakeClock();
  const sent: string[] = [];
  const duty = newDuty(0.1);
  const signal = (_r: number, s: string) => sent.push(s);
  const CLK = 100;
  let ticks = 0;
  expect(dutyTick(duty, 1, ticks, clock.now(), CLK, signal, clock.later)).toBeUndefined();
  for (let i = 0; i < 3; i++) {
    clock.advance(1000);
    ticks += 100; // one core while running
    dutyTick(duty, 1, ticks, clock.now(), CLK, signal, clock.later);
    expect(sent.at(-1)).toBe("SIGSTOP");
    clock.advance(duty.paused);
    expect(sent.at(-1)).toBe("SIGCONT");
  }
  expect(sent.filter((s) => s === "SIGSTOP").length).toBe(3);
});

test("the second is the measured interval, not an assumed 1000 ms", () => {
  const duty = newDuty(1);
  const clock = fakeClock();
  // 3 cores for 500 ms: paused for two thirds of 500 ms, not of 1000.
  dutyTick(duty, 1, 0, 0, 100, () => {}, clock.later);
  expect(dutyTick(duty, 1, 150, 500, 100, () => {}, clock.later)).toBe(333);
});

test("a stalled tick never earns a pause longer than two seconds", () => {
  const duty = newDuty(1);
  const clock = fakeClock();
  dutyTick(duty, 1, 0, 0, 100, () => {}, clock.later);
  expect(dutyTick(duty, 1, 3000, 10_000, 100, () => {}, clock.later)!).toBeLessThanOrEqual(2000);
});

test("a clean exit continues every tree still stopped", () => {
  const clock = fakeClock();
  const sent: string[] = [];
  const duty = newDuty(1);
  dutyStep(duty, 9, 3, (_r, s) => sent.push(s), clock.later);
  expect(sent).toEqual(["SIGSTOP"]);
  resumeAllPaused();
  expect(sent).toEqual(["SIGSTOP", "SIGCONT"]);
  resumeAllPaused();
  expect(sent).toEqual(["SIGSTOP", "SIGCONT"]);
});

test("a paused cell is not stopped for CPU; a plain one over its cores still is", () => {
  const limits = { memoryMiB: 512, cpus: 1, diskMiB: 100 };
  expect(watchedLimits(limits, undefined, true).cpus).toBe(Number.POSITIVE_INFINITY);
  expect(watchedLimits(limits, undefined, false).cpus).toBe(1);
  expect(watchedLimits(limits, { cpuCapped: false }).cpus).toBe(1);
});

test("the cpu holder is said once, and again only when it changes", () => {
  const lines: string[] = [];
  const say = (l: string) => lines.push(l);
  noteCpuHolder(false, say, true);
  noteCpuHolder(false, say);
  noteCpuHolder(false, say);
  expect(lines).toEqual(["cpu: a child forge's cores are held by the forge, by pausing"]);
  noteCpuHolder(true, say);
  noteCpuHolder(true, say);
  expect(lines.length).toBe(2);
  expect(lines[1]).toContain("the kernel");
});

/** A pid no kernel hands out (over `pid_max`), so only the test's table holds it. */
const FAKE_ROOT = 9_999_999;

/** A table with one process, the root, at `ticks` CPU ticks. */
function table(ticks: number): { rows: Map<number, ProcessRow>; children: Map<number, number[]> } {
  return { rows: new Map([[FAKE_ROOT, { ppid: 1, ticks }]]), children: new Map() };
}

/**
 * Drive `watchTree` through `watchTick` for `minutes` of a tree that runs 3
 * cores flat out (the recording signaller never really stops it), stepping
 * a stepped clock. Returns the signals sent and the breaches.
 */
function busyWatch(paused: boolean) {
  const clock = fakeClock();
  const sent: string[] = [];
  const breaches: string[] = [];
  const base = { memoryMiB: 512, cpus: 1, diskMiB: 100 };
  const limits = watchedLimits(base, undefined, paused);
  const cap = { bytes: 512 * 1024 * 1024, by: "watch" as const };
  const unwatch = watchTree(
    FAKE_ROOT,
    limits,
    cap,
    [],
    undefined,
    (why) => breaches.push(why),
    paused ? { cores: 1, signal: (_r, s) => sent.push(s), later: clock.later } : undefined,
  );
  const start = Date.now();
  let at = start;
  let ticks = 0;
  watchTick(at, table(ticks));
  // A short first step, so the resume timer itself is seen to fire.
  at += 200;
  ticks += 3 * 20;
  watchTick(at, table(ticks));
  if (paused) {
    expect(sent).toEqual(["SIGSTOP"]);
    clock.advance(250);
    expect(sent).toEqual(["SIGSTOP", "SIGCONT"]);
  }
  // Past the grace and the hold (`apps/cpu_rule.ts`): 16 minutes at 3 cores.
  while (at - start < 16 * 60_000 && breaches.length === 0) {
    at += 2_000;
    ticks += 3 * 200;
    watchTick(at, table(ticks));
  }
  const beforeClose = [...sent];
  unwatch();
  return { sent, beforeClose, breaches };
}

test("watchTree with pause: ticks stop and continue the tree, never stop it for CPU, and close continues it", () => {
  const { sent, beforeClose, breaches } = busyWatch(true);
  expect(breaches).toEqual([]);
  const stops = sent.filter((s) => s === "SIGSTOP").length;
  expect(stops).toBeGreaterThan(400);
  // Every stop is followed by its continue; the last one is sent by the close.
  expect(sent.filter((s) => s === "SIGCONT").length).toBe(stops);
  expect(beforeClose.at(-1)).toBe("SIGSTOP");
  expect(sent.at(-1)).toBe("SIGCONT");
  for (let i = 0; i < sent.length; i++) expect(sent[i]).toBe(i % 2 === 0 ? "SIGSTOP" : "SIGCONT");
});

test("watchTree without pause: the same load is stopped for CPU and never signalled", () => {
  const { sent, breaches } = busyWatch(false);
  expect(sent).toEqual([]);
  expect(breaches.length).toBe(1);
  expect(breaches[0]).toContain("core");
});
