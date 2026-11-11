/** Agent runs the dispatcher holds on purpose are not a stalled queue (#9403). */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { startCrew } from "../src/crew/dispatch.ts";
import { turnValve } from "../src/flow/valve_store.ts";
import { serve } from "../src/http/server.ts";
import { HELD_FRESH_MS, heldRuns, noteHeld } from "../src/runs/held.ts";
import { QUEUE_WAIT_MAX_MS, vitals } from "../src/kernel/vitals.ts";

let dataDir: string;
let app: App;
let repoId = "";
let ownerId = "";
const roomy = () => ({ freeBytes: 100, totalBytes: 100 });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-vitals-held-"));
  app = createApp({ dataDir, port: 0, disk: roomy });
  const owner = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "holder",
    email: "holder@forge.local",
    password: "a-good-passphrase",
  });
  if (!owner.ok) throw new Error(String(owner.error));
  ownerId = owner.value.id;
  repoId = crypto.randomUUID();
  app.db
    .query("INSERT INTO repo (id, owner_id, name, visibility, created_at) VALUES (?1, ?2, 'held', 'private', ?3)")
    .run(repoId, owner.value.id, new Date().toISOString());
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const agentQueue = (now: number) =>
  vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy, now }).degraded.find((d) => d.cause === "queue:agent");

test("a pass's holds are read while fresh, and forgotten once the dispatcher goes quiet", () => {
  const at = Date.now();
  noteHeld(app.db, new Map([["r1", "pace"]]), at);
  expect(heldRuns(app.db, at + 1000).get("r1")).toBe("pace");
  expect(heldRuns(app.db, at + HELD_FRESH_MS + 1).size).toBe(0);
  noteHeld(app.db, new Map(), at);
  expect(heldRuns(app.db, at).size).toBe(0);
});

test("queue:agent leaves out the runs the dispatcher holds, and names them", () => {
  app.db.query("DELETE FROM run").run();
  const a = createRun(app.db, { repoId, kind: "agent" });
  const b = createRun(app.db, { repoId, kind: "agent" });
  const later = Date.now() + 2 * QUEUE_WAIT_MAX_MS;

  // Nothing said: both wait, as before.
  noteHeld(app.db, new Map(), later);
  expect(agentQueue(later)?.sentence).toContain("2 queued, 0 of");

  // Every queued run held by policy: no stalled queue to report.
  noteHeld(app.db, new Map([[a.id, "pace"], [b.id, "limit"]]), later);
  expect(agentQueue(later)).toBeUndefined();

  // One held, one free: the free one is the queue, the held one is named.
  noteHeld(app.db, new Map([[a.id, "pace"]]), later);
  const one = agentQueue(later);
  expect(one?.sentence).toContain("1 queued, 0 of");
  expect(one?.sentence).toContain("held on purpose: 1 by the week's pace.");
  expect(one?.since).toBe(new Date(b.createdAt).toISOString());

  // A dispatcher that stopped cannot hide its queue behind its last pass.
  noteHeld(app.db, new Map([[a.id, "pace"], [b.id, "pace"]]), later - HELD_FRESH_MS - 1);
  expect(agentQueue(later)?.sentence).toContain("2 queued, 0 of");
});

test("the held count is grouped by cause, and counts only the held runs still queued", () => {
  app.db.query("DELETE FROM run").run();
  const runs = Array.from({ length: 5 }, () => createRun(app.db, { repoId, kind: "agent" }));
  const later = Date.now() + 2 * QUEUE_WAIT_MAX_MS;
  const [a, b, c] = runs.map((r) => r.id) as [string, string, string];
  // `gone` is held but no longer queued: it must not be counted.
  noteHeld(app.db, new Map([[a, "valve"], [b, "valve"], [c, "limit"], ["gone", "pace"]]), later);
  const sentence = agentQueue(later)?.sentence ?? "";
  expect(sentence).toContain("2 queued, 0 of");
  expect(sentence).toContain("held on purpose: 2 by a shut valve, 1 by an account limit.");
  expect(sentence).not.toContain("pace");
});

test("past 500 queued, the held count and the waiting count are exact", () => {
  app.db.query("DELETE FROM run").run();
  const ids = Array.from({ length: 620 }, () => createRun(app.db, { repoId, kind: "agent" }).id);
  const later = Date.now() + 2 * QUEUE_WAIT_MAX_MS;
  noteHeld(app.db, new Map(ids.slice(0, 600).map((id) => [id, "pace" as const])), later);
  const sentence = agentQueue(later)?.sentence ?? "";
  expect(sentence).toContain("20 queued, 0 of");
  expect(sentence).toContain("held on purpose: 600 by the week's pace.");
});

test("with the real dispatcher, every queued run held is quiet while the pass is fresh, and reports once it goes stale", async () => {
  app.db.query("DELETE FROM run").run();
  const servers = await serve(app);
  const fake = join(dataDir, "fake-claude");
  writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi\nexit 1\n`);
  chmodSync(fake, 0o755);
  turnValve(app.db, repoId, 0, ownerId);
  const a = createRun(app.db, { repoId, kind: "agent" });
  const b = createRun(app.db, { repoId, kind: "agent" });
  const hourAgo = new Date(Date.now() - 2 * QUEUE_WAIT_MAX_MS).toISOString();
  app.db.query("UPDATE run SET created_at = ?1 WHERE id IN (?2, ?3)").run(hourAgo, a.id, b.id);
  const crew = await startCrew(app, {
    forgeUrl: servers.url,
    localUrl: servers.url,
    binary: fake,
    concurrency: 2,
    budgetUsd: 1,
    runTimeoutMs: 60_000,
    tickMs: 20,
  });
  try {
    const deadline = Date.now() + 10_000;
    while (heldRuns(app.db).get(b.id) !== "valve" && Date.now() < deadline) await Bun.sleep(20);
    expect(heldRuns(app.db).get(a.id)).toBe("valve");
    expect(heldRuns(app.db).get(b.id)).toBe("valve");
    await crew.stop();
    const now = Date.now();
    expect(agentQueue(now)).toBeUndefined();
    expect(agentQueue(now + HELD_FRESH_MS + 1_000)?.sentence).toContain("2 queued, 0 of");
  } finally {
    await crew.stop();
    servers.stop();
  }
});

test("with the real dispatcher, a run queued behind its issue's running run is held, named, and not a stalled queue", async () => {
  app.db.query("DELETE FROM run").run();
  const servers = await serve(app);
  const fake = join(dataDir, "fake-claude-2");
  writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi\nexit 1\n`);
  chmodSync(fake, 0o755);
  // The previous test shut the valve; open it fully, so only the issue holds the sibling.
  app.db.query("DELETE FROM flow_valve WHERE repo_id = ?1").run(repoId);
  const issueId = crypto.randomUUID();
  app.db
    .query("INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, 7, 'issue', 'T', '', ?3, 'open', ?4)")
    .run(issueId, repoId, ownerId, new Date().toISOString());
  const running = createRun(app.db, { repoId, kind: "agent", issueId });
  // An unrelated run ahead of the sibling: the pass stops at it (no slot) and must still mark the sibling behind it.
  const ahead = createRun(app.db, { repoId, kind: "agent" });
  const sibling = createRun(app.db, { repoId, kind: "agent", issueId });
  const hourAgo = new Date(Date.now() - 2 * QUEUE_WAIT_MAX_MS).toISOString();
  const earlier = new Date(Date.now() - 3 * QUEUE_WAIT_MAX_MS).toISOString();
  app.db.query("UPDATE run SET created_at = ?1 WHERE id = ?2").run(hourAgo, sibling.id);
  app.db.query("UPDATE run SET created_at = ?1 WHERE id = ?2").run(earlier, ahead.id);
  app.db
    .query("UPDATE run SET state = 'running', started_at = ?1, heartbeat_at = ?1, created_at = ?1 WHERE id = ?2")
    .run(new Date().toISOString(), running.id);
  const crew = await startCrew(app, {
    forgeUrl: servers.url,
    localUrl: servers.url,
    binary: fake,
    concurrency: 1,
    budgetUsd: 1,
    runTimeoutMs: 60_000,
    // No tick inside the test: the pass read below is the one startCrew runs
    // before it returns, so nothing on a timer (the autonomy sweep, a slow
    // shard) can race it.
    tickMs: 600_000,
  });
  try {
    // Every slot is taken (1 of 1), and the sibling is still marked.
    expect(heldRuns(app.db).get(sibling.id)).toBe("issue");
    await crew.stop();
    const now = Date.now();
    // The unrelated run waits for a slot and is the queue; the sibling is named, not counted.
    const sentence = agentQueue(now)?.sentence ?? "";
    expect(sentence).toContain("1 queued, 1 of 1 slots running");
    expect(sentence).toContain("held on purpose: 1 by its own issue's run still going.");
  } finally {
    await crew.stop();
    servers.stop();
  }
});
