/**
 * The crew's tick never takes the process down (#9977): a tick whose
 * database refuses it is logged, and the next tick does its work. Thrown
 * from the timer, the error would be uncaught: a forge would fall over,
 * and a test shard would exit without naming a test.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { claimRun, createRun, getRun } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { startCrew, type CrewHandle } from "../src/crew/dispatch.ts";

let dataDir: string;
let app: App;
let crew: CrewHandle;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-crew-tick-"));
  app = createApp({ dataDir, port: 0 });
  crew = await startCrew(app, {
    forgeUrl: "http://127.0.0.1:9",
    localUrl: "http://127.0.0.1:9",
    binary: join(dataDir, "no-claude-here"),
    concurrency: 0,
    budgetUsd: 1,
    runTimeoutMs: 60_000,
    tickMs: 20,
  });
});

afterAll(async () => {
  await crew.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a tick that throws is logged, and the next tick still does its work", async () => {
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!a.ok) throw new Error(a.error);
  const made = await createRepo(app, a.value, { name: "ticks", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  // A run a dead forge left running: its lease lapsed a day ago, so every
  // tick's first step writes, to cancel it and queue its task again.
  const stale = createRun(app.db, { repoId: made.value.id, kind: "agent", reason: "push", actorId: a.value.id });
  claimRun(app.db, stale.id);
  const old = new Date(Date.now() - 86_400_000).toISOString();
  app.db.query("UPDATE run SET heartbeat_at = ?1, started_at = ?1 WHERE id = ?2").run(old, stale.id);
  // The database refuses every write: each tick throws on its first step.
  app.db.exec("PRAGMA query_only = ON");
  await Bun.sleep(200);
  app.db.exec("PRAGMA query_only = OFF");
  expect(getRun(app.db, stale.id)?.state).toBe("running");
  // The crew is still ticking: the lapsed run is put back on the queue.
  const deadline = Date.now() + 5_000;
  while (getRun(app.db, stale.id)?.state === "running" && Date.now() < deadline) await Bun.sleep(20);
  expect(getRun(app.db, stale.id)?.state).toBe("cancelled");
});
