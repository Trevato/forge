/** The ranked read behind explore answers under its budget over 200 repositories, and never shares a private row (#10946). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { explore, parseExploreQuery } from "../src/actions/explore.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createUser, type User } from "../src/core/users.ts";
import { BUDGETS, budgetFor } from "../src/perf/budgets.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let owner: User;
let stranger: User;
const all = parseExploreQuery("");
const budget = budgetFor("/explore#read")!;
/** The best of a few reads, so one stall on a loaded machine is not a finding; a slow read is slow every time. */
async function best(read: () => Promise<unknown>, runs = 3) {
  let low = Infinity;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await read();
    low = Math.min(low, performance.now() - t);
  }
  return low;
}

async function person(username: string, admin: boolean) {
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username, email: `${username}@forge.local`,
    password: "a-good-passphrase", adminIfFirst: admin,
  });
  if (!made.ok) throw new Error(String(made.error));
  return made.value;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-explore-budget-"));
  app = createApp({ dataDir: dir, port: 0 });
  owner = await person("olive", true);
  stranger = await person("pablo", false);
  for (let i = 0; i < 200; i++) {
    const access = i % 4 === 0 ? "private" : "public";
    const repo = await createRepo(app, owner, { name: `app-${i}`, visibility: access });
    if (!repo.ok) throw new Error(String(repo.error));
    const made = insertApp(app.db, { repoId: repo.value.id, slug: `olive-app-${i}`, access });
    if (!made.ok) throw new Error(made.error);
  }
}, 300_000);
afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("the ranked read over 200 repositories is under the registered budget", async () => {
  expect(BUDGETS).toContain(budget);
  expect(budget.p95Ms).toBe(50);
  const rows = await explore(app, stranger, all);
  expect(rows.length).toBeGreaterThan(40);
  // Different words rank afresh; the best of three of them is the read without a stall.
  const ms = await best(() => explore(app, stranger, parseExploreQuery(`kind:app sort:forks app-${Math.random()}`)), 3);
  expect(ms).toBeLessThan(budget.p95Ms);
});

test("a read is under the budget for every sort", async () => {
  for (const sort of ["score", "forks", "ships", "likes", "use", "fresh", "name"]) {
    const q = parseExploreQuery(`kind:app sort:${sort}`);
    expect(await best(() => explore(app, stranger, q))).toBeLessThan(budget.p95Ms);
  }
});

test("a private app is not shown to another viewer after the owner's read is warm", async () => {
  await explore(app, owner, all);
  const mine = (await explore(app, owner, all)).map((r) => r.name);
  const theirs = (await explore(app, stranger, all)).map((r) => r.name);
  expect(mine).toContain("olive/app-0");
  expect(theirs).not.toContain("olive/app-0");
  expect((await explore(app, undefined, all)).map((r) => r.name)).not.toContain("olive/app-0");
});
