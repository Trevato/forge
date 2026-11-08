// Proving a release live (#7557): ten minutes of /healthz once a second under page load; three bad in a row fail it.
import { describe, expect, test } from "bun:test";
import { tick, rollProbe } from "../src/keeper/keeper.ts";
import { listKeeperReleases } from "../src/keeper/record.ts";
import { EMPTY, FAIL_AFTER, SLOW_MS, tally, verifyUnderLoad, type Probe } from "../src/keeper/verify.ts";
import { keeperForge } from "./helpers/keeper.ts";

/** A clock that only the probes and the sleeps move. */
function clocked(healthz: (n: number) => Probe, pages: readonly string[] = [], page: Probe = { status: 200, ms: 0 }) {
  let now = 0;
  let n = 0;
  let open = 0;
  let mostOpen = 0;
  const run = verifyUnderLoad({
    get: async (path) => {
      if (path === "/healthz") {
        const p = healthz(n++);
        now += p.ms;
        return p;
      }
      open++;
      mostOpen = Math.max(mostOpen, open);
      await Promise.resolve();
      now += page.ms;
      open--;
      return page;
    },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    pages,
  });
  return { run, mostOpen: () => mostOpen };
}

describe("tally", () => {
  test("a bad probe is a non-200 or one over 10 s; a slow 200 is slow, not dark", () => {
    let t = tally(EMPTY, { status: 200, ms: SLOW_MS + 1 });
    expect(t).toMatchObject({ probes: 1, non200: 0, badInRow: 1, worstMs: 10_001, secondsDark: 0 });
    t = tally(t, { status: 502, ms: 3 });
    expect(t).toMatchObject({ probes: 2, non200: 1, badInRow: 2, secondsDark: 1 });
    t = tally(t, { status: 200, ms: 5 });
    expect(t).toMatchObject({ badInRow: 0, worstRun: 2 });
    // Exactly 10 s is not over it.
    expect(tally(EMPTY, { status: 200, ms: SLOW_MS }).badInRow).toBe(0);
  });
});

describe("under page load", () => {
  test("a healthy release: 600 probes in 10 minutes, one a second, and it passes", async () => {
    const v = await clocked(() => ({ status: 200, ms: 0 })).run;
    expect(v.ok).toBe(true);
    expect(v.tally.probes).toBe(600);
    expect(v.tally.secondsDark).toBe(0);
  });

  test("two bad probes in a row pass; three fail at once, with the numbers", async () => {
    const two = await clocked((n) => (n === 10 || n === 11 ? { status: 503, ms: 1 } : { status: 200, ms: 1 })).run;
    expect(two.ok).toBe(true);
    expect(two.tally).toMatchObject({ non200: 2, worstRun: 2, secondsDark: 2 });
    const three = await clocked((n) => (n >= 10 && n < 10 + FAIL_AFTER ? { status: 0, ms: 1 } : { status: 200, ms: 1 })).run;
    expect(three.ok).toBe(false);
    expect(three.tally.probes).toBe(13);
    expect(three.reason).toBe("3 bad /healthz probes in a row (non-200 or over 10 s) after 13 probes; 3 non-200, worst 1 ms");
  });

  test("three probes over 10 s fail it though each was a 200", async () => {
    const v = await clocked((n) => ({ status: 200, ms: n >= 5 && n < 8 ? 10_500 : 2 })).run;
    expect(v.ok).toBe(false);
    expect(v.tally).toMatchObject({ non200: 0, worstMs: 10_500, secondsDark: 0 });
  });

  test("the pages are fetched one at a time, every one of them", async () => {
    const pages = ["/boards", "/alice/forge", "/explore", "/"];
    const c = clocked(() => ({ status: 200, ms: 0 }), pages, { status: 200, ms: 250 });
    const v = await c.run;
    expect(c.mostOpen()).toBe(1);
    expect(v.tally.pages).toBeGreaterThan(pages.length);
    expect(v.tally.worstMs).toBe(250);
  });
});

describe("a seeded healthy release", () => {
  test("ends verified live with its probes and worst latency stored, and an event", async () => {
    const f = await keeperForge({ healthz: () => ({ status: 200, ms: 30 }) });
    await tick(f.ports);
    // The old forge counts the roll: zero non-200 with surge.
    for (let i = 0; i < 5; i++) await rollProbe(f.ports);
    f.world.live = "0.7.284";
    const line = await tick(f.ports);
    expect(line).toContain("0.7.284 verified live");
    const [r] = listKeeperReleases(f.app.db);
    expect(r!.stage).toBe("verified");
    expect(r!.rollProbes).toBe(5);
    expect(r!.rollNon200).toBe(0);
    expect(r!.probes).toBeGreaterThan(500);
    expect(r!.pages).toBeGreaterThan(0);
    expect(r!.worstMs).toBe(40);
    expect(r!.secondsDark).toBe(0);
    expect(r!.liveAt).not.toBeNull();
    const [ev] = f.events("release.verified_live");
    expect(ev).toMatchObject({ version: "0.7.284", probes: r!.probes, worstMs: 40, secondsDark: 0 });
    expect(f.world.pages.slice(0, 4)).toEqual(["/boards", "/alice/forge", "/explore", "/"]);
    // Nothing went dark, so nothing is filed.
    expect(f.app.db.query("SELECT COUNT(*) AS n FROM issue WHERE title LIKE 'Release % dark%'").get()).toEqual({ n: 0 });
  });

  test("a roll that went dark files one issue, and only one", async () => {
    const f = await keeperForge({ healthz: () => ({ status: 200, ms: 5 }) });
    await tick(f.ports);
    const healthy = f.world.healthz;
    f.world.healthz = () => ({ status: 0, ms: 1 });
    for (let i = 0; i < 4; i++) await rollProbe(f.ports);
    f.world.healthz = healthy;
    f.world.live = "0.7.284";
    await tick(f.ports);
    const [r] = listKeeperReleases(f.app.db);
    expect(r).toMatchObject({ stage: "verified", rollNon200: 4, secondsDark: 4 });
    const filed = f.app.db.query<{ title: string; body: string }, []>("SELECT title, body FROM issue WHERE title LIKE 'Release %'").all();
    expect(filed.map((i) => i.title)).toEqual(["Release 0.7.284 was dark for 4 s"]);
    expect(filed[0]!.body).toContain("4 of 4 during the roll");
  });

  test("a closed issue about the same dark time does not stop the next report", async () => {
    const f = await keeperForge({ healthz: () => ({ status: 200, ms: 5 }) });
    f.app.db
      .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES ('old', ?1, 900, 'issue', 'Release 0.7.284 was dark for 4 s', '', ?2, 'closed', ?3)`)
      .run(f.repo.id, f.user.id, new Date(f.world.now).toISOString());
    await tick(f.ports);
    const healthy = f.world.healthz;
    f.world.healthz = () => ({ status: 0, ms: 1 });
    for (let i = 0; i < 4; i++) await rollProbe(f.ports);
    f.world.healthz = healthy;
    f.world.live = "0.7.284";
    await tick(f.ports);
    const open = f.app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM issue WHERE title = 'Release 0.7.284 was dark for 4 s' AND state = 'open'").get();
    expect(open).toEqual({ n: 1 });
  });
});
