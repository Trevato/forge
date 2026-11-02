import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue, setIssueState } from "../src/core/issues.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { claimedClones, sweepOrphanClones } from "../src/crew/orphans.ts";
import { workdirFor } from "../src/crew/runner.ts";
import { crewRoot } from "../src/crew/workdir.ts";
import type { Repo } from "../src/core/repos.ts";
import type { Agent } from "../src/core/agents.ts";

describe("what claims a clone", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;
  let claimed: (agent: string, repoId: string, n: number) => boolean;

  const issue = (closed = false): number => {
    const made = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title: "t" });
    if (!made.ok) throw new Error(made.error);
    if (closed) setIssueState(app.db, made.value.id, "closed");
    return made.value.number;
  };
  const run = (branch: string) =>
    createRun(app.db, { repoId: repo.id, kind: "agent", branch, reason: "assigned" });
  const pull = (headBranch: string, closed = false): void => {
    const made = createIssue(app.db, {
      repoId: repo.id,
      authorId: alice.id,
      title: "p",
      kind: "pull",
    });
    if (!made.ok) throw new Error(made.error);
    app.db
      .query(
        `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id)
         VALUES (?1, 'main', ?2, 'a', 'b', ?3)`,
      )
      .run(made.value.id, headBranch, repo.id);
    if (closed) setIssueState(app.db, made.value.id, "closed");
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "claims-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, { name: "garden", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    claimed = claimedClones(app.db);
  });
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the clone directory is named by the db repo id", () => {
    const dir = workdirFor(dataDir, { user: { username: "bot" } } as Agent, repo, 7);
    expect(dir).toBe(join(crewRoot(dataDir), "bot", repo.id, "7"));
  });

  test("an open issue keeps its clone", () => {
    const n = issue();
    expect(claimed("bot", repo.id, n)).toBe(true);
  });

  test("a closed issue with no run and no pull does not", () => {
    const n = issue(true);
    expect(claimed("bot", repo.id, n)).toBe(false);
  });

  test("a queued or working run on the agent's branch keeps it, a finished one does not", () => {
    const n = issue(true);
    const r = run(`bot/${n}-plant-tulips`);
    expect(claimed("bot", repo.id, n)).toBe(true);
    claimRun(app.db, r.id);
    expect(claimed("bot", repo.id, n)).toBe(true);
    finishRun(app.db, r.id, { state: "ok", summary: "done" });
    expect(claimed("bot", repo.id, n)).toBe(false);
  });

  test("an open pull from the agent's branch keeps it, a closed one does not", () => {
    const n = issue(true);
    pull(`bot/${n}-fix`);
    expect(claimed("bot", repo.id, n)).toBe(true);
    const m = issue(true);
    pull(`bot/${m}-fix`, true);
    expect(claimed("bot", repo.id, m)).toBe(false);
  });

  test("another agent's branch, a different number or another repo does not claim it", () => {
    const n = issue(true);
    run(`other/${n}-x`);
    pull(`other/${n}-x`);
    run(`bot/${n}0-x`);
    pull(`bot/${n}0-x`);
    expect(claimed("bot", repo.id, n)).toBe(false);
    expect(claimed("bot", "some-other-repo", n)).toBe(false);
    const k = issue(true);
    pull(`bot/${k}-x`);
    expect(claimed("bot", "some-other-repo", k)).toBe(false);
  });

  test("a run queued after the closure is made still keeps its clone", async () => {
    const n = issue(true);
    const dir = join(crewRoot(dataDir), "bot", repo.id, String(n));
    mkdirSync(dir, { recursive: true });
    run(`bot/${n}-late`);
    // `claimed` was built before the run existed
    expect(await sweepOrphanClones(crewRoot(dataDir), claimed)).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  test("swept against the db, only the unclaimed directory goes", async () => {
    const open = issue();
    const dead = issue(true);
    const root = crewRoot(dataDir);
    for (const n of [open, dead]) mkdirSync(join(root, "bot", repo.id, String(n)), { recursive: true });
    await sweepOrphanClones(root, claimed);
    expect(existsSync(join(root, "bot", repo.id, String(open)))).toBe(true);
    expect(existsSync(join(root, "bot", repo.id, String(dead)))).toBe(false);
  });
});
