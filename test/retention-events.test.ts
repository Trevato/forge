import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { migrations } from "../src/core/schema.ts";
import { listEvents } from "../src/core/events.ts";
import { countNotes } from "../src/maintain/keeper/record.ts";
import { openDb } from "../src/kernel/db.ts";
import { LIMITS } from "../src/settings/limits.ts";
import { expectWork } from "./helpers/work.ts";
import { BATCH_ROWS, KEEP_MS, keptKind, LIVE_KEEP_MS, LIVE_SLICE_ROWS, pruneEvents, pruneLiveEvents, REST_MS } from "../src/system/retention_events.ts";

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
    // Eighteen rows spread over the window, oldest first, alternating a windowed and a kept kind.
    for (let i = 17; i >= 0; i--)
      recent.push(put(db, i % 2 === 0 ? "secret.read" : "issue.reopened", Math.floor((i * (KEEP_MS - DAY)) / 17), "r1", { number: i }));

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
    // The longest fixed window over an unkept kind is a board's 30d range (`boards/store.ts`).
    expect(KEEP_MS).toBeGreaterThanOrEqual(30 * DAY);
    expect(LIMITS["retention.event_days"].default * DAY).toBe(KEEP_MS);
  });

  test("the keep window is the caller's: rows past it go, rows inside it stay, a batch is bounded", () => {
    const db = seeded();
    const keep = 60 * DAY;
    const past = [put(db, "secret.read", keep + 2 * DAY), put(db, "secret.read", keep + DAY)];
    // Past the default window, inside this one.
    const inside = [put(db, "secret.read", KEEP_MS + DAY), put(db, "secret.read", DAY)];
    expect(pruneEvents(db, NOW, 1, keep)).toMatchObject({ deleted: 1, more: true });
    expect(pruneEvents(db, NOW, 1, keep)).toMatchObject({ deleted: 1, more: true });
    expect(pruneEvents(db, NOW, 1, keep)).toMatchObject({ deleted: 0, more: false });
    for (const id of past) expect(db.query("SELECT 1 FROM event WHERE id = ?1").get(id)).toBeNull();
    for (const id of inside) expect(db.query("SELECT 1 FROM event WHERE id = ?1").get(id)).not.toBeNull();
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
    const { deleted, lockMs } = pruneEvents(db, NOW, BATCH_ROWS, KEEP_MS, Infinity);
    expect(deleted).toBe(BATCH_ROWS);
    expect(lockMs).toBeGreaterThan(0);
    expect(lockMs).toBeLessThan(50);
  });
});

describe("pruneEvents out of its time budget", () => {
  test("ends after a chunk and the pass goes on from the last row it took, losing and repeating none", () => {
    const db = seeded();
    const all: string[] = [];
    for (let i = 0; i < 200; i++) all.push(put(db, "secret.read", KEEP_MS + 2 * DAY + (200 - i) * 1000, null));
    const young = put(db, "secret.read", DAY, null);
    let deleted = 0;
    let slices = 0;
    for (;;) {
      const r = pruneEvents(db, NOW, 100, KEEP_MS, 0);
      deleted += r.deleted;
      slices++;
      if (!r.more) break;
    }
    expect(deleted).toBe(200);
    expect(slices).toBeGreaterThan(3);
    expect(db.query("SELECT 1 FROM event WHERE id = ?1").get(young)).not.toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM event").get()).toEqual({ n: 1 });
  });
});

describe("pruneLiveEvents: wake-ups live hours, not 30 days", () => {
  const HOUR = 3_600_000;
  const gone = (db: Database, id: string) => db.query("SELECT 1 FROM event WHERE id = ?1").get(id) === null;

  test("run.shard, usage.delta and backup.progress older than the window go; history of any kind stays", () => {
    const db = seeded();
    const old = [
      put(db, "run.shard", 30 * DAY, "r1", { shard: 1, of: 8 }),
      put(db, "usage.delta", 20 * DAY, "r1", { runId: "x" }),
      put(db, "backup.progress", 9 * HOUR, null, { objects: 1, bytes: 2 }),
      put(db, "run.shard", LIVE_KEEP_MS + HOUR, "r1"),
    ];
    const young = [
      put(db, "run.shard", LIVE_KEEP_MS - HOUR, "r1"),
      put(db, "usage.delta", HOUR, "r1"),
      // Not wake-ups: a run's own history is read by the boards at 30 days.
      put(db, "run.started", 10 * DAY, "r1"),
      put(db, "run.finished", 10 * DAY, "r1"),
      put(db, "issue.opened", 100 * DAY, "r1"),
    ];
    const first = pruneLiveEvents(db, NOW);
    expect(first).toEqual({ deleted: old.length, more: false });
    for (const id of old) expect(gone(db, id)).toBe(true);
    for (const id of young) expect(gone(db, id)).toBe(false);
    // Idempotent: nothing is left to take, and nothing is remembered between slices.
    expect(pruneLiveEvents(db, NOW)).toEqual({ deleted: 0, more: false });
  });

  test("a slice out of its time budget ends there and the next goes on from the oldest left", () => {
    const db = seeded();
    for (let i = 0; i < 200; i++) put(db, "run.shard", 2 * DAY + (200 - i) * 1000);
    // A budget already spent: one chunk of 20 is taken, then the slice hands the thread back.
    const first = pruneLiveEvents(db, NOW, 200, LIVE_KEEP_MS, 0);
    expect(first).toEqual({ deleted: 20, more: true });
    let total = first.deleted;
    for (let more = true; more; ) {
      const r = pruneLiveEvents(db, NOW, 200, LIVE_KEEP_MS, 0);
      total += r.deleted;
      more = r.more;
    }
    expect(total).toBe(200);
  });

  test("a slice is bounded by its cap, and a pass goes on until every kind is inside its window", () => {
    const db = seeded();
    const all: string[] = [];
    for (let i = 0; i < 50; i++) all.push(put(db, i % 2 === 0 ? "run.shard" : "usage.delta", 2 * DAY + (50 - i) * 1000));
    const young = put(db, "run.shard", HOUR);
    let slices = 0;
    let deleted = 0;
    for (;;) {
      const r = pruneLiveEvents(db, NOW, 8);
      expect(r.deleted).toBeLessThanOrEqual(8);
      deleted += r.deleted;
      slices++;
      if (!r.more) break;
    }
    expect(deleted).toBe(50);
    expect(slices).toBeGreaterThan(5);
    expect(gone(db, young)).toBe(false);
  });

  test("an event whose delivery is pending is not offered, so a retry never loses what it sends", () => {
    const db = seeded();
    const pending = put(db, "run.shard", 3 * DAY);
    db.query("INSERT INTO webhook_delivery (id, webhook_id, event_id, state) VALUES ('dp', 'w1', ?1, 'pending')").run(pending);
    const done = put(db, "run.shard", 3 * DAY);
    db.query("INSERT INTO webhook_delivery (id, webhook_id, event_id, state) VALUES ('dd', 'w1', ?1, 'ok')").run(done);
    db.exec("PRAGMA foreign_keys = ON");
    // A pending one in front never stalls a pass behind it.
    expect(pruneLiveEvents(db, NOW, 1)).toEqual({ deleted: 1, more: true });
    expect(pruneLiveEvents(db, NOW)).toEqual({ deleted: 0, more: false });
    expect(gone(db, pending)).toBe(false);
    expect(gone(db, done)).toBe(true);
  });

  test("a slice of the cap is one transaction of a statement a chunk of rows, however many rows wait", async () => {
    const db = seeded();
    const insert = db.query("INSERT INTO event (id, kind, repo_id, payload, created_at) VALUES (?1, 'run.shard', 'r1', '{}', ?2)");
    db.transaction(() => {
      for (let i = 0; i < 6_000; i++) insert.run(`s${String(i).padStart(8, "0")}`, iso(NOW - 2 * DAY + i));
    })();
    pruneLiveEvents(db, NOW, 1);
    let r = { deleted: 0, more: false };
    const cost = await (await import("./helpers/statements.ts")).once(db, () => {
      r = pruneLiveEvents(db, NOW);
    });
    expect(r.deleted).toBe(LIVE_SLICE_ROWS);
    expect(r.more).toBe(true);
    // Three reads, and a delete for each chunk of 20 of its 400 rows: fixed by the cap, not by the table.
    expectWork(cost, { max: 26 });
  });
});
