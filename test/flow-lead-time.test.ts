/** The lead time (#6442): median and slowest hours from opening to landing over the last 24 h. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";
import { readLeadTime } from "../src/flow/lead_time.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

async function seed() {
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "forge-lead-")), port: 0 });
  const u = await createUser(app.db, { username: "alice", email: "a@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true, adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  let n = 0;
  const repo = async (name: string, visibility: "public" | "private") => {
    const r = await createRepo(app.db, app.reposRoot, { ownerId: u.value.id, name, visibility, description: name });
    if (!r.ok) throw new Error(r.error);
    return {
      pull: (opened: number, merged: number, base = r.value.defaultBranch) => {
        const issueId = id();
        n++;
        app.db.query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', 'P', '', ?4, 'closed', ?5)`).run(issueId, r.value.id, n, u.value.id, ago(opened));
        app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at) VALUES (?1, ?2, ?3, '', '', ?4, ?5)`).run(issueId, base, `b/${n}`, r.value.id, ago(merged));
      },
    };
  };
  return { app, repo };
}

describe("lead time", () => {
  test("none landed gives null hours", async () => {
    const s = await seed();
    expect(readLeadTime(s.app.db, NOW)).toEqual({ landed: 0, medianHours: null, maxHours: null });
  });

  test("three landed pulls give the median and the slowest", async () => {
    const s = await seed();
    const r = await s.repo("r", "public");
    r.pull(3, 2); // 1 h
    r.pull(8, 4); // 4 h
    r.pull(12, 1); // 11 h
    const t = readLeadTime(s.app.db, NOW);
    expect(t.landed).toBe(3);
    expect(t.medianHours).toBeCloseTo(4, 6);
    expect(t.maxHours).toBeCloseTo(11, 6);
  });

  test("an even count averages the middle two", async () => {
    const s = await seed();
    const r = await s.repo("r", "public");
    r.pull(3, 2); // 1 h
    r.pull(8, 4); // 4 h
    expect(readLeadTime(s.app.db, NOW).medianHours).toBeCloseTo(2.5, 6);
  });

  test("a pull merged into a non-default branch is left out", async () => {
    const s = await seed();
    const r = await s.repo("r", "public");
    r.pull(3, 2);
    r.pull(20, 1, "side");
    const t = readLeadTime(s.app.db, NOW);
    expect(t.landed).toBe(1);
    expect(t.maxHours).toBeCloseTo(1, 6);
  });

  test("a pull merged more than 24 h ago is left out", async () => {
    const s = await seed();
    const r = await s.repo("r", "public");
    r.pull(3, 2);
    r.pull(40, 25);
    expect(readLeadTime(s.app.db, NOW).landed).toBe(1);
  });

  test("publicOnly hides private repositories", async () => {
    const s = await seed();
    const pub = await s.repo("pub", "public");
    const priv = await s.repo("priv", "private");
    pub.pull(3, 2);
    priv.pull(20, 1);
    expect(readLeadTime(s.app.db, NOW).landed).toBe(2);
    const t = readLeadTime(s.app.db, NOW, true);
    expect(t.landed).toBe(1);
    expect(t.maxHours).toBeCloseTo(1, 6);
  });
});
