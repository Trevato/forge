import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { migrations } from "../src/core/schema.ts";
import { listEvents } from "../src/core/events.ts";
import { countNotes } from "../src/maintain/keeper/record.ts";
import { openDb } from "../src/kernel/db.ts";
import { BATCH_ROWS, KEEP_MS, keptKind, pruneEvents, REST_MS } from "../src/system/retention_events.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function seeded(): Database {
  const db = openDb(":memory:", migrations);
  // Seeded rows name a repo and a webhook by id alone; the tables they point at are not under test.
  db.exec("PRAGMA foreign_keys = OFF");
  return db;
}

let n = 0;
function put(db: Database, kind: string, ageMs: number, repo: string | null = "r1", payload: Record<string, unknown> = {}): string {
  const id = `e${String(++n).padStart(8, "0")}`;
  db.query("INSERT INTO event (id, kind, repo_id, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").run(
    id, kind, repo, JSON.stringify(payload), iso(NOW - ageMs),
  );
  return id;
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("pruneEvents", () => {
  test("deletes old rows of windowed kinds; every named reader answers the same for its window", () => {
    const db = seeded();
    // Oldest first, as the log is written: old windowed rows, old kept rows, then newer rows.
    const oldWindowed = [put(db, "secret.read", KEEP_MS + 30 * DAY), put(db, "forge.spawn.live", KEEP_MS + 2 * DAY, null)];
    const oldPending = put(db, "run.finished", KEEP_MS + DAY);
    db.query("INSERT INTO webhook_delivery (id, webhook_id, event_id, state) VALUES ('d1', 'w1', ?1, 'pending')").run(oldPending);
    const oldDone = put(db, "run.started", KEEP_MS + DAY);
    db.query("INSERT INTO webhook_delivery (id, webhook_id, event_id, state) VALUES ('d2', 'w1', ?1, 'ok')").run(oldDone);
    put(db, "repo.detached", KEEP_MS + 20 * DAY);
    put(db, "user.created", KEEP_MS + 20 * DAY, null);
    put(db, "issue.closed", KEEP_MS + 10 * DAY, "r1", { number: 1, reason: "split" });
    put(db, "keeper_said", KEEP_MS + 10 * DAY, null, { key: "k1" });
    put(db, "push", KEEP_MS + 5 * DAY);
    const recent: string[] = [];
    for (let d = 170; d >= 0; d -= 10) recent.push(put(db, d % 20 === 0 ? "secret.read" : "issue.reopened", d * DAY, "r1", { number: d }));

    const cutoff = iso(NOW - KEEP_MS);
    const readers = () => ({
      // Feeds, the events page, the API, MCP and SSE replay all page `listEvents`:
      // their window is the rule.
      feed: ids(listEvents(db, { limit: 500 })).filter((id) => db.query("SELECT 1 FROM event WHERE id = ?1 AND created_at >= ?2").get(id, cutoff)),
      repoFeed: ids(listEvents(db, { repoId: "r1", limit: 50 })).filter((id) => db.query("SELECT 1 FROM event WHERE id = ?1 AND created_at >= ?2").get(id, cutoff)),
      replay: ids(listEvents(db, { afterId: recent[3]!, limit: 500 })),
      // estimate_base: reopened issues within 90 days.
      estimate: db.query("SELECT DISTINCT json_extract(payload, '$.number') AS n FROM event WHERE repo_id = 'r1' AND kind = 'issue.reopened' AND created_at >= ?1").all(iso(NOW - 90 * DAY)),
      // security: 30 days of repo.deleted; mail: 24 h.
      windowed: db.query("SELECT id FROM event WHERE created_at >= ?1 ORDER BY seq").all(cutoff),
      // At any age: fork_chain, accounts, core/issues splits, the keeper's once-said, last push.
      detached: db.query("SELECT 1 FROM event WHERE repo_id = 'r1' AND kind = 'repo.detached' LIMIT 1").get() !== null,
      created: db.query("SELECT COUNT(*) AS n FROM event WHERE kind = 'user.created'").get(),
      splits: db.query("SELECT COUNT(*) AS n FROM event WHERE kind = 'issue.closed' AND json_extract(payload, '$.reason') = 'split'").get(),
      said: countNotes(db, "keeper_said", "key", "k1"),
      lastPush: db.query("SELECT MAX(created_at) AS at FROM event WHERE repo_id = 'r1' AND kind = 'push'").get(),
    });
    const before = readers();
    expect(before.said).toBe(1);
    expect(before.detached).toBe(true);

    db.exec("PRAGMA foreign_keys = ON"); // deliveries cascade with their event, as in production
    const first = pruneEvents(db, NOW, BATCH_ROWS);
    expect(first).toMatchObject({ deleted: 3, more: false });
    expect(readers()).toEqual(before);
    for (const id of oldWindowed) expect(db.query("SELECT 1 FROM event WHERE id = ?1").get(id)).toBeNull();
    // A delivery still pending keeps its event; a finished one goes with it.
    expect(db.query("SELECT 1 FROM event WHERE id = ?1").get(oldPending)).not.toBeNull();
    expect(db.query("SELECT 1 FROM webhook_delivery WHERE id = 'd2'").get()).toBeNull();
  });

  test("walks in capped batches, then rests a day before the next pass", () => {
    const db = seeded();
    for (let i = 0; i < 25; i++) put(db, "secret.read", KEEP_MS + DAY);
    put(db, "secret.read", DAY);
    expect(pruneEvents(db, NOW, 10)).toMatchObject({ deleted: 10, more: true });
    expect(pruneEvents(db, NOW, 10)).toMatchObject({ deleted: 10, more: true });
    expect(pruneEvents(db, NOW, 10)).toMatchObject({ deleted: 5, more: false });
    put(db, "secret.read", KEEP_MS + DAY);
    expect(pruneEvents(db, NOW + 1000, 10)).toMatchObject({ deleted: 0, more: false });
    // The next pass, once rows written later have aged past the rule too.
    expect(pruneEvents(db, NOW + Math.max(REST_MS, KEEP_MS), 10)).toMatchObject({ deleted: 2, more: false });
    expect((db.query("SELECT COUNT(*) AS n FROM event").get() as { n: number }).n).toBe(0);
  });

  test("the rule keeps state kinds at any age and windows the rest", () => {
    for (const k of ["issue.closed", "pull.pushed", "repo.detached", "user.created", "push", "keeper_lull", "forge_down", "app.egress.granted"])
      expect(keptKind(k)).toBe(true);
    for (const k of ["secret.read", "forge.spawn.live", "mail.ceiling", "measurement"]) expect(keptKind(k)).toBe(false);
    expect(KEEP_MS).toBeGreaterThanOrEqual(90 * DAY);
  });

  test("one 5,000-row batch holds the write lock under 50 ms", () => {
    const db = seeded();
    const add = db.query("INSERT INTO event (id, kind, repo_id, payload, created_at) VALUES (?1, 'secret.read', 'r1', ?2, ?3)");
    db.transaction(() => {
      for (let i = 0; i < 20_000; i++) add.run(`b${String(i).padStart(6, "0")}`, `{"name":"CLOUD_${i}","number":${i}}`, iso(NOW - KEEP_MS - DAY - (20_000 - i)));
      for (let i = 0; i < 2_000; i++) db.query("INSERT INTO webhook_delivery (id, webhook_id, event_id, state) VALUES (?1, 'w1', ?2, 'ok')").run(`d${i}`, `b${String(i * 7).padStart(6, "0")}`);
    })();
    db.exec("PRAGMA foreign_keys = ON");
    pruneEvents(db, NOW, 100); // warm the statements
    const { deleted, lockMs } = pruneEvents(db, NOW, BATCH_ROWS);
    expect(deleted).toBe(BATCH_ROWS);
    expect(lockMs).toBeGreaterThan(0);
    expect(lockMs).toBeLessThan(50);
  });
});

describe("the sampler's tick", () => {
  test("prunes a batch of old events, the same periodic job as the machine_sample rule", async () => {
    const { startSampler } = await import("../src/boards/sampler.ts");
    const db = seeded();
    // The sampler ticks once at start with the clock's own now, so the rows are aged from it.
    const now = Date.now();
    const gone = put(db, "secret.read", KEEP_MS + DAY + (NOW - now), null);
    const kept = put(db, "secret.read", DAY + (NOW - now), null);
    db.exec("PRAGMA foreign_keys = ON");
    const app = { db, log: { warn: () => {}, info: () => {} } } as unknown as import("../src/app.ts").App;
    const nowhere = { cgroup: "/nowhere", proc: "/nowhere", sys: "/nowhere" };
    const s = startSampler(app, { paths: nowhere, everyMs: 3_600_000, cells: () => [] });
    try {
      s.tick(now);
      expect(db.query("SELECT 1 FROM event WHERE id = ?1").get(gone)).toBeNull();
      expect(db.query("SELECT 1 FROM event WHERE id = ?1").get(kept)).not.toBeNull();
    } finally {
      s.stop();
    }
  });
});
