/**
 * Idle pulls at the forge's own size (#6840): 0.7.277 asked each pull ever made for its
 * last push across the whole event table, on every /boards render, and the forge's HTTP
 * loop stopped answering. The read is bounded by the open agent pulls, and /boards reads
 * it at most once a minute.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import {
  IDLE_TTL_MS,
  idlePullsCached,
  readIdlePulls,
} from "../src/flow/idle_pulls.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const ago = (h: number): string =>
  new Date(NOW.getTime() - h * 3_600_000).toISOString();
const CLOSED = 1_500;
const OPEN = 60;
const PUSHES = 60_000;

let dir: string;
let app: App;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "idle-pulls-scale-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first: boolean): Promise<string> => {
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!u.ok) throw new Error(u.error);
    return u.value.id;
  };
  const person = await mk("alice", true);
  const agent = await mk("scout", false);
  app.db.run("UPDATE user SET is_agent = 1 WHERE id = ?1", [agent]);
  app.db.run(
    "INSERT INTO repo (id, owner_id, name, visibility) VALUES ('big', ?1, 'big', 'public')",
    [person],
  );
  const issue = app.db.prepare(
    "INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, 'big', ?2, 'pull', 't', '', ?3, ?4, ?5)",
  );
  const pull = app.db.prepare(
    "INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1, 'main', ?2, '', 'h', ?3)",
  );
  const event = app.db.prepare(
    "INSERT INTO event (id, kind, repo_id, payload, created_at) VALUES (?1, 'pull.pushed', 'big', ?2, ?3)",
  );
  app.db.transaction(() => {
    for (let n = 1; n <= CLOSED + OPEN; n++) {
      const open = n > CLOSED;
      // Open pulls opened 100 h ago; the first half last pushed 90 h ago (idle), the rest 2 h ago.
      issue.run(
        `p${n}`,
        n,
        agent,
        open ? "open" : "closed",
        open ? ago(100) : ago(2_000 - (n % 1_500)),
      );
      pull.run(`p${n}`, `b${n}`, open ? null : ago(1_000));
    }
    for (let e = 0; e < PUSHES; e++) {
      const n = (e % (CLOSED + OPEN)) + 1;
      const openIdle = n > CLOSED && n <= CLOSED + OPEN / 2;
      const openBusy = n > CLOSED + OPEN / 2;
      const h = openIdle
        ? 90 + (e % 7)
        : openBusy
          ? 2 + (e % 3)
          : 1_500 + (e % 400);
      event.run(`e${e}`, JSON.stringify({ number: n }), ago(h));
    }
  })();
});
afterAll(async () => {
  app.close?.();
  await rm(dir, { recursive: true, force: true });
});

/** The 0.7.277 read, kept here only to measure against: each pull ever made asks the whole event table. */
function oldRead(): number {
  return app.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM pull p JOIN issue i ON i.id = p.issue_id
         JOIN (SELECT p2.issue_id AS issue_id,
                      COALESCE((SELECT MAX(e.created_at) FROM event e
                                 WHERE e.kind = 'pull.pushed' AND e.repo_id = i2.repo_id
                                   AND json_extract(e.payload, '$.number') = i2.number), i2.created_at) AS at
                 FROM pull p2 JOIN issue i2 ON i2.id = p2.issue_id) m ON m.issue_id = i.id
        WHERE i.state = 'open' AND p.merged_at IS NULL AND m.at <= ?1`,
    )
    .get(new Date(NOW.getTime() - 72 * 3_600_000).toISOString())!.n;
}

test("readIdlePulls reads the open agent pulls, not every pull ever made: ten times cheaper than the 0.7.277 read here, and right", () => {
  readIdlePulls(app.db, NOW, false);
  let start = performance.now();
  oldRead();
  const before = performance.now() - start;
  start = performance.now();
  const rows = readIdlePulls(app.db, NOW, false);
  const now = performance.now() - start;
  // Measured against the old read on the same data in the same process, so load cancels out.
  expect(now * 10).toBeLessThan(before);
  // The idle open pulls only (the first half of the open ones), oldest first, capped.
  expect(rows.length).toBe(Math.min(OPEN / 2, 20));
  for (const r of rows) {
    expect(r.pull).toBeGreaterThan(CLOSED);
    expect(r.pull).toBeLessThanOrEqual(CLOSED + OPEN / 2);
    expect(r.hours).toBeGreaterThanOrEqual(72);
  }
});

test("idlePullsCached reads once a minute, then again", () => {
  const first = idlePullsCached(app.db, NOW, false);
  const again = idlePullsCached(app.db, new Date(NOW.getTime() + 1_000), false);
  expect(again).toBe(first);
  const later = idlePullsCached(
    app.db,
    new Date(NOW.getTime() + IDLE_TTL_MS + 1),
    false,
  );
  expect(later).not.toBe(first);
  expect(later.map((r) => r.pull)).toEqual(first.map((r) => r.pull));
});
