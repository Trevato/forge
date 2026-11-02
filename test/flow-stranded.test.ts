/** The stranded spend (#5930): runs on open, unmerged pulls, and nothing else. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";
import { readStranded } from "../src/flow/stranded.ts";

describe("readStranded", () => {
  let root: string;
  let app: ReturnType<typeof createApp>;
  let owner: string;
  let pub: string;
  let priv: string;
  const counter = new Map<string, number>();

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "forge-stranded-"));
    app = createApp({ dataDir: root, port: 0 });
    const made = await createUser(app.db, { username: "alice", email: "alice@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true, adminIfFirst: true });
    if (!made.ok) throw new Error(made.error);
    owner = made.value.id;
    for (const [name, visibility] of [["pub", "public"], ["priv", "private"]] as const) {
      const r = await createRepo(app.db, app.reposRoot, { ownerId: owner, name, visibility, description: name });
      if (!r.ok) throw new Error(r.error);
      if (name === "pub") pub = r.value.id;
      else priv = r.value.id;
    }
  });
  afterAll(() => {
    app.db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const pull = (repo: string, state: string, merged: string | null, costs: number[]) => {
    const issueId = id();
    const n = (counter.get(repo) ?? 0) + 1;
    counter.set(repo, n);
    app.db
      .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state) VALUES (?1, ?2, ?3, 'pull', 'P', '', ?4, ?5)`)
      .run(issueId, repo, n, owner, state);
    app.db
      .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at) VALUES (?1, 'main', ?2, '', '', ?3, ?4)`)
      .run(issueId, `b/${n}`, repo, merged);
    for (const c of costs) {
      app.db
        .query(`INSERT INTO run (id, repo_id, kind, issue_id, state, cost_usd) VALUES (?1, ?2, 'agent', ?3, 'ok', ?4)`)
        .run(id(), repo, issueId, c);
    }
    return n;
  };

  test("nothing open reads as zero", () => {
    expect(readStranded(app.db)).toEqual({ usd: 0, pulls: 0, costliest: [] });
  });

  test("counts open pulls, leaves out landed and closed ones, ranks the costliest", () => {
    const a = pull(pub, "open", null, [1, 0.5]);
    pull(pub, "closed", "2026-10-26T00:00:00.000Z", [100]); // landed
    pull(pub, "closed", null, [50]); // closed unmerged
    const b = pull(pub, "open", null, [4]);
    const c = pull(pub, "open", null, []);
    const s = readStranded(app.db);
    expect(s.usd).toBeCloseTo(5.5);
    expect(s.pulls).toBe(3);
    expect(s.costliest.map((p) => p.number)).toEqual([b, a, c]);
    expect(s.costliest[0]!.usd).toBeCloseTo(4);
  });

  test("publicOnly leaves out private repositories", () => {
    pull(priv, "open", null, [10]);
    expect(readStranded(app.db).usd).toBeCloseTo(15.5);
    const s = readStranded(app.db, true);
    expect(s.usd).toBeCloseTo(5.5);
    expect(s.pulls).toBe(3);
  });

  test("keeps only the five costliest, with 200 open pulls and 2,000 runs", () => {
    for (let i = 0; i < 200; i++) pull(pub, "open", null, Array.from({ length: 10 }, () => 0.1));
    const s = readStranded(app.db, true);
    expect(s.costliest).toHaveLength(5);
    expect(s.pulls).toBe(203);
    expect(s.usd).toBeCloseTo(5.5 + 200);
  });
});
