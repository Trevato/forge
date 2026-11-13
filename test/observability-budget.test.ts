/**
 * `/boards`, `/map` and home on a forge sized like production's (#3693):
 * a month of 100,000 runs, 1,500 merged pulls, 400 open asks and 2,266
 * edges between them. The owner saw /boards take 8–10 s, a cold /map 34.7 s
 * and home 9.2 s. Each budget is a multiple of one full pass over the run
 * table, timed in the same run, so a loaded machine slows both sides and
 * the wall clock is never the judge (#3069). Before the fix each page cost
 * hundreds of those passes.
 */
import { forgetHome } from "../src/web/studio/home_last.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { clearMapCache } from "../src/web/map_cache.ts";
import { kpiCache, panelCache } from "../src/web/studio/home_cache.ts";
import { p75 } from "../src/flow/reach.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { seedFlowFixture } from "./helpers/flow-fixture.ts";
import { SCRATCH_ROOT, scratchDir } from "./helpers/scratch.ts";

let dataDir = "";
let app: App, servers: Servers, cookie = "";

beforeAll(async () => {
  // ~49 MB of database: on the checkout's disk, not the cell's shared /tmp.
  dataDir = scratchDir("forge-obs-budget-");
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!made.ok) throw new Error(made.error);
  await seedFlowFixture(app, made.value);
  cookie = `forge_session=${createSession(app.db, made.value.id).token}`;
}, 120_000);

afterAll(async () => {
  // A setup that failed part way leaves these unset: say only what it said.
  servers?.stop();
  app?.close();
  if (dataDir !== "") await rm(dataDir, { recursive: true, force: true });
});

/** One full pass over every run: the unit the budgets are counted in. */
function scan(): number {
  const started = performance.now();
  app.db.query("SELECT COUNT(*), SUM(length(branch)), SUM(length(created_at)) FROM run").get();
  return performance.now() - started;
}

function baseline(): number {
  const spent = [scan(), scan(), scan()].sort((a, b) => a - b);
  return spent[1]!;
}

async function get(path: string): Promise<{ ms: number; status: number; timing: string }> {
  const started = performance.now();
  const res = await fetch(`${servers.url}${path}`, { headers: { cookie } });
  await res.arrayBuffer();
  return { ms: performance.now() - started, status: res.status, timing: res.headers.get("server-timing") ?? "" };
}

const names = (timing: string): string[] => timing.split(", ").map((p) => p.split(";")[0]!);

describe("on production's size", () => {
  test("the fixture lives on the checkout's disk, not in the shared /tmp", () => {
    expect(dataDir.startsWith(SCRATCH_ROOT)).toBe(true);
    expect(dataDir.startsWith(tmpdir())).toBe(false);
  });

  test("the fixture is production's size", () => {
    const n = (sql: string) => (app.db.query(sql).get() as { n: number }).n;
    expect(n("SELECT COUNT(*) AS n FROM run")).toBe(100_000);
    expect(n("SELECT COUNT(*) AS n FROM issue_dependency")).toBeGreaterThan(2_000);
  });

  test("/boards answers within a few passes over the runs, and names its phases", async () => {
    await get("/boards");
    const unit = baseline();
    const res = await get("/boards");
    expect(res.status).toBe(200);
    for (const n of ["session", "picture", "flow", "render"]) expect(names(res.timing)).toContain(n);
    expect(res.ms).toBeLessThan(30 * unit);
  });

  test("a cold /map answers within a few passes over the runs", async () => {
    await get("/map");
    clearMapCache();
    const unit = baseline();
    const res = await get("/map");
    expect(res.status).toBe(200);
    expect(names(res.timing)).toContain("layout");
    expect(res.ms).toBeLessThan(60 * unit);
  });

  test("a cold home answers from the picture, within a few passes over the runs", async () => {
    await get("/");
    // what this budget measures is the cold path, a miss on every one of them and on the regions home remembers (#7660).
    // what this budget measures is the cold path, a miss on every one of them, not a warm hit.
    app.db.run("UPDATE repo SET description = description || ''");
    for (const cache of [kpiCache(app.db), panelCache(app.db)]) cache.clear();
    forgetHome(app.db);
    const unit = baseline();
    const res = await get("/");
    expect(res.status).toBe(200);
    // the home reads no table itself: the lanes' worker does, and the page is drawn from its picture
    expect(names(res.timing)).toContain("picture");
    expect(res.ms).toBeLessThan(30 * unit);
  });
});

test("home's p75 is nearest rank, read in one pass: the value at ⌈0.75·n⌉", () => {
  expect(p75([])).toBeNull();
  expect(p75([7])).toBe(7);
  // n = 4: rank 3. n = 5: rank ⌈3.75⌉ = 4. Order of arrival does not matter.
  expect(p75([40, 10, 30, 20])).toBe(30);
  expect(p75([50, 10, 40, 20, 30])).toBe(40);
});
