/**
 * How much each seat may do at once (#7668): the planner and the reviewer
 * have a number beside the builders', 0 pauses a seat without taking it off
 * the crew, the team card shows it with what the seat is doing and spending,
 * a change is audited and takes effect on the next tick, and the MCP `crew`
 * tool sets the same numbers.
 */
import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { commitToBranch, createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import {} from "../src/core/agents.ts";
import { crewNow } from "../src/actions/crew_now.ts";
import { reviewSays } from "../src/crew/review_says.ts";
import { askLinesFor } from "../src/web/studio/asks.ts";
import { getPull } from "../src/core/pulls.ts";
import { reviewWaits, waitLine } from "../src/actions/owner_waits.ts";
import { checkAutonomy, getRepoById, type Repo } from "../src/core/repos.ts";
import { openPull } from "../src/actions/pulls.ts";
import type { Pull } from "../src/core/pulls.ts";
import { claimRun, createRun, finishRun, listRuns } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { driveRepo } from "../src/crew/autonomy.ts";
import { checkSeatSlots, seatSlotsOf, seatSlotsWords } from "../src/crew/seat_slots.ts";
import { sendToReview } from "../src/crew/review.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { mcpTool } from "./helpers/mcp.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();
setDefaultTimeout(30_000);

const PASSWORD = "a-long-crew-passphrase";
let dataDir = "";
let app: App;
let servers: Servers;
let alice: User;
let repo: Repo;
let cookie = "";
let admin = "";
let agentTok = "";

const fresh = () => getRepoById(app.db, repo.id)!;
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const seat = (role: string) => seatSlotsOf(app.db, fresh()).find((s) => s.role === role)!;
const post = (body: Record<string, string>, who = cookie) =>
  fetch(`${servers.url}/alice/yard/settings/pillars`, {
    method: "POST",
    headers: { origin: servers.url, cookie: who },
    body: new URLSearchParams(body),
    redirect: "manual",
  });
const crew = (token: string, args: Record<string, unknown>) =>
  mcpTool(servers.url, token, "crew", { repo: "alice/yard", ...args });
const trail = () =>
  app.db
    .query<{ payload: string }, [string]>("SELECT payload FROM event WHERE kind = 'repo.settings_updated' AND repo_id = ?1 ORDER BY rowid")
    .all(repo.id)
    .map((e) => JSON.parse(e.payload).changed as Record<string, { from: unknown; to: unknown }>);

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-seat-slots-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  alice = ok(await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: PASSWORD, adminIfFirst: true }));
  proveAll(app);
  for (const name of ["mason", "atlas", "judge"]) ok(await createAgent(app, alice, { username: name, roles: ["planner", "builder", "reviewer"] }));
  repo = ok(await createRepo(app, alice, { name: "yard", visibility: "public" }));
  ok(await commitToBranch(app, alice, repo, { message: "Start", files: [{ path: "README.md", content: "# yard\n" }] }));
  for (const name of ["mason", "atlas", "judge"]) expect(addToCrew(app, alice, repo, name, "builder").ok).toBe(true);
  const id = (n: string) => getUserByName(app.db, n)!.id;
  seatAs(app.db, repo.id, id("atlas"), "planner");
  seatAs(app.db, repo.id, id("judge"), "reviewer");
  ok(await updateRepoSettings(app, alice, repo, { autonomy: "autonomous", requireReview: true, autonomyDirection: "Make the yard rounder.", autonomyCeilingUsd: 10, autonomySlots: 2, autonomyBy: alice.id }));
  const res = await fetch(`${servers.url}/signin`, { method: "POST", body: new URLSearchParams({ username: "alice", password: PASSWORD }), redirect: "manual" });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  admin = createToken(app.db, alice.id, "admin", "admin").token;
  agentTok = createToken(app.db, id("atlas"), "admin", "admin").token;
});

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the numbers are whole, 0 to 8, the planner 0 or 1", () => {
  expect(checkSeatSlots("builder", "0")).toEqual({ role: "builder", slots: 0 });
  expect(checkSeatSlots("reviewer", "8")).toEqual({ role: "reviewer", slots: 8 });
  expect(checkSeatSlots("planner", 1)).toEqual({ role: "planner", slots: 1 });
  for (const [role, slots] of [["planner", "2"], ["builder", "9"], ["builder", "-1"], ["builder", "1.5"], ["builder", ""], ["janitor", "1"], ["builder", "1e1"]] as const)
    expect(checkSeatSlots(role, slots)).toBeUndefined();
});

test("each seat shows what it is doing and spending, and its share", () => {
  const run = createRun(app.db, { repoId: repo.id, kind: "agent", actorId: getUserByName(app.db, "mason")!.id, reason: "assigned" });
  claimRun(app.db, run.id);
  finishRun(app.db, run.id, { state: "ok", summary: "", costUsd: 0.75 });
  const plan = createRun(app.db, { repoId: repo.id, kind: "agent", actorId: getUserByName(app.db, "atlas")!.id, reason: "assigned" });
  claimRun(app.db, plan.id);
  finishRun(app.db, plan.id, { state: "ok", summary: "", costUsd: 0.25 });
  const queued = createRun(app.db, { repoId: repo.id, kind: "agent", actorId: getUserByName(app.db, "mason")!.id, reason: "assigned" });
  expect(queued.id).toBeTruthy();
  expect(seat("builder")).toMatchObject({ slots: 2, waiting: 1, spentUsd: 0.75, sharePct: 75 });
  expect(seat("planner")).toMatchObject({ slots: 1, spentUsd: 0.25, sharePct: 25 });
  expect(seat("reviewer")).toMatchObject({ running: 0, spentUsd: 0, sharePct: 0 });
  expect(seatSlotsWords(seat("builder"))).toBe("0 running, 1 waiting. $0.75 today, 75% of the spend.");
  expect(seatSlotsWords(seat("reviewer"))).toBe("Idle. Nothing spent today.");
  app.db.query("UPDATE run SET state = 'cancelled' WHERE state = 'queued'").run();
});

test("the team card has a number for each seat, for an admin only", async () => {
  const html = await (await fetch(`${servers.url}/alice/yard/settings`, { headers: { cookie } })).text();
  for (const role of ["planner", "builder", "reviewer"]) expect(html).toContain(`id="f-seat-${role}"`);
  expect(html).toContain('data-slots="builder"');
  expect(html).toContain("$0.75 today, 75% of the spend.");
  expect(html).not.toContain('label: "Slots"');
  expect(html).not.toContain('name="slots" type="number" min="1"');
  const guest = await (await fetch(`${servers.url}/alice/yard/settings`)).text();
  expect(guest).not.toContain("f-seat-planner");
});

test("a paused planner is not asked, and is still on the crew; raising it asks again", async () => {
  const res = await post({ seat: "planner", slots: "0" });
  expect(res.status).toBe(303);
  expect(fresh().plannerSlots).toBe(0);
  expect(seat("planner").slots).toBe(0);
  expect(await driveRepo(app, fresh())).not.toBe("planned");
  expect(getUserByName(app.db, "atlas")).toBeDefined();
  const html = await (await fetch(`${servers.url}/alice/yard/settings`, { headers: { cookie } })).text();
  expect(html).toContain("Paused");
  expect((await post({ seat: "planner", slots: "1" })).status).toBe(303);
  expect(await driveRepo(app, fresh())).toBe("planned");
});

test("a paused reviewer sends nothing, so an agent's pull waits for a person", async () => {
  ok(await updateRepoSettings(app, alice, fresh(), { reviewerSlots: 0 }));
  const pull = { id: "none-such" } as never;
  expect(await sendToReview(app, fresh(), pull)).toBe("none");
});

test("a bad number or a stranger changes nothing; each change is on the trail", async () => {
  const before = trail().length;
  await post({ seat: "builder", slots: "99" });
  await post({ seat: "planner", slots: "2" });
  const guest = await fetch(`${servers.url}/alice/yard/settings/pillars`, { method: "POST", headers: { origin: servers.url }, body: new URLSearchParams({ seat: "builder", slots: "0" }), redirect: "manual" });
  expect(guest.status).not.toBe(303);
  const cross = await fetch(`${servers.url}/alice/yard/settings/pillars`, { method: "POST", headers: { origin: "https://evil.example", cookie }, body: new URLSearchParams({ seat: "builder", slots: "0" }), redirect: "manual" });
  expect(cross.status).toBeGreaterThanOrEqual(400);
  expect(fresh().autonomySlots).toBe(2);
  expect(trail().length).toBe(before);
  await post({ seat: "builder", slots: "0" });
  expect(fresh().autonomySlots).toBe(0);
  expect(trail().at(-1)).toEqual({ autonomySlots: { from: 2, to: 0 } });
  await post({ seat: "builder", slots: "2" });
});

test("a builder set to none starts nothing, and the On its own form keeps the slots it did not send", async () => {
  await post({ seat: "builder", slots: "0" });
  const form = await fetch(`${servers.url}/alice/yard/settings/autonomy`, {
    method: "POST",
    headers: { origin: servers.url, cookie },
    body: new URLSearchParams({ autonomy: "assisted", ceiling: "7", direction: "Make the yard rounder." }),
    redirect: "manual",
  });
  expect(form.status).toBe(303);
  // The form really saved (a refusal is a 303 too): mode and ceiling moved, the 0 stayed.
  expect(fresh()).toMatchObject({ autonomy: "assisted", autonomyCeilingUsd: 7, autonomySlots: 0 });
  expect(checkAutonomy("assisted", 7, 0).ok).toBe(true);
  expect(await driveRepo(app, fresh())).not.toBe("picked");
  await post({ seat: "builder", slots: "2" });
  ok(await updateRepoSettings(app, alice, fresh(), { autonomy: "autonomous", autonomyCeilingUsd: 10 }));
});

test("a paused reviewer is said to be paused in what waits for the owner", () => {
  app.db.query("UPDATE repo SET reviewer_slots = 0 WHERE id = ?1").run(repo.id);
  const w = reviewWaits(app.db, [fresh()]);
  expect(w).toHaveLength(1);
  expect(w[0]).toMatchObject({ kind: "review", paused: true });
  expect(waitLine(w[0]!)).toContain("the reviewer is paused");
  app.db.query("UPDATE repo SET reviewer_slots = 8 WHERE id = ?1").run(repo.id);
});

test("a lapsed review says why on the now list, the MCP and the asks: paused, unanswered, or no reviewer", async () => {
  // A green agent pull, its check long done, one review sent and never answered.
  const mason = getUserByName(app.db, "mason")!;
  ok(await commitToBranch(app, alice, fresh(), { branch: "feature/lapse", base: "main", message: "lapse", files: [{ path: "lapse.ts", content: "export const n = 1;\n" }] }));
  const opened = ok(await openPull(app, alice, fresh(), { title: "lapse", baseBranch: "main", headBranch: "feature/lapse" }));
  app.db.query("UPDATE issue SET author_id = ?2 WHERE id = ?1").run(opened.id, mason.id);
  const pull = getPull(app.db, repo.id, opened.number)!;
  const check = createRun(app.db, { repoId: repo.id, kind: "check", issueId: pull.id, env: `pull-${pull.number}`, commitOid: pull.headOid, reason: "pull" });
  claimRun(app.db, check.id);
  finishRun(app.db, check.id, { state: "ok", summary: "green" });
  app.db.query("INSERT OR IGNORE INTO app (id, repo_id, slug, access, preview_data) VALUES (?1, ?2, 'yard', 'public', 'copy')").run(`app-${repo.id}`, repo.id);
  ok(await updateRepoSettings(app, alice, fresh(), { reviewerSlots: 8 }));
  expect(await sendToReview(app, fresh(), getPull(app.db, repo.id, pull.number)!)).toBe("sent");
  for (const run of app.db.query<{ id: string }, [string]>("SELECT id FROM run WHERE issue_id = ?1 AND reason = 'review' AND state = 'queued'").all(pull.id)) {
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "failed", summary: "reviewed: no verdict was posted" });
  }
  const old = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
  app.db.query("UPDATE run SET created_at = ?2, finished_at = ?2 WHERE issue_id = ?1").run(pull.id, old);
  app.db.query("UPDATE issue SET author_id = ?2 WHERE id = ?1").run(pull.id, mason.id);

  const says = async () => {
    const rows = crewNow({ app } as never, alice).flatMap((r) => (r.why === "review" && "says" in r ? [r] : []));
    expect(rows).toHaveLength(1);
    const viaMcp = (await mcpTool(servers.url, admin, "now", {})).value as { why: string; says?: string }[];
    expect(viaMcp.find((r) => r.why === "review")?.says).toBe(rows[0]!.says);
    const ask = askLinesFor(app.db, alice).find((l) => l.id === `review:${pull.id}`);
    return { now: rows[0]!.says, ask: ask?.line ?? "" };
  };
  const judge = getUserByName(app.db, "judge")!;

  const live = await says();
  expect(live.now).toBe("the reviewer did not answer");
  expect(live.ask).toContain("the reviewer did not answer");

  app.db.query("UPDATE repo SET reviewer_slots = 0 WHERE id = ?1").run(repo.id);
  const paused = await says();
  expect(paused.now).toBe("the reviewer is paused");
  expect(paused.ask).toContain("the reviewer is paused");
  app.db.query("UPDATE repo SET reviewer_slots = 8 WHERE id = ?1").run(repo.id);

  seatAs(app.db, repo.id, judge.id, "builder");
  const none = await says();
  expect(none.now).toBe("no reviewer on the crew");
  expect(none.ask).toContain("no reviewer on the crew");
  seatAs(app.db, repo.id, judge.id, "reviewer");
});

test("three change requests are worded as such, never as an empty crew", () => {
  const rounds = { why: "rounds", since: "2026-10-01T00:00:00Z" } as const;
  expect(reviewSays(rounds, false)).toBe("the reviewer asked for changes three times");
  expect(reviewSays(rounds, true)).toBe("the reviewer asked for changes three times");
});

test("over the MCP: read, plan, apply, and refuse an agent or a bad number", async () => {
  const read = await crew(admin, {});
  expect(read.value.slots.map((s: { role: string }) => s.role)).toEqual(["planner", "builder", "reviewer"]);
  const plan = await crew(admin, { seat: "reviewer", slots: 3 });
  expect(plan.value).toMatchObject({ from: 8, to: 3, changes: true });
  expect(plan.value.says).toContain("nothing changed");
  expect(fresh().reviewerSlots).toBe(8);
  const done = await crew(admin, { seat: "reviewer", slots: 3, dryRun: false });
  expect(done.value).toMatchObject({ changed: true, to: 3 });
  expect(fresh().reviewerSlots).toBe(3);
  expect(trail().at(-1)).toEqual({ reviewerSlots: { from: 8, to: 3 } });
  expect((await crew(admin, { seat: "planner", slots: 2 })).error).toContain("invalid");
  expect((await crew(admin, { seat: "reviewer" })).error).toContain("invalid");
  expect((await crew(admin, { seat: "reviewer", slots: 1, add: "mason" })).error).toContain("invalid");
  expect((await crew(agentTok, { seat: "reviewer", slots: 1, dryRun: false })).error).toContain("forbidden");
  expect(fresh().reviewerSlots).toBe(3);
});

test("the reviewer's cap counts the reviews in flight on this repository only", async () => {
  const { reviewsInFlight } = await import("../src/crew/review.ts");
  const before = reviewsInFlight(app.db, repo.id);
  createRun(app.db, { repoId: repo.id, kind: "agent", actorId: getUserByName(app.db, "judge")!.id, reason: "review" });
  expect(reviewsInFlight(app.db, repo.id)).toBe(before + 1);
  expect(reviewsInFlight(app.db, "other-repo")).toBe(0);
});

describe("the reviewer's cap, end to end (#8734)", () => {
  let porch: Repo;
  let n = 0;
  const now = new Date();
  const porchNow = () => getRepoById(app.db, porch.id)!;
  const reviews = (pull: Pull) => listRuns(app.db, porch.id, { issueId: pull.id }).filter((r) => r.reason === "review");
  // A green agent pull: its check went green a minute before `now`, so review is due.
  const agentPull = async (): Promise<Pull> => {
    const branch = `cap${++n}`;
    ok(await commitToBranch(app, alice, porch, { branch, base: "main", message: branch, files: [{ path: `${branch}.md`, content: "x\n" }] }));
    const pull = ok(await openPull(app, alice, porch, { title: branch, body: "", baseBranch: "main", headBranch: branch }));
    const run = createRun(app.db, { repoId: porch.id, kind: "check", issueId: pull.id, env: `pull-${pull.number}`, commitOid: pull.headOid, reason: "pull" });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "ok" });
    const green = new Date(now.getTime() - 60_000).toISOString();
    app.db.query("UPDATE run SET created_at = ?2, finished_at = ?2 WHERE id = ?1").run(run.id, green);
    return { ...pull, authorIsAgent: true };
  };

  beforeAll(async () => {
    porch = ok(await createRepo(app, alice, { name: "porch", visibility: "private" }));
    ok(await commitToBranch(app, alice, porch, { message: "Start", files: [{ path: "README.md", content: "# porch\n" }] }));
    expect(addToCrew(app, alice, porch, "judge", "builder").ok).toBe(true);
    seatAs(app.db, porch.id, getUserByName(app.db, "judge")!.id, "reviewer");
  });

  test("at 1, the second agent pull is queued only after the first review ends", async () => {
    ok(await updateRepoSettings(app, alice, porchNow(), { reviewerSlots: 1 }));
    // A review queued on another repository takes none of this one's slot.
    createRun(app.db, { repoId: repo.id, kind: "agent", actorId: getUserByName(app.db, "judge")!.id, reason: "review" });
    const first = await agentPull();
    const second = await agentPull();
    expect(await sendToReview(app, porchNow(), first, now)).toBe("sent");
    expect(await sendToReview(app, porchNow(), second, now)).toBe("wait");
    expect(reviews(first)).toHaveLength(1);
    expect(reviews(second)).toHaveLength(0);
    // Running still holds the slot.
    const run = reviews(first)[0]!;
    claimRun(app.db, run.id);
    expect(await sendToReview(app, porchNow(), second, now)).toBe("wait");
    finishRun(app.db, run.id, { state: "ok", summary: "", costUsd: 0 });
    expect(await sendToReview(app, porchNow(), second, now)).toBe("sent");
    expect(reviews(second)).toHaveLength(1);
    app.db.query("UPDATE run SET state = 'cancelled' WHERE state = 'queued'").run();
  });

  test("at 0, neither agent pull is queued: both wait for a person", async () => {
    ok(await updateRepoSettings(app, alice, porchNow(), { reviewerSlots: 0 }));
    const a = await agentPull();
    const b = await agentPull();
    expect(await sendToReview(app, porchNow(), a, now)).toBe("none");
    expect(await sendToReview(app, porchNow(), b, now)).toBe("none");
    expect(reviews(a)).toHaveLength(0);
    expect(reviews(b)).toHaveLength(0);
  });
});
