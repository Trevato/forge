/**
 * Home paints its frame first (#7660): signed in, on a forge with thousands
 * of issues, a write between two looks leaves the next look answered from
 * memory, within the budget, with the stale regions marked for the page to
 * swap, and each late region has a fragment of its own.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";
import { forgetHome } from "../src/web/studio/home_last.ts";

/** The server's own time for `/` after a write, median of a sample, in ms: what the request did before sending a byte. */
const APP_BUDGET_MS = 50;
/** Looks in a sample, and how many samples may be taken: a sample starved by the machine is taken once more, a slow code is slow in both. */
const LOOKS = 20;
const SAMPLES = 2;
/** The first response, uncompressed, on a forge this size. */
const FIRST_BYTES = 100_000;

let f: SnappyFixture;
beforeAll(async () => {
  f = await snappyFixture({ repos: 12, issuesPerRepo: 250 });
}, 240_000);
afterAll(async () => {
  await f.close();
});

const look = async (cookie: string, path = "/feed") => {
  const res = await fetch(`${f.base}${path}`, { headers: { cookie } });
  const text = await res.text();
  const app = /app;dur=([\d.]+)/.exec(res.headers.get("server-timing") ?? "");
  return { res, text, ms: app === null ? NaN : Number(app[1]) };
};
const write = (n: number) =>
  f.app.db.query("UPDATE repo SET description = ?1 WHERE id = ?2").run(`moved ${n}`, f.repos[0]!.id);

test("the data is realistic: thousands of issues", () => {
  const n = f.app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM issue").get()!.n;
  expect(n).toBeGreaterThanOrEqual(3000);
});

test("after a write, signed-in home is answered from memory within the budget and says what to swap", async () => {
  forgetHome(f.app.db);
  const cold = await look(f.ownerCookie);
  expect(cold.res.status).toBe(200);
  expect(cold.text).not.toContain(`data-refresh="/`);
  let marked: string;
  // The first look after a write schedules the one-off redraw of the five regions, which runs on this process's loop for the looks that follow; let it finish, so the sample measures the steady cost of a look.
  write(-1);
  marked = (await look(f.ownerCookie)).text;
  await Bun.sleep(1_000);
  let median = Infinity;
  for (let sample = 0; sample < SAMPLES && !(median < APP_BUDGET_MS); sample++) {
    const times: number[] = [];
    for (let i = 0; i < LOOKS; i++) {
      write(sample * LOOKS + i);
      const got = await look(f.ownerCookie);
      expect(got.res.status).toBe(200);
      times.push(got.ms);
      // Answered from memory on every look, not only the first: this is the verdict that depends on the code alone.
      expect(got.text).toContain('data-refresh="/live/home/feed"');
      await Bun.sleep(1);
    }
    // Every look measured a time; a missing one is a broken header, not a fast look.
    expect(times.every((t) => Number.isFinite(t))).toBe(true);
    times.sort((a, b) => a - b);
    median = times[Math.floor(times.length / 2)]!;
  }
  expect(median).toBeLessThan(APP_BUDGET_MS);
  for (const name of ["waiting", "panels", "asked", "feed"]) {
    expect(marked).toContain(`id="home-${name}"`);
  }
  expect(marked).toContain('data-refresh="/live/home/feed"');
  // The figures are on home itself, the feed's page holds the rest.
  await look(f.ownerCookie, "/");
  write(99);
  expect((await look(f.ownerCookie, "/")).text).toContain('data-refresh="/live/home/kpis"');
});

test("the first response stays under its byte limit", async () => {
  const got = await look(f.ownerCookie);
  expect(new TextEncoder().encode(got.text).length).toBeLessThan(FIRST_BYTES);
});

test("each late region answers alone, to its own viewer, and to no one else", async () => {
  for (const name of ["kpis", "waiting", "panels", "asked", "feed"]) {
    const res = await fetch(`${f.base}/live/home/${name}`, { headers: { cookie: f.ownerCookie } });
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBeGreaterThan(0);
  }
  for (const name of ["kpis", "panels"]) {
    const peer = await fetch(`${f.base}/live/home/${name}`, { headers: { cookie: f.peerCookie } });
    expect(peer.status).toBe(404);
  }
  const peerFeed = await fetch(`${f.base}/live/home/feed`, { headers: { cookie: f.peerCookie } });
  expect(peerFeed.status).toBe(200);
  const anon = await fetch(`${f.base}/live/home/feed`);
  expect(anon.status).toBe(404);
});

test("one viewer's remembered regions never reach another", async () => {
  await look(f.ownerCookie);
  await look(f.ownerCookie, "/");
  write(99);
  const peer = await look(f.peerCookie);
  const owners = await look(f.ownerCookie);
  expect(owners.text).toContain("olive/app-1");
  expect(peer.text).not.toContain("home-kpis");
  expect(peer.text).not.toContain("olive/app-1");
});
