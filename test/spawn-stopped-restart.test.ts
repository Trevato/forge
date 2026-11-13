/**
 * A child forge the host stopped for memory is started again within a minute, even when the
 * host's awake ceiling is full of forges nobody is using; its pages say when it will be back;
 * the backoff doubles to ten minutes and starts again after thirty clean ones; and its crew's
 * interrupted run is queued again once, and failed with the reason the second time.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { childDirOf } from "../src/actions/spawn.ts";
import { createApp } from "../src/app.ts";
import { claimRun, createRun, getRun, listActive } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { MEMORY_OUT, MEMORY_REQUEUED, requeueInterrupted } from "../src/crew/dispatch.ts";
import { STALE_AFTER_MS } from "../src/runs/lease.ts";
import { cellChildren, type CellChild } from "../src/spawn/cell.ts";
import { closeHostedChildren, sleepIdleChildren } from "../src/spawn/host.ts";
import { backoffMs, CLEAN_MS, cancelRestarts, lastStop, markStopped, noteStop, RESTART_MAX_MS, stopSentence } from "../src/spawn/stopped.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const tmp = mkdtempSync(join(tmpdir(), "spawn-stopped-restart-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("the wait doubles from 5 s to a ceiling of 10 minutes", () => {
  expect([1, 2, 3, 4, 8, 9, 20].map(backoffMs)).toEqual([5_000, 10_000, 20_000, 40_000, 600_000, 600_000, 600_000]);
  expect(RESTART_MAX_MS).toBe(10 * 60_000);
});

test("thirty clean minutes start the count again; less keeps it", () => {
  const parent = {} as import("../src/app.ts").App;
  const at = Date.parse("2026-11-13T10:23:00Z");
  expect(noteStop(parent, "b", "k", "memory", at, 60_000).stops).toBe(1);
  expect(noteStop(parent, "b", "k", "memory", at + CLEAN_MS - 1, 60_000).stops).toBe(2);
  expect(noteStop(parent, "b", "k", "memory", at + 2 * CLEAN_MS, 60_000).stops).toBe(1);
  cancelRestarts(parent);
});

test("the page says when the forge will be back", () => {
  const parent = {} as import("../src/app.ts").App;
  const at = Date.parse("2026-11-13T10:23:00Z");
  const stop = noteStop(parent, "b", "k", "used 2374 MiB of memory", at, 5 * 60_000);
  expect(stop.backAt).toBe(at + 5 * 60_000);
  expect(stopSentence(stop, at)).toBe("This forge ran out of memory and was stopped at 10:23 UTC; the host starts it again at 10:28 UTC.");
  expect(stopSentence(stop, at + 5 * 60_000 - 30_000)).toContain("within a minute");
  cancelRestarts(parent);
});

test("a stopped forge is started again at once when the ceiling is full of forges nobody is using", async () => {
  const prior = process.env["FORGE_CHILD_AWAKE_MAX"];
  process.env["FORGE_CHILD_AWAKE_MAX"] = "1";
  const dataDir = join(tmp, "host");
  mkdirSync(join(dataDir, "spawn"), { recursive: true });
  writeFileSync(join(dataDir, "spawn", "kid.json"), JSON.stringify({ name: "kid", bodyId: "cell-kid", size: "small", done: true, placement: "cell" }));
  const parent = createApp({ dataDir, url: "https://f.test" });
  const kidDir = childDirOf(parent, "cell-kid");
  const child = createApp({ dataDir: kidDir, url: "https://kid--f.test" });
  child.db.exec("PRAGMA foreign_keys = OFF");
  createRun(child.db, { repoId: "repo", kind: "agent", notBefore: new Date(Date.now() + 100).toISOString(), attempt: 1 });
  child.close();
  const awake = new Set<string>();
  const starts: string[] = [];
  const cells = cellChildren(parent);
  let mode: "arm" | "evict" = "arm";
  const fake = (id: string) => ({ bodyId: id, name: id, port: 1 }) as unknown as CellChild;
  cells.list = () => [...awake].map(fake);
  cells.get = (id) => (awake.has(id) ? fake(id) : undefined);
  cells.start = async (input) => {
    starts.push(input.name);
    awake.add(input.bodyId);
    return fake(input.bodyId);
  };
  cells.sleepIdle = async () => {
    if (mode === "arm") return ["kid"];
    const gone = [...awake].filter((id) => id !== "cell-kid");
    for (const id of gone) awake.delete(id);
    return gone;
  };
  try {
    // The first start is a due run's, which is also what tells the host how to restart a stopped forge.
    await sleepIdleChildren(parent, 0);
    for (let i = 0; i < 100 && starts.length === 0; i++) await Bun.sleep(50);
    expect(starts).toEqual(["kid"]);
    // It dies of memory while another forge, quiet and with no crew at work, holds the only slot.
    awake.delete("cell-kid");
    awake.add("cell-idle");
    mode = "evict";
    noteStop(parent, "cell-kid", "kid", "used 3000 MiB of memory, over its 2048 MiB limit", Date.now(), 10);
    for (let i = 0; i < 100 && starts.length < 2; i++) await Bun.sleep(20);
    expect(starts).toEqual(["kid", "kid"]);
    expect(awake.has("cell-idle")).toBe(false);
  } finally {
    cancelRestarts(parent);
    closeHostedChildren(parent);
    parent.close();
    if (prior === undefined) delete process.env["FORGE_CHILD_AWAKE_MAX"];
    else process.env["FORGE_CHILD_AWAKE_MAX"] = prior;
  }
}, 20_000);

test("a restart turned away for room says the time it will try again", async () => {
  const prior = process.env["FORGE_CHILD_AWAKE_MAX"];
  process.env["FORGE_CHILD_AWAKE_MAX"] = "1";
  const dataDir = join(tmp, "full");
  mkdirSync(join(dataDir, "spawn"), { recursive: true });
  writeFileSync(join(dataDir, "spawn", "kid.json"), JSON.stringify({ name: "kid", bodyId: "cell-kid", size: "small", done: true, placement: "cell" }));
  const parent = createApp({ dataDir, url: "https://f.test" });
  const kidDir = childDirOf(parent, "cell-kid");
  const child = createApp({ dataDir: kidDir, url: "https://kid--f.test" });
  child.db.exec("PRAGMA foreign_keys = OFF");
  createRun(child.db, { repoId: "repo", kind: "agent", notBefore: new Date(Date.now() + 50).toISOString(), attempt: 1 });
  child.close();
  const awake = new Set<string>();
  const starts: string[] = [];
  const cells = cellChildren(parent);
  const fake = (id: string) => ({ bodyId: id, name: id, port: 1 }) as unknown as CellChild;
  cells.list = () => [...awake].map(fake);
  cells.get = (id) => (awake.has(id) ? fake(id) : undefined);
  cells.start = async (input) => (starts.push(input.name), awake.add(input.bodyId), fake(input.bodyId));
  let arm = true;
  // A forge that is busy is not put to sleep: nothing is freed.
  cells.sleepIdle = async () => (arm ? ["kid"] : []);
  try {
    await sleepIdleChildren(parent, 0);
    for (let i = 0; i < 100 && starts.length === 0; i++) await Bun.sleep(50);
    awake.delete("cell-kid");
    awake.add("cell-busy");
    arm = false;
    const before = Date.now();
    noteStop(parent, "cell-kid", "kid", "used 3000 MiB of memory", before, 10);
    await Bun.sleep(300);
    expect(starts).toEqual(["kid"]);
    const stop = lastStop(parent, "cell-kid")!;
    expect(stop.backAt).toBeGreaterThanOrEqual(before + 59_000);
    expect(stopSentence(stop, before + 1_000)).toMatch(/starts it again (at \d\d:\d\d UTC|within a minute)\./);
  } finally {
    cancelRestarts(parent);
    closeHostedChildren(parent);
    parent.close();
    if (prior === undefined) delete process.env["FORGE_CHILD_AWAKE_MAX"];
    else process.env["FORGE_CHILD_AWAKE_MAX"] = prior;
  }
}, 20_000);

test("a run the host cut off for memory is queued again once, and failed with the reason the second time", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "memory-requeue-"));
  const app = createApp({ dataDir, port: 0 });
  try {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!made.ok) throw new Error(made.error);
    const alice: User = made.value;
    const agent = await createAgent(app, alice, { username: "bot" });
    if (!agent.ok) throw new Error(String(agent.error));
    const repo = await createRepo(app, alice, { name: "page", visibility: "private" });
    if (!repo.ok) throw new Error(String(repo.error));
    expect(addToCrew(app, alice, repo.value, "bot").ok).toBe(true);
    const issue = openIssue(app, alice, repo.value, { title: "A page that says hello", body: "" });
    if (!issue.ok) throw new Error(String(issue.error));
    const run = createRun(app.db, { repoId: repo.value.id, kind: "agent", issueId: issue.value.id, actorId: agent.value.user.id, reason: "assigned" });
    const lapse = (id: string) => {
      claimRun(app.db, id);
      const lease = Date.now() - STALE_AFTER_MS - 5_000;
      app.db.query("UPDATE run SET heartbeat_at = ?2 WHERE id = ?1").run(id, new Date(lease).toISOString());
      markStopped(dataDir, { at: lease + 4_000, why: "used 2374 MiB of memory, over its 2048 MiB limit" });
    };
    const queued = () => listActive(app.db, "agent").filter((r) => r.state === "queued" && r.issueId === issue.value.id);
    lapse(run.id);
    requeueInterrupted(app);
    expect(getRun(app.db, run.id)!.state).toBe("cancelled");
    expect(queued()).toHaveLength(1);
    expect(queued()[0]!.summary).toStartWith(MEMORY_REQUEUED);
    // Started again, stopped for memory again: not another try.
    const second = queued()[0]!;
    lapse(second.id);
    requeueInterrupted(app);
    expect(getRun(app.db, second.id)).toMatchObject({ state: "failed", summary: MEMORY_OUT });
    expect(queued()).toHaveLength(0);
  } finally {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
