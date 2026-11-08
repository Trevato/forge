/**
 * `grepRepos` answers at the code budget (#7118): the first batch is always
 * waited for, a later batch races the time left, and an abandoned grep keeps
 * its slot until git exits. Every grep and the budget's timer are deferred
 * promises the test settles by hand — no PATH shim, no sleep, no margin.
 */
import { expect, test } from "bun:test";
import { createGrepSlots } from "../src/search/grep_slots.ts";
import { BUDGETED_GREP_MS, grepRepos, type BudgetTimer } from "../src/core/search.ts";
import type { Repo } from "../src/core/repos.ts";

type Raw = { path: string; line: number; text: string }[] | null;

const repo = (i: number) =>
  ({ id: `r${i}`, ownerName: "u", name: `r${i}`, defaultBranch: "main", archivedAt: null }) as Repo;

/** A grep per repo dir, each held until the test answers it. */
function deferredGreps() {
  const pending = new Map<string, (v: Raw) => void>();
  const waiters: (() => void)[] = [];
  const grep = (dir: string) =>
    new Promise<Raw>((done) => {
      pending.set(dir.replace(/^.*\/(r\d+)\.git$/, "$1"), done);
      for (const w of waiters.splice(0)) w();
    });
  /** Resolves once `name`'s grep has started. */
  const started = async (name: string) => {
    while (!pending.has(name)) await new Promise<void>((r) => waiters.push(r));
  };
  const answer = (name: string, hits: Raw = [{ path: "a.txt", line: 1, text: name }]) => {
    pending.get(name)!(hits);
    pending.delete(name);
  };
  return { grep: grep as never, started, answer, running: () => [...pending.keys()] };
}

/** A budget timer the test fires; records whether one was ever asked for. */
function handTimer() {
  let fire!: () => void;
  let asked = 0;
  let cleared = 0;
  let ms = -1;
  const timer = (wait: number): BudgetTimer => {
    asked++;
    ms = wait;
    const done = new Promise<void>((r) => (fire = r));
    return { done, clear: () => void cleared++ };
  };
  return { timer, fire: () => fire(), asked: () => asked, cleared: () => cleared, ms: () => ms };
}

test("a spent budget still waits for batch 0 and keeps its hits", async () => {
  const g = deferredGreps();
  const slots = createGrepSlots();
  let t = 0;
  const search = grepRepos("/nowhere", [0, 1, 2, 3, 4, 5].map(repo), "q", 200, 10, {
    slots,
    grep: g.grep,
    now: () => t,
  });
  for (const n of ["r0", "r1", "r2", "r3"]) await g.started(n);
  // The whole budget passes while batch 0 is still in git.
  t = 1_000;
  for (const n of ["r0", "r1", "r2", "r3"]) g.answer(n);
  const out = await search;
  expect(out.hits.map((h) => h.repo.name)).toEqual(["r0", "r1", "r2", "r3"]);
  expect(out.more).toBe(true);
  // Batch 1 never started: the budget was gone before it.
  expect(g.running()).toEqual([]);
  expect(slots.held().total).toBe(0);
});

test("a never-settling later batch does not hold the answer, and keeps its slots", async () => {
  const g = deferredGreps();
  const slots = createGrepSlots();
  const clock = handTimer();
  const search = grepRepos("/nowhere", [0, 1, 2, 3, 4, 5].map(repo), "q", 200, 10, {
    slots,
    grep: g.grep,
    now: () => 0,
    timer: clock.timer,
  });
  for (const n of ["r0", "r1", "r2", "r3"]) await g.started(n);
  for (const n of ["r0", "r1", "r2", "r3"]) g.answer(n);
  await g.started("r4");
  await g.started("r5");
  // Batch 1 hangs; the budget runs out.
  clock.fire();
  const out = await search;
  expect(out.more).toBe(true);
  expect(out.hits.map((h) => h.repo.name)).toEqual(["r0", "r1", "r2", "r3"]);
  expect(clock.cleared()).toBe(1);
  // The abandoned greps still hold their slots until git exits.
  expect(slots.held()).toEqual({ total: 2, strangers: 2 });
  g.answer("r4");
  g.answer("r5");
  // The slot frees in the grep's own `finally`, a few microtasks on.
  for (let k = 0; k < 10 && slots.held().total > 0; k++) await Promise.resolve();
  expect(slots.held()).toEqual({ total: 0, strangers: 0 });
});

test("a later batch that answers inside the budget is kept, and the timer cleared", async () => {
  const g = deferredGreps();
  const clock = handTimer();
  const search = grepRepos("/nowhere", [0, 1, 2, 3, 4].map(repo), "q", 200, 10, {
    slots: createGrepSlots(),
    grep: g.grep,
    now: () => 0,
    timer: clock.timer,
  });
  for (const n of ["r0", "r1", "r2", "r3"]) await g.started(n);
  for (const n of ["r0", "r1", "r2", "r3"]) g.answer(n);
  await g.started("r4");
  g.answer("r4");
  const out = await search;
  expect(out.more).toBe(false);
  expect(out.hits.map((h) => h.repo.name)).toEqual(["r0", "r1", "r2", "r3", "r4"]);
  expect(clock.asked()).toBe(1);
  expect(clock.cleared()).toBe(1);
});

test("one caller's abandoned greps do not stop another caller's search", async () => {
  const slots = createGrepSlots();
  const a = deferredGreps();
  const clock = handTimer();
  // Member a's search abandons its second pair of greps at the budget.
  const first = grepRepos("/nowhere", [0, 1, 2, 3, 4, 5].map(repo), "q", 200, 10, {
    memberId: "a",
    slots,
    grep: a.grep,
    now: () => 0,
    timer: clock.timer,
  });
  for (const pair of [["r0", "r1"], ["r2", "r3"]]) {
    for (const n of pair) await a.started(n);
    for (const n of pair) a.answer(n);
  }
  await a.started("r4");
  await a.started("r5");
  clock.fire();
  expect((await first).more).toBe(true);
  expect(slots.held().total).toBe(2);

  // Member b, and a stranger, search the whole lot while a's greps hang.
  for (const memberId of ["b", undefined]) {
    const b = deferredGreps();
    const second = grepRepos("/nowhere", [0, 1, 2, 3, 4, 5].map(repo), "q", 200, 10, {
      memberId,
      slots,
      grep: b.grep,
      now: () => 0,
      timer: handTimer().timer,
    });
    const width = memberId === undefined ? 4 : 2;
    const names = ["r0", "r1", "r2", "r3", "r4", "r5"];
    for (let k = 0; k < names.length; k += width) {
      const group = names.slice(k, k + width);
      for (const n of group) await b.started(n);
      for (const n of group) b.answer(n);
    }
    const out = await second;
    expect(out.skipped).toBe(false);
    expect(out.more).toBe(false);
    expect(out.hits.length).toBe(6);
  }

  a.answer("r4");
  a.answer("r5");
});

test("a search with no budget never asks for a timer and waits for every batch", async () => {
  const g = deferredGreps();
  const clock = handTimer();
  let t = 0;
  const search = grepRepos("/nowhere", [0, 1, 2, 3, 4].map(repo), "q", 200, Infinity, {
    slots: createGrepSlots(),
    grep: g.grep,
    now: () => t,
    timer: clock.timer,
  });
  for (const n of ["r0", "r1", "r2", "r3"]) await g.started(n);
  t = 1e9;
  for (const n of ["r0", "r1", "r2", "r3"]) g.answer(n);
  await g.started("r4");
  g.answer("r4");
  const out = await search;
  expect(out.more).toBe(false);
  expect(out.hits.length).toBe(5);
  expect(clock.asked()).toBe(0);
});

test("batch 0 stuck behind git's gate is cut at BUDGETED_GREP_MS: what answered is kept, the rest is more (#9402)", async () => {
  const g = deferredGreps();
  const slots = createGrepSlots();
  const first = handTimer();
  const later = handTimer();
  const search = grepRepos("/nowhere", [0, 1, 2, 3, 4, 5].map(repo), "q", 200, 30, {
    slots,
    grep: g.grep,
    now: () => 0,
    timer: later.timer,
    firstTimer: first.timer,
  });
  for (const n of ["r0", "r1", "r2", "r3"]) await g.started(n);
  g.answer("r0");
  g.answer("r1");
  // Their answers reach the batch in microtasks; a real timer fires after them.
  await new Promise<void>((r) => setTimeout(r, 0));
  // r2 and r3 are still waiting on git; the ceiling passes.
  first.fire();
  const out = await search;
  expect(first.ms()).toBe(BUDGETED_GREP_MS);
  expect(first.cleared()).toBe(1);
  expect(out.more).toBe(true);
  expect(out.hits.map((h) => h.repo.name)).toEqual(["r0", "r1"]);
  // No later batch started, and its budget timer was never asked for.
  expect(later.asked()).toBe(0);
  expect(g.running().sort()).toEqual(["r2", "r3"]);
  // The abandoned greps keep their slots until git exits.
  expect(slots.held()).toEqual({ total: 2, strangers: 2 });
  g.answer("r2");
  g.answer("r3");
  for (let k = 0; k < 10 && slots.held().total > 0; k++) await Promise.resolve();
  expect(slots.held()).toEqual({ total: 0, strangers: 0 });
});

test("a search with no budget never takes the first batch's ceiling", async () => {
  const g = deferredGreps();
  const first = handTimer();
  const search = grepRepos("/nowhere", [0, 1].map(repo), "q", 200, Infinity, {
    slots: createGrepSlots(),
    grep: g.grep,
    firstTimer: first.timer,
  });
  for (const n of ["r0", "r1"]) await g.started(n);
  for (const n of ["r0", "r1"]) g.answer(n);
  expect((await search).hits.length).toBe(2);
  expect(first.asked()).toBe(0);
});
