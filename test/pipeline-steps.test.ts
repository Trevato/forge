/** Each step of the path, measured (#7784): median time and red rate over 30 days, from seeded runs, on the page. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { flowFor } from "../src/system/telemetry.ts";
import { flowLines } from "../src/tui/screens/flow.ts";
import { cachedStepStats, median, readStepStats, statWords } from "../src/flow/pipeline.ts";
import { serve, type Servers } from "../src/http/server.ts";

const MIN = 60_000;
const DAY = 86_400_000;

let dataDir: string;
let app: App;
let servers: Servers;
let repoId: string;
let privateId: string;

/** A finished run that took `mins` minutes, ended `daysAgo` days ago. */
function seed(kind: string, state: string, mins: number, daysAgo: number, set: Record<string, string | null> = {}, repo = repoId) {
  const run = createRun(app.db, { repoId: repo, kind: kind as "check", reason: set["reason"] ?? "push" });
  const end = Date.now() - daysAgo * DAY;
  app.db
    .query("UPDATE run SET state = ?1, started_at = ?2, finished_at = ?3, issue_id = ?4, env = ?5 WHERE id = ?6")
    .run(state, new Date(end - mins * MIN).toISOString(), new Date(end).toISOString(), set["issue"] ?? null, set["env"] ?? "", run.id);
}

function gate(mins: number | null, daysAgo: number, repo = repoId) {
  const end = Date.now() - daysAgo * DAY;
  app.db
    .query("INSERT INTO check_gate (id, repo_id, started_at, finished_at) VALUES (?1, ?2, ?3, ?4)")
    .run(`g${Math.random()}`, repo, new Date(end - (mins ?? 0) * MIN).toISOString(), mins === null ? null : new Date(end).toISOString());
}

let pullIssueId = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-steps-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  const a = await createRepo(app, u.value, { name: "open" });
  const b = await createRepo(app, u.value, { name: "closed" });
  if (!a.ok || !b.ok) throw new Error("repo");
  repoId = a.value.id;
  privateId = b.value.id;
  app.db.query("UPDATE repo SET visibility = 'public' WHERE id = ?1").run(repoId);
  const opened = openIssue(app, u.value, a.value, { title: "A change" });
  if (!opened.ok) throw new Error(String(opened.error));
  const pullIssue = opened.value.id;
  const po = openIssue(app, u.value, b.value, { title: "Hidden" });
  if (!po.ok) throw new Error(String(po.error));
  const privIssue = po.value.id;
  pullIssueId = pullIssue;
  // Pull checks: 4, 6, 10 minutes green and one 20-minute red → median 8m, 25% red.
  seed("check", "ok", 4, 1, { issue: pullIssue });
  seed("check", "ok", 6, 2, { issue: pullIssue });
  seed("check", "ok", 10, 3, { issue: pullIssue });
  seed("check", "failed", 20, 4, { issue: pullIssue });
  seed("check", "ok", 99, 40, { issue: pullIssue }); // outside 30 days
  seed("check", "cancelled", 99, 1, { issue: pullIssue }); // no verdict
  seed("check", "failed", 5, 1, { issue: privIssue }, privateId); // private: hidden from the page
  // Main's check: 2 and 4 minutes, one red.
  seed("check", "ok", 2, 1, { env: "main" });
  seed("check", "failed", 4, 1, { env: "main" });
  // Verify lane: a verify and a verify-bisect check; even one tied to a pull is not a pull check.
  seed("check", "ok", 10, 1, { env: "verify" });
  seed("check", "failed", 30, 1, { env: "verify-bisect", issue: pullIssue });
  // Merge-queue gates: 6 and 12 minutes; an open one and a private one do not count.
  gate(6, 1);
  gate(12, 2);
  gate(null, 0);
  gate(60, 1, privateId);
  // Release build.
  seed("deploy", "ok", 3, 1, { env: "production" });
  // A review that failed.
  seed("agent", "failed", 7, 1, { reason: "review" });
});

afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("median is the middle, or the mean of the two middle values", () => {
  expect(median([])).toBeNull();
  expect(median([5, 1, 3])).toBe(3);
  expect(median([1, 2, 3, 10])).toBe(2.5);
});

test("a step's median time and red rate follow from its runs in the last 30 days", () => {
  const by = Object.fromEntries(readStepStats(app.db, new Date(), true).map((s) => [s.key, s]));
  // Hand calculation: durations 4, 6, 10, 20 → median (6+10)/2 = 8 min; 1 of 4 red.
  expect(by["pull-check"]?.runs).toBe(4);
  expect(by["pull-check"]?.medianMs).toBeCloseTo(8 * MIN, -2);
  expect(by["pull-check"]?.redRate).toBe(0.25);
  expect(by["main-check"]?.medianMs).toBeCloseTo(3 * MIN, -2);
  expect(by["main-check"]?.redRate).toBe(0.5);
  expect(by["release"]?.redRate).toBe(0);
  expect(by["review"]?.redRate).toBe(1);
  // Only the verify lane's rows: the plain verify (10m, green) and the bisect (30m, red) → median 20m, 50% red.
  expect(by["verify"]?.runs).toBe(2);
  expect(by["verify"]?.medianMs).toBeCloseTo(20 * MIN, -2);
  expect(by["verify"]?.redRate).toBe(0.5);
  // Gates: time only — 6 and 12 → median 9m; no verdict; the open and private rows are cut.
  expect(by["gate"]?.runs).toBe(2);
  expect(by["gate"]?.medianMs).toBeCloseTo(9 * MIN, -2);
  expect(by["gate"]?.redRate).toBeNull();
  expect(by["gate"]?.note).toBe("time only: the gate keeps no verdict, and only the last week");
  expect(statWords(by["gate"] as never)).toBe("median 9m · time only: the gate keeps no verdict, and only the last week");
  // A review run that failed is an error, not a changes-asked verdict, and says so.
  expect(statWords(by["review"] as never)).toBe("median 7m · 100% errored (1 of 1)");
  expect(statWords(by["boot"] as never)).toBe("runs inside the release build: a failed boot is a failed release build");
  expect(statWords(by["pull-check"] as never)).toBe("median 8m · 25% red (1 of 4)");
  const all = Object.fromEntries(readStepStats(app.db, new Date(), false).map((s) => [s.key, s]));
  expect(all["pull-check"]?.runs).toBe(5);
  expect(all["gate"]?.runs).toBe(3);
});

test("/pipeline shows each step's median and red rate under its details", async () => {
  const body = await (await fetch(`${servers.url}/pipeline`)).text();
  const statOf = (label: string) =>
    body.match(new RegExp(`<span class="stat-label">${label}</span><span class="stat-value num"[^>]*>([^<]*)</span><span class="stat-note"[^>]*>([^<]*)</span>`))?.slice(1);
  expect(statOf("Pull check")).toEqual(["8m", "25% red (1 of 4)"]);
  expect(statOf("Main&#39;s check")).toEqual(["3m", "50% red (1 of 2)"]);
  expect(statOf("Review run")).toEqual(["7m", "100% errored (1 of 1)"]);
  expect(statOf("Boot check")).toEqual(["—", "runs inside the release build: a failed boot is a failed release build"]);
  expect(body.match(/data-measures="/g)?.length).toBe(4);
});

test("the open page reads the runs once a minute", () => {
  const at = new Date();
  const first = cachedStepStats(app.db, at, true);
  seed("check", "failed", 1, 0, { issue: pullIssueId });
  expect(cachedStepStats(app.db, new Date(at.getTime() + 1), true)).toBe(first);
  expect(cachedStepStats(app.db, new Date(at.getTime() + 61_000), true)).not.toBe(first);
});

test("the terminal's Flow lines carry the steps, private repositories for an admin only", () => {
  const admin = flowLines(app.db).join(" ").replace(/\s+/g, " ");
  expect(admin).toContain("Steps, 30 days:");
  expect(admin).toContain("Merge-queue gate: median 12m");
  const agent = flowLines(app.db, new Date(), undefined, { queues: [] }).join(" ").replace(/\s+/g, " ");
  expect(agent).toContain("Merge-queue gate: median 9m");
});

test("the MCP flow tool and the API return the steps, an agent's cut to public repositories", () => {
  const owner = flowFor(app, { kind: "owner" } as never).steps;
  const agent = flowFor(app, { kind: "agent" } as never).steps;
  const gateOf = (steps: typeof owner) => steps.find((s) => s.key === "gate");
  expect(gateOf(owner)?.runs).toBe(3);
  expect(gateOf(agent)?.runs).toBe(2);
  expect(owner.some((s) => s.key === ("proof" as never))).toBe(false);
});
