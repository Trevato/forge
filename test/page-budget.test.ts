/**
 * The page-load budget (#11320): the five pages people open first answer
 * under their median warm, on a seeded forge booted in-process and walked
 * signed in, and run no more SQL statements than `src/perf/page_budget.ts`
 * allows.
 *
 * The count is the hard assertion and is judged first: it does not move with
 * the machine's load, and it is the fewest of five warm requests. The clock is 20 warm requests per page after one to
 * warm; a page whose median misses is measured again (up to three rounds)
 * before it is named, so a busy check host does not fail a fast page.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createOrg } from "../src/core/orgs.ts";
import { mintClaim } from "../src/spawn/claim.ts";
import { createIssue } from "../src/core/issues.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import {
  PAGE_BUDGETS, countFinding, median, pagePath, timeFinding, type PageBudget, type PageMeasure,
} from "./helpers/page_budget.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";
import { proveAll } from "./helpers/verified.ts";
import { statements } from "./helpers/statements.ts";
import { parsePhases } from "./helpers/work.ts";

quietLogs();

const TIMED = 20;
const COUNTED = 5;
const ROUNDS = 3;

let root = "";
let app: App;
let servers: Servers;
let cookie = "";

async function user(name: string, first: boolean): Promise<User> {
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: name, email: `${name}@forge.local`,
    password: "a-good-passphrase", adminIfFirst: first,
  });
  if (!u.ok) throw new Error(u.error);
  promote(app.db, u.value);
  return u.value;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-page-budget-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const alice = await user("alice", true);
  const bob = await user("bob", false);
  proveAll(app);
  for (const name of ["forge", "notes"]) {
    const made = await createRepo(app, alice, { name, visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
  }
  const notes = getRepo(app.db, "alice", "notes")!;
  const files = await commitToBranch(app, alice, notes, {
    message: "an app",
    files: [
      { path: "README.md", content: "# notes\n\nA small app.\n" },
      { path: "forge.json", content: JSON.stringify({ run: "bun run main.ts" }) },
      { path: "main.ts", content: "Bun.serve({ fetch: () => new Response('ok') });\n" },
    ],
  });
  if (!files.ok) throw new Error(JSON.stringify(files.error));
  for (let i = 1; i <= 12; i++) {
    const made = createIssue(app.db, { repoId: notes.id, authorId: bob.id, title: `Issue ${i}`, body: "body" });
    if (!made.ok) throw new Error(made.error);
  }
  // A spawned forge with a live claim link, so `/claim` shows its form.
  const kin = createOrg(app.db, "kin", alice.id);
  if (!kin.ok) throw new Error(kin.error);
  await Bun.write(join(root, "parent.json"), JSON.stringify({ org: "kin" }));
  mintClaim(app.db, kin.value.id);
  servers = await serve(app);
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
  if (!cookie) throw new Error("alice could not sign in");
}, 60_000);

afterAll(() => {
  servers?.stop();
  app?.close();
  rmSync(root, { recursive: true, force: true });
});

/** Pages are walked as alice, signed in (the map asks for a viewer); a stranger's pages (`signedOut`) with no cookie. */
const init = (b: PageBudget): RequestInit => (b.signedOut ? { redirect: "manual" } : { headers: { cookie }, redirect: "manual" });

function url(b: PageBudget): string {
  return `${servers.url}${pagePath(b, "alice", "notes")}`;
}

/** One request warms; then the fewest statements of `COUNTED` warm requests is the count, so a background tick's queries do not land on a page. */
async function count(b: PageBudget): Promise<{ status: number; statements: number; phases: PageMeasure["phases"] }> {
  const first = await fetch(url(b), init(b));
  await first.arrayBuffer();
  let status = first.status;
  let header = "";
  let fewest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < COUNTED; i++) {
    const n = await statements(app.db, async () => {
      const res = await fetch(url(b), init(b));
      await res.arrayBuffer();
      status = res.status;
      header = res.headers.get("server-timing") ?? "";
    });
    fewest = Math.min(fewest, n);
    if (status !== 200) break;
  }
  return { status, statements: fewest, phases: parsePhases(header) };
}

/** One warm-up, then `TIMED` timed requests; the phases are the last request's. */
async function time(b: PageBudget): Promise<{ samples: number[]; phases: PageMeasure["phases"] }> {
  await (await fetch(url(b), init(b))).arrayBuffer();
  const samples: number[] = [];
  let header = "";
  for (let i = 0; i < TIMED; i++) {
    const t = performance.now();
    const res = await fetch(url(b), init(b));
    await res.arrayBuffer();
    samples.push(performance.now() - t);
    header = res.headers.get("server-timing") ?? "";
  }
  return { samples, phases: parsePhases(header) };
}

test("the budget table names eight pages, each once, with a median and a statement limit", () => {
  expect(PAGE_BUDGETS.map((b) => b.pattern)).toEqual([
    "/", "/explore", "/map", "/:owner/:name", "/changelog", "/pricing", "/forges/new", "/claim",
  ]);
  for (const b of PAGE_BUDGETS) {
    expect(b.medianMs).toBeLessThanOrEqual(50);
    expect(Number.isInteger(b.statements) && b.statements > 0).toBe(true);
  }
});

test("a stranger's way to a forge is on the list, walked signed out", () => {
  const strangers = PAGE_BUDGETS.filter((b) => b.signedOut).map((b) => b.pattern);
  expect(strangers).toEqual(["/pricing", "/forges/new", "/claim"]);
});

test("each first page runs no more SQL statements warm than its budget", async () => {
  const findings: string[] = [];
  const table: string[] = [];
  for (const b of PAGE_BUDGETS) {
    const c = await count(b);
    table.push(`${b.pattern}\t${c.status}\t${c.statements} sql`);
    const f = countFinding(b, { ...c, samples: [] });
    if (f) findings.push(f);
  }
  console.log(`first pages, counted warm:\n${table.join("\n")}`);
  expect(findings).toEqual([]);
}, 60_000);

test("each first page answers under its median warm, retried before it is named", async () => {
  const findings: string[] = [];
  const table: string[] = [];
  for (const b of PAGE_BUDGETS) {
    let found: string | undefined;
    let mid = Number.NaN;
    for (let round = 0; round < ROUNDS; round++) {
      const t = await time(b);
      mid = median(t.samples);
      found = timeFinding(b, { status: 200, statements: 0, ...t });
      if (!found) break;
    }
    table.push(`${b.pattern}\tmedian ${mid.toFixed(1)} ms`);
    if (found) findings.push(found);
  }
  console.log(`first pages, timed warm:\n${table.join("\n")}`);
  expect(findings).toEqual([]);
}, 120_000);

test("a miss names the page, its median and its Server-Timing phases", () => {
  const b = PAGE_BUDGETS[1]!;
  const m: PageMeasure = {
    status: 200, statements: 99, samples: [70, 60, 80],
    phases: [{ name: "read", ms: 41.25 }, { name: "render", ms: 3 }],
  };
  expect(timeFinding(b, m)).toBe(
    "/explore (explore): median 70.0 ms over 3 warm requests, budget 50 ms (read 41.3 ms, render 3.0 ms)",
  );
  expect(countFinding(b, m)).toBe(
    `/explore (explore): 99 SQL statements, budget ${b.statements} (read 41.3 ms, render 3.0 ms)`,
  );
  expect(countFinding(b, { ...m, status: 302 })).toBe("/explore (explore): answered 302, not 200");
  expect(timeFinding(b, { ...m, samples: [1, 2, 90] })).toBeUndefined();
  expect(countFinding(b, { ...m, statements: 1 })).toBeUndefined();
});

test("the median is the middle sample, or the mean of the middle two", () => {
  expect(median([5, 1, 3])).toBe(3);
  expect(median([4, 1, 3, 2])).toBe(2.5);
  expect(Number.isNaN(median([]))).toBe(true);
});

