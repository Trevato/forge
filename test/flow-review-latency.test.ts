/** The review latency (#6473): median hours from a crew pull's opening to its first verdict, over the last 24 h. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { addCrew, createAgentRow } from "../src/core/agents.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";
import { readReviewLatency } from "../src/flow/review_latency.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

type Verdict = "approved" | "changes_requested" | "commented";

async function seed() {
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "forge-review-latency-")), port: 0 });
  const alice = await createUser(app.db, { username: "alice", email: "a@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true, adminIfFirst: true });
  if (!alice.ok) throw new Error(alice.error);
  const bot = await createUser(app.db, { username: "builder", email: "b@forge.test", agent: true, origin: "agent" });
  if (!bot.ok) throw new Error(bot.error);
  createAgentRow(app.db, { userId: bot.value.id, brief: "builder." });
  let n = 0;
  const repo = async (name: string, visibility: "public" | "private") => {
    const r = await createRepo(app.db, app.reposRoot, { ownerId: alice.value.id, name, visibility, description: name });
    if (!r.ok) throw new Error(r.error);
    addCrew(app.db, r.value.id, bot.value.id, alice.value.id);
    return {
      /** A pull opened `opened` hours ago, with reviews `[state, hours ago]`. */
      pull: (opened: number, reviews: [Verdict, number][], author = bot.value.id) => {
        const issueId = id();
        n++;
        app.db.query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', 'P', '', ?4, 'open', ?5)`).run(issueId, r.value.id, n, author, ago(opened));
        app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id) VALUES (?1, 'main', ?2, '', '', ?3)`).run(issueId, `b/${n}`, r.value.id);
        for (const [state, at] of reviews)
          app.db.query(`INSERT INTO review (id, issue_id, author_id, state, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`).run(id(), issueId, alice.value.id, state, ago(at));
      },
    };
  };
  return { app, repo, alice: alice.value.id };
}

describe("review latency", () => {
  test("no reviewed pulls gives null", async () => {
    const s = await seed();
    const r = await s.repo("r", "public");
    r.pull(3, []);
    expect(readReviewLatency(s.app.db, NOW)).toBeNull();
  });

  test("three pulls reviewed 1, 2 and 10 h after opening give 2.0 from 3; one reviewed two days ago is left out", async () => {
    const s = await seed();
    const r = await s.repo("r", "public");
    r.pull(5, [["approved", 4]]); // 1 h
    r.pull(6, [["changes_requested", 4]]); // 2 h
    r.pull(20, [["approved", 10]]); // 10 h
    r.pull(50, [["approved", 48]]); // two days ago
    expect(readReviewLatency(s.app.db, NOW)).toEqual({ median: 2.0, count: 3 });
  });

  test("the first verdict counts, not a comment or a later verdict", async () => {
    const s = await seed();
    const r = await s.repo("r", "public");
    r.pull(10, [["commented", 9], ["changes_requested", 7], ["approved", 1]]); // 3 h
    expect(readReviewLatency(s.app.db, NOW)).toEqual({ median: 3.0, count: 1 });
  });

  test("a pull whose first verdict is older than 24 h is left out even with a fresh one", async () => {
    const s = await seed();
    const r = await s.repo("r", "public");
    r.pull(40, [["changes_requested", 30], ["approved", 2]]);
    expect(readReviewLatency(s.app.db, NOW)).toBeNull();
  });

  test("an even count averages the middle two, to one decimal", async () => {
    const s = await seed();
    const r = await s.repo("r", "public");
    r.pull(2, [["approved", 1]]); // 1 h
    r.pull(2.6, [["approved", 0]]); // 2.6 h
    expect(readReviewLatency(s.app.db, NOW)).toEqual({ median: 1.8, count: 2 });
  });

  test("a person's pull is not a crew pull", async () => {
    const s = await seed();
    const r = await s.repo("r", "public");
    r.pull(5, [["approved", 4]], s.alice);
    expect(readReviewLatency(s.app.db, NOW)).toBeNull();
  });

  test("publicOnly hides a private repository", async () => {
    const s = await seed();
    const pub = await s.repo("pub", "public");
    const priv = await s.repo("priv", "private");
    pub.pull(5, [["approved", 4]]); // 1 h
    priv.pull(20, [["approved", 10]]); // 10 h
    expect(readReviewLatency(s.app.db, NOW)).toEqual({ median: 5.5, count: 2 });
    expect(readReviewLatency(s.app.db, NOW, true)).toEqual({ median: 1.0, count: 1 });
  });
});
