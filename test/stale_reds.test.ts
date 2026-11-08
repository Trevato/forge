/**
 * A red pull never sits (#8245): the sweep reads the database with `now` given,
 * so a restart in the middle changes nothing; a person's hold is left alone.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { provideChecksForTest, type ChecksHandle } from "../src/checks/service.ts";
import { setHold } from "../src/core/holds.ts";
import { getIssueById, listComments } from "../src/core/issues.ts";
import { getPull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { createRun, listRuns } from "../src/core/runs.ts";
import { sweepStaleReds, PER_TICK } from "../src/crew/stale_reds.ts";
import { readStaleReds, SWEEP_REASON } from "../src/flow/stale_reds.ts";
import { pickCause, STALE_REDS } from "../src/flow/keeper_cause.ts";
import { flowReadings, flowReportLines } from "../src/flow/report.ts";

let dataDir: string;
let app: App;
let alice: User;
let mason: User;
let repo: Repo;
let n = 0;
const requested: string[] = [];
/** The reds of the burst test, which the flow-report test counts. */
const burst: Awaited<ReturnType<typeof pullBy>>[] = [];

// From the clock, not a date: rows the test makes carry today's real time, and a fixed T0 stops
// passing once the day reaches it.
const T0 = new Date();
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-stale-reds-"));
  app = createApp({ dataDir, port: 0 });
  const a = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  alice = a.value;
  const made = await createRepo(app, alice, { name: "engine", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  const seeded = await commitToBranch(app, alice, repo, {
    message: "Start",
    files: [{ path: "shared.ts", content: "export const shared = 0;\n" }],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  const agent = await createAgent(app, alice, { username: "mason" });
  if (!agent.ok) throw new Error(String(agent.error));
  expect(addToCrew(app, alice, repo, "mason").ok).toBe(true);
  mason = getUserByName(app.db, "mason")!;
  app.db
    .query("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2 WHERE id = ?1")
    .run(repo.id, alice.id);
  repo = getRepoById(app.db, repo.id)!;
  const handle = {
    request: async (r: Repo, env: string, oid: string, reason: string, issueId?: string) => {
      requested.push(env);
      return createRun(app.db, { repoId: r.id, kind: "check", env, commitOid: oid, reason, issueId });
    },
  } as unknown as ChecksHandle;
  provideChecksForTest(app, handle);
});

afterAll(async () => {
  app.db.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** An open crew pull on its own file, closing a fresh issue assigned to mason. */
async function pullBy(who: User, file?: string) {
  const k = ++n;
  const ask = openIssue(app, alice, repo, { title: `Ask ${k}` });
  if (!ask.ok) throw new Error(String(ask.error));
  app.db.query("UPDATE issue SET assignee_id = ?2 WHERE id = ?1").run(ask.value.id, mason.id);
  const branch = await commitToBranch(app, alice, repo, {
    branch: `feature/r${k}`,
    base: "main",
    message: `Red ${k}`,
    files: [{ path: file ?? `r${k}.ts`, content: `export const r = ${k};\n` }],
  });
  if (!branch.ok) throw new Error(JSON.stringify(branch.error));
  const opened = await openPull(app, who, repo, {
    title: `Red ${k}`,
    body: `Closes #${ask.value.number}`,
    baseBranch: "main",
    headBranch: `feature/r${k}`,
  });
  if (!opened.ok) throw new Error(String(opened.error));
  return { pull: getPull(app.db, repo.id, opened.value.number)!, ask: ask.value };
}

/** A finished run on the pull's head, `minutes` after T0. */
function finished(p: { pull: { id: string; headOid: string } }, kind: "check" | "agent", state: string, minutes: number, reason = "", test = "") {
  const run = createRun(app.db, { repoId: repo.id, kind, issueId: p.pull.id, commitOid: p.pull.headOid, reason });
  app.db
    .query("UPDATE run SET state = ?2, created_at = ?3, finished_at = ?3, summary = ?4, check_detail = ?5 WHERE id = ?1")
    .run(run.id, state, at(minutes).toISOString(), state === "failed" ? `failed: ${test}` : "", test === "" ? "" : JSON.stringify({ names: [test] }));
  return run;
}

const runsOf = (id: string) => listRuns(app.db, repo.id, { issueId: id, limit: 50 });
const open = (id: string) => getIssueById(app.db, id)!.state === "open";

test("a red pull quiet for 30 minutes is re-checked, then its builder is queued with the failing test named", async () => {
  const p = await pullBy(mason);
  finished(p, "check", "failed", 0, "", "engine > adds up");
  // 20 minutes after the failure: not yet quiet.
  expect(await sweepStaleReds(app, repo, at(20), 3)).toEqual([]);
  // A restart here loses nothing: the sweep keeps no memory.
  const first = await sweepStaleReds(app, repo, at(31), 3);
  expect(first).toContainEqual({ pull: p.pull.number, did: "re-check queued" });
  expect(requested).toContain(`pull-${p.pull.number}`);
  // The re-check is in flight: nothing more.
  expect((await sweepStaleReds(app, repo, at(32), 3)).filter((m) => m.pull === p.pull.number)).toEqual([]);
  // It ends red.
  const again = runsOf(p.pull.id).find((r) => r.reason === SWEEP_REASON)!;
  app.db
    .query("UPDATE run SET state = 'failed', finished_at = ?2, summary = 'failed', check_detail = ?3 WHERE id = ?1")
    .run(again.id, at(40).toISOString(), JSON.stringify({ names: ["engine > adds up"] }));
  const second = await sweepStaleReds(app, repo, at(41), 3);
  expect(second).toContainEqual({ pull: p.pull.number, did: "builder queued" });
  expect(listComments(app.db, p.pull.id).map((c) => c.body).join("\n")).toContain("engine > adds up");
  expect(runsOf(p.pull.id).some((r) => r.kind === "agent" && r.reason === "check_failed")).toBe(true);
});

test("a pull a person holds, or is assigned to, is left alone", async () => {
  const held = await pullBy(mason);
  const mine = await pullBy(mason);
  finished(held, "check", "failed", 100, "", "engine > held");
  finished(mine, "check", "failed", 100, "", "engine > mine");
  setHold(app.db, held.pull.id, alice.id, "wait for the design");
  app.db.query("UPDATE issue SET assignee_id = ?2 WHERE id = ?1").run(mine.pull.id, alice.id);
  const moves = await sweepStaleReds(app, repo, at(200), 3);
  expect(moves.filter((m) => m.pull === held.pull.number || m.pull === mine.pull.number)).toEqual([]);
  expect(runsOf(held.pull.id).some((r) => r.reason === SWEEP_REASON || r.kind === "agent")).toBe(false);
  expect(runsOf(mine.pull.id).some((r) => r.reason === SWEEP_REASON || r.kind === "agent")).toBe(false);
  expect(open(held.pull.id)).toBe(true);
});

test("a pull past its tries is parked and its issue is ready again", async () => {
  const p = await pullBy(mason);
  finished(p, "check", "failed", 300, "", "engine > stubborn");
  finished(p, "agent", "ok", 301, "check_failed");
  finished(p, "agent", "ok", 302, "check_failed");
  const moves = await sweepStaleReds(app, repo, at(400), 3);
  expect(moves).toContainEqual({ pull: p.pull.number, did: "parked" });
  expect(open(p.pull.id)).toBe(false);
  const freed = getIssueById(app.db, p.ask.id)!;
  expect(freed.state).toBe("open");
  expect(freed.assigneeId).toBeNull();
});

test("a pull red for over a day whose issue is closed is closed with a line saying why", async () => {
  const p = await pullBy(mason);
  finished(p, "check", "failed", 1000, "", "engine > old");
  app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(p.ask.id);
  expect(await sweepStaleReds(app, repo, at(1000 + 23 * 60), 3)).not.toContainEqual({ pull: p.pull.number, did: "closed" });
  const moves = await sweepStaleReds(app, repo, at(1000 + 25 * 60), 3);
  expect(moves).toContainEqual({ pull: p.pull.number, did: "closed" });
  expect(open(p.pull.id)).toBe(false);
  expect(listComments(app.db, p.pull.id).map((c) => c.body).join("\n")).toContain("the issue it was for is no longer open");
});

test("a pull red for over a day that conflicts with main is closed saying so", async () => {
  const p = await pullBy(mason, "shared.ts");
  finished(p, "check", "failed", 2000, "", "engine > conflicting");
  const moved = await commitToBranch(app, alice, repo, {
    message: "Main moves on",
    files: [{ path: "shared.ts", content: "export const shared = 99;\n" }],
  });
  if (!moved.ok) throw new Error(JSON.stringify(moved.error));
  // Red for under a day: it conflicts, but it is reworked, not closed.
  expect(await sweepStaleReds(app, repo, at(2000 + 23 * 60), 3)).not.toContainEqual({ pull: p.pull.number, did: "closed" });
  expect(open(p.pull.id)).toBe(true);
  const moves = await sweepStaleReds(app, repo, at(2000 + 25 * 60), 3);
  expect(moves).toContainEqual({ pull: p.pull.number, did: "closed" });
  expect(open(p.pull.id)).toBe(false);
  expect(listComments(app.db, p.pull.id).map((c) => c.body).join("\n")).toContain("it conflicts with main");
  expect(getIssueById(app.db, p.ask.id)!.assigneeId).toBeNull();
});

test("a burst of reds is paced: no more than PER_TICK start in one tick", async () => {
  const made = burst;
  for (let i = 0; i < PER_TICK + 2; i++) {
    const p = await pullBy(mason);
    finished(p, "check", "failed", 3000, "", `engine > burst ${i}`);
    made.push(p);
  }
  const moves = await sweepStaleReds(app, repo, at(3100), 99);
  expect(moves.filter((m) => made.some((p) => p.pull.number === m.pull)).length).toBe(PER_TICK);
  // No free slot, no start.
  expect(
    (await sweepStaleReds(app, repo, at(3101), 0)).filter((m) => made.some((p) => p.pull.number === m.pull)),
  ).toEqual([]);
});

test("the flow report counts stale reds and the keeper names them as a cause", () => {
  const now = at(3100 + 600);
  // Only the burst is left open: an earlier pull's queued run may be picked up and finished by
  // the app's own runner at a time of its choosing, which would add a sixth red on a slow machine.
  const ids = burst.map((p) => p.pull.id);
  app.db
    .query(`UPDATE issue SET state = 'closed' WHERE state = 'open' AND id NOT IN (${ids.map(() => "?").join(",")})`)
    .run(...ids);
  const read = readStaleReds(app.db, now);
  // The burst's five reds, failed at minute 3000, 700 minutes before `now`; the held,
  // person-assigned, parked and closed ones are not counted.
  expect(read.count).toBe(PER_TICK + 2);
  expect(read.oldestHours).toBeCloseTo(700 / 60, 5);
  const line = flowReportLines(flowReadings(app.db, now)).find((l) => l.startsWith("stale_reds:"))!;
  expect(line).toBe("stale_reds: 5 red with no run for 30 min, oldest 11.7 h");
  const found = pickCause({ repos: [{ repoId: "r", slug: "a/b", startable: 1, running: 1, slots: 4, ceilingUsd: 10, atCeiling: false, noHeadroom: false, resetsAt: null }], red: 0, staleReds: STALE_REDS, stale: 0 });
  expect(found?.cause).toBe("stale_reds");
});
