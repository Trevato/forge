/** One test proves every flow read that takes `publicOnly` hides a private repository (#6476). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { alarmStuck } from "../src/flow/alarm_stuck.ts";
import { readChecksPile } from "../src/flow/checks_pile.ts";
import { conflictedPulls, noteWaitingToFinish } from "../src/flow/conflicted.ts";
import { readOldestApproved } from "../src/flow/oldest_approved.ts";
import { readRedBatches } from "../src/flow/red_batches.ts";
import { requestedWaits } from "../src/flow/requested.ts";
import { reviewersBusy } from "../src/flow/reviewing.ts";
import { readVitals } from "../src/flow/vitals.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const ago = (m: number): string => new Date(NOW.getTime() - m * 60_000).toISOString();

let dir: string;
let app: App;
let owner: string;
let n = 0;

/** Every state the reads count, in one repository: approved and quiet with a red check, a conflict run, a queued check, changes requested, a review in flight, a landed pull, a red batch. */
function seed(repo: string, name: string, reviewer: string): void {
  const db = app.db;
  const base = ++n * 10;
  const pull = (k: number, merged = false): string => {
    const id = `${repo}-p${k}`;
    db.run(
      "INSERT INTO issue (id, repo_id, number, kind, title, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', 't', ?4, ?5, ?6)",
      [id, repo, base + k, owner, merged ? "closed" : "open", ago(600)],
    );
    db.run("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1, 'main', ?2, '', 'h', ?3)", [id, `b${base + k}`, merged ? ago(5) : null]);
    return id;
  };
  const run = (id: string, issue: string, kind: string, state: string, extra: { reason?: string; actor?: string } = {}): void => {
    db.run(
      "INSERT INTO run (id, repo_id, kind, issue_id, state, commit_oid, reason, actor_id, created_at, finished_at) VALUES (?1, ?2, ?3, ?4, ?5, 'h', ?6, ?7, ?8, ?8)",
      [id, repo, kind, issue, state, extra.reason ?? "", extra.actor ?? null, ago(repo === "priv" ? 350 : 300)],
    );
  };
  // Approved, quiet, red on its head, and conflicted.
  const a = pull(1);
  db.run("INSERT INTO review (id, issue_id, author_id, state, commit_oid, created_at) VALUES (?1, ?2, ?3, 'approved', 'h', ?4)", [`${repo}-rv1`, a, owner, ago(500)]);
  run(`${repo}-r1`, a, "check", "failed");
  run(`${repo}-r2`, a, "agent", "failed", { reason: "conflict" });
  // A check queued for a slot.
  run(`${repo}-r3`, pull(2), "check", "queued");
  // Changes requested by the crew's reviewer, who has a review in flight.
  const c = pull(3);
  db.run("INSERT INTO repo_crew (repo_id, user_id, role) VALUES (?1, ?2, 'reviewer')", [repo, reviewer]);
  db.run("INSERT INTO review (id, issue_id, author_id, state, commit_oid, created_at) VALUES (?1, ?2, ?3, 'changes_requested', 'h', ?4)", [`${repo}-rv3`, c, reviewer, ago(200)]);
  run(`${repo}-r4`, c, "agent", "running", { reason: "review", actor: reviewer });
  // Landed, and a red batch.
  pull(4, true);
  db.run("INSERT INTO queue_batch (repo_id, red, finished_at) VALUES (?1, 1, ?2)", [repo, ago(10)]);
  // The finishing pass's waiting pull, which has no run.
  noteWaitingToFinish(db, repo, [{ repo: `alice/${name}`, number: base + 9, since: ago(100), public: repo === "pub" }]);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "flow-public-only-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false): Promise<string> => {
    const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
    if (!u.ok) throw new Error(u.error);
    return u.value.id;
  };
  owner = await mk("alice", true);
  const pubReviewer = await mk("pubrev");
  const privReviewer = await mk("privrev");
  app.db.run("UPDATE user SET is_agent = 1 WHERE id IN (?1, ?2)", [pubReviewer, privReviewer]);
  app.db.run("INSERT INTO repo (id, owner_id, name, visibility, autonomy) VALUES ('pub', ?1, 'open', 'public', 'auto')", [owner]);
  app.db.run("INSERT INTO repo (id, owner_id, name, visibility, autonomy) VALUES ('priv', ?1, 'secret', 'private', 'auto')", [owner]);
  seed("pub", "open", pubReviewer);
  seed("priv", "secret", privReviewer);
});
afterAll(async () => {
  app.close?.();
  await rm(dir, { recursive: true, force: true });
});

describe("publicOnly hides a private repository from every flow read", () => {
  test("the seed is visible to a reader who may see it all", () => {
    expect(alarmStuck(app.db, NOW).says).toContain("alice/secret#");
    expect(readChecksPile(app.db)).toEqual({ red: 2, queued: 2 });
    expect(conflictedPulls(app.db).filter((p) => p.repo === "alice/secret")).toHaveLength(2);
    expect(readOldestApproved(app.db, NOW)).not.toBeNull();
    expect(readRedBatches(app.db, NOW)).toEqual({ finished: 2, red: 2, rate: 1 });
    const w = requestedWaits(app.db);
    expect([...w.builder, ...w.reviewer].filter((p) => p.repo === "alice/secret")).toHaveLength(1);
    expect(reviewersBusy(app.db).map((r) => r.reviewer).sort()).toEqual(["privrev", "pubrev"]);
    expect(readVitals(app.db, NOW).open).toBe(6);
  });

  test("with publicOnly, nothing from the private repository appears", () => {
    // The private pull has waited longest, so an unfiltered read names it; the public one must still be named.
    const stuck = alarmStuck(app.db, NOW, { publicOnly: true });
    expect(stuck.fired).toBe(true);
    expect(stuck.says).toContain("alice/open#");
    expect(stuck.says).not.toContain("secret");

    expect(readChecksPile(app.db, true)).toEqual({ red: 1, queued: 1 });

    const conflicted = conflictedPulls(app.db, true);
    expect(conflicted).toHaveLength(2);
    expect(conflicted.every((p) => p.repo === "alice/open")).toBe(true);

    expect(readOldestApproved(app.db, NOW, true)?.repo).toBe("open");

    expect(readRedBatches(app.db, NOW, true)).toEqual({ finished: 1, red: 1, rate: 1 });

    const w = requestedWaits(app.db, true);
    const waiting = [...w.builder, ...w.reviewer];
    expect(waiting).toHaveLength(1);
    expect(waiting.every((p) => p.repo === "alice/open")).toBe(true);

    expect(reviewersBusy(app.db, true)).toEqual([{ reviewer: "pubrev", count: 1 }]);

    expect(readVitals(app.db, NOW, true)).toMatchObject({ open: 3, conflicted: 2 });
  });

  test("a private-only forge reads empty with publicOnly", () => {
    app.db.run("DELETE FROM repo WHERE id = 'pub'");
    noteWaitingToFinish(app.db, "pub", []);
    expect(alarmStuck(app.db, NOW, { publicOnly: true }).fired).toBe(false);
    expect(readChecksPile(app.db, true)).toEqual({ red: 0, queued: 0 });
    expect(conflictedPulls(app.db, true)).toEqual([]);
    expect(readOldestApproved(app.db, NOW, true)).toBeNull();
    expect(readRedBatches(app.db, NOW, true).finished).toBe(0);
    expect(requestedWaits(app.db, true)).toEqual({ builder: [], reviewer: [] });
    expect(reviewersBusy(app.db, true)).toEqual([]);
    expect(readVitals(app.db, NOW, true)).toMatchObject({ open: 0, opened6h: 0, landed6h: 0, conflicted: 0 });
  });
});
