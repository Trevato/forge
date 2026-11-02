/**
 * Nothing the forge does at or after boot holds the main thread over 500 ms on a
 * database the size of production (#8848). The first tick after a boot runs every
 * sweep whose "last time" lives in memory; one of them, the review-repeat sweep,
 * grouped a week of findings against every group so far and held the thread 46 s
 * on 0.7.339. Each pass here runs beside a 5 ms timer, and the longest gap between
 * its wakes is the block.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { App } from "../src/app.ts";
import { autonomyTick } from "../src/crew/autonomy.ts";
import { sweepRepeats } from "../src/crew/repeat_checks.ts";
import { group, wordsOf, type Finding } from "../src/flow/repeats.ts";
import { getRepoById } from "../src/core/repos.ts";
import { bigForge, PRODUCTION } from "./helpers/big-forge.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

/** What no pass may hold the thread for, ms. */
const LIMIT_MS = 500;

let app: App;
let dir = "";
beforeAll(() => {
  const forge = bigForge(PRODUCTION);
  app = forge.app;
  dir = forge.dir;
}, 120_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The longest the loop went without waking while `work` ran, ms. */
async function worstBlock(work: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 5);
    last = now;
  }, 5);
  try {
    await work();
    // The wake the work's last slice kept from running.
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    clearInterval(timer);
  }
  return worst;
}

test("the review-repeat sweep over a week of findings never holds the thread", async () => {
  const repo = getRepoById(app.db, "r")!;
  const blocks: number[] = [];
  for (let i = 0; i < 3; i++) blocks.push(await worstBlock(() => sweepRepeats(app, repo, new Date())));
  expect(Math.min(...blocks)).toBeLessThan(LIMIT_MS);
}, 120_000);

test("the first autonomy tick after a boot never holds the thread", async () => {
  // A loaded machine only adds to a block, never takes from it: the least of
  // three runs is the pass's own length, so the bound does not flake (#8848).
  const blocks: number[] = [];
  for (let i = 0; i < 3; i++) blocks.push(await worstBlock(() => autonomyTick(app, new Date())));
  expect(Math.min(...blocks)).toBeLessThan(LIMIT_MS);
}, 180_000);

test("grouping through the word index is grouping against every group", () => {
  // The quadratic grouping it replaced, kept here as the definition.
  const jaccard = (a: readonly string[], b: readonly string[]): boolean => {
    const inter = a.filter((w) => b.includes(w)).length;
    return inter / (a.length + b.length - inter) >= 0.5;
  };
  let seed = 99;
  const rnd = (m: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % m;
  const vocab = Array.from({ length: 40 }, (_, i) => `word${"abcdefghij"[i % 10]}${"klmnopqrst"[Math.floor(i / 10)]}x`);
  const findings: Finding[] = Array.from({ length: 600 }, (_, i) => ({
    repo: "r",
    pull: i,
    author: "a",
    authorId: "a",
    text: Array.from({ length: 3 + rnd(8) }, () => vocab[rnd(vocab.length)]).join(" "),
  }));
  const groups: { words: string[]; n: number }[] = [];
  for (const f of findings) {
    const words = wordsOf(f.text);
    if (words.length < 3) continue;
    const hit = groups.find((g) => jaccard(g.words, words));
    if (hit) hit.n++;
    else groups.push({ words, n: 1 });
  }
  const got = group(findings);
  expect(got.map((g) => g.key).sort()).toEqual(groups.map((g) => g.words.join(" ")).sort());
  expect(got.map((g) => g.findings.length).sort()).toEqual(groups.map((g) => g.n).sort());
});
