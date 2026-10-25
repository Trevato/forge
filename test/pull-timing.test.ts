/** `/:owner/:name/pulls/:n`'s Server-Timing names its phases (#3192), and its Files page's (#3359). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createSession } from "../src/core/sessions.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";
let number = 0;
let bigNumber = 0;
let owner: User;
let repoRow: Repo;
const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-pull-timing-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  const alice = made.value;
  owner = alice;
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const repo = await createRepo(app, alice, { name: "r", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  repoRow = repo.value;
  for (const [branch, file] of [[undefined, "forge.json"], ["topic", "t.txt"]] as const) {
    const done = await commitToBranch(app, alice, repo.value, {
      ...(branch === undefined ? {} : { branch }),
      message: "change",
      files: [{ path: file, content: file === "forge.json" ? "{}" : "x" }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  }
  const pull = await openPull(app, alice, repo.value, {
    title: "t",
    body: "",
    baseBranch: "main",
    headBranch: "topic",
  });
  if (!pull.ok) throw new Error(JSON.stringify(pull.error));
  number = pull.value.number;
  // A 40-file, 2,000-line change, for the Files page.
  const big = await commitToBranch(app, alice, repo.value, {
    branch: "big",
    message: "big",
    files: Array.from({ length: 40 }, (_, f) => ({
      path: `src/m${f}.ts`,
      content: Array.from(
        { length: 50 },
        (_, i) => `export const v${f}_${i} = "<b>${i}</b>" + (${i} < 3 ? 'x' : \`y\${${i}}\`); // note & ${f}`,
      ).join("\n") + "\n",
    })),
  });
  if (!big.ok) throw new Error(JSON.stringify(big.error));
  const bigPull = await openPull(app, alice, repo.value, {
    title: "big",
    body: "",
    baseBranch: "main",
    headBranch: "big",
  });
  if (!bigPull.ok) throw new Error(JSON.stringify(bigPull.error));
  bigNumber = bigPull.value.number;
  createRun(app.db, {
    repoId: repo.value.id,
    kind: "check",
    issueId: pull.value.id,
    env: `pull-${number}`,
    commitOid: pull.value.headOid,
  });
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

test("a pull names session, diff, checks, reviews and render after app, summing to no more than app", async () => {
  const res = await fetch(`${servers.url}/alice/r/pulls/${number}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  await res.arrayBuffer();
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  const names = parts.map((p) => p.split(";")[0]!);
  const after = names.slice(names.indexOf("app") + 1);
  expect(after).toEqual(["session", "diff", "checks", "reviews", "render"]);
  const ms = (n: string) => Number(parts[names.indexOf(n)]!.match(/dur=([\d.]+)/)![1]);
  const sum = after.reduce((t, n) => t + ms(n), 0);
  // Each is rounded to 0.1 ms, so allow one step per phase.
  expect(sum).toBeLessThanOrEqual(ms("app") + 0.1 * after.length);
  expect(ms("diff")).toBeGreaterThan(0);
  expect(ms("checks")).toBeGreaterThan(0);
});

test("a pull's Files page names session, diff, checks, reviews and render, in that order, on the 40-file seed", async () => {
  const url = `${servers.url}/alice/r/pulls/${bigNumber}/files`;
  const res = await fetch(url, { headers: { cookie } });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("m39.ts");
  expect(html).not.toContain("<b>1</b>");
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  const names = parts.map((p) => p.split(";")[0]!);
  expect(names.slice(names.indexOf("app") + 1)).toEqual(["session", "diff", "checks", "reviews", "render"]);
});

/** The `app` duration of one Files-page view, in ms. */
async function filesApp(): Promise<number> {
  const res = await fetch(`${servers.url}/alice/r/pulls/${number}/files`, { headers: { cookie } });
  expect(res.status).toBe(200);
  await res.arrayBuffer();
  const app = (res.headers.get("server-timing") ?? "").match(/(?:^|, )app;dur=([\d.]+)/);
  return Number(app![1]);
}

/** 40 files of 50 lines each, new content per `i` so each is a fresh head. */
async function commitHead(i: number): Promise<void> {
  const done = await commitToBranch(app, owner, repoRow, {
    branch: "topic",
    message: `head ${i}`,
    files: Array.from({ length: 40 }, (_, f) => ({
      path: `d/f${f}.ts`,
      content: Array.from({ length: 50 }, (_, l) => `export const v${i}_${f}_${l} = ${l};`).join("\n"),
    })),
  });
  if (!done.ok) throw new Error(JSON.stringify(done.error));
}

// Measured over 3 runs of this test (40 files x 50 lines): the cold median of 3 was 125-135 ms
// (a single cold view up to 244 ms); the repeat median of 5 was 55 ms (single views 49-76 ms).
// 250 ms is ~2x the cold median; 100 ms is the issue's bar for a repeat view.
const COLD_MS = 250;

/**
 * A fixed CPU workload, in ms. The `x < 0` is never true; it only keeps the optimiser from
 * deleting the loop as dead code.
 */
const spin = (): number => {
  const t = performance.now();
  let x = 0;
  for (let n = 0; n < 3e6; n++) x = (x + Math.sqrt(n)) % 1e9;
  return x < 0 ? 0 : performance.now() - t;
};
const fastest = (n: number) => Math.min(...Array.from({ length: n }, spin));
/** This machine's speed, taken once at module load: the idle reference (scale 1.0 beside itself). */
const idle = (spin(), fastest(5));

/**
 * How much slower the machine was around one view than at load, from the spin times taken just
 * before and just after it: the larger of the two, so contention that starts or stops mid-view
 * still counts (#5000). Never below 1.0, so an idle machine meets the ceilings as written; capped
 * at 8x so a stalled machine cannot excuse anything.
 */
const loadScale = (before: number, after: number, idleMs: number): number =>
  Math.max(1, Math.min(Math.max(before, after) / idleMs, 8));

/** One view's ms divided by the load around it: what it would have taken on the idle machine. */
async function idleEquivalent(view: () => Promise<number>): Promise<number> {
  const before = fastest(2);
  const ms = await view();
  return ms / loadScale(before, fastest(2), idle);
}

test("loadScale: idle is 1.0, the slower side of a view wins, and 8x is the cap", () => {
  expect(loadScale(10, 10, 10)).toBe(1);
  // Faster than at load is still 1.0: an idle machine's 105 ms repeat view fails the 100 ms bar.
  expect(loadScale(8, 9, 10)).toBe(1);
  expect(105 / loadScale(8, 9, 10)).toBeGreaterThan(100);
  // Load that arrives after the view started is seen by the after-sample (#5000's 105 ms run).
  expect(loadScale(10, 15, 10)).toBe(1.5);
  expect(loadScale(15, 10, 10)).toBe(1.5);
  expect(105 / loadScale(10, 15, 10)).toBeLessThan(100);
  expect(loadScale(10, 1000, 10)).toBe(8);
});

test("the Files page of a 40-file diff: fastest cold view of 3 and fastest repeat view of 5 stay under their ceilings", async () => {
  // Each view is scaled by the load measured beside it, not once up front: contention that begins
  // partway through the eight views would otherwise leave the ceilings unstretched (#5000).
  const cold: number[] = [];
  for (let i = 0; i < 3; i++) {
    // A new head each time, so nothing rendered before is reused.
    await commitHead(i);
    cold.push(await idleEquivalent(filesApp));
  }
  // The head is unchanged now: every view reuses the rendered diff.
  const repeat: number[] = [];
  for (let i = 0; i < 5; i++) repeat.push(await idleEquivalent(filesApp));
  // The fastest view, not the median: contention only ever adds time, so the minimum is the
  // measurement least about the machine's load, and still fails if the work itself got slower.
  expect(Math.min(...cold)).toBeLessThan(COLD_MS);
  expect(Math.min(...repeat)).toBeLessThan(100);
});
