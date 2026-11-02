/**
 * Leave to run: a grant names one head, a new push waits for a new grant,
 * and a grant is never a review.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { recordPullProposal } from "../src/core/proposal_token.ts";
import { pullMayRun } from "../src/core/pull_trust.ts";
import { getPull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { grantRun, runGrantedAt } from "../src/core/run_grant.ts";
import { createUser, type User } from "../src/core/users.ts";

describe("leave to run", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let lib: Repo;
  let issueId: string;
  let number: number;
  let a: string;
  let b: string;
  const pull = () => getPull(app.db, lib.id, number)!;
  const rows = () =>
    app.db
      .query<{ user_id: string; granted_at: string }, [string]>(
        "SELECT user_id, granted_at FROM pull_run_grant WHERE issue_id = ?1",
      )
      .all(issueId);

  const push = async (file: string) => {
    const done = await commitToBranch(app, alice, lib, {
      branch: "child/kid/one",
      message: file,
      files: [{ path: file, content: `${file}\n` }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
    return done.value.commitOid;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-run-grant-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const repo = await createRepo(app, alice, { name: "lib", visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    lib = repo.value;
    const seeded = await commitToBranch(app, alice, lib, {
      message: "Start",
      files: [{ path: "README.md", content: "# lib\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    app.db.query("UPDATE repo SET require_review = 1 WHERE id = ?1").run(lib.id);
    lib = { ...lib, requireReview: true };
    a = await push("a.md");
    const opened = await openPull(app, alice, lib, {
      title: "Proposed",
      baseBranch: "main",
      headBranch: "child/kid/one",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    recordPullProposal(app.db, opened.value.id, {
      child: "kid",
      origin: "https://kid.example.com/",
    });
    issueId = opened.value.id;
    number = opened.value.number;
  }, 120_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a grant on head A lets A run, and a push to B waits for its own grant", async () => {
    expect(runGrantedAt(app.db, issueId, a)).toBeUndefined();
    expect(pullMayRun(app.db, lib, pull(), a)).toBe(false);

    grantRun(app.db, issueId, a, alice.id);
    expect(runGrantedAt(app.db, issueId, a)).toBeString();
    expect(pullMayRun(app.db, lib, pull(), a)).toBe(true);

    b = await push("b.md");
    expect(b).not.toBe(a);
    expect(runGrantedAt(app.db, issueId, b)).toBeUndefined();
    expect(pullMayRun(app.db, lib, pull(), b)).toBe(false);

    grantRun(app.db, issueId, b, alice.id);
    expect(pullMayRun(app.db, lib, pull(), b)).toBe(true);
  });

  test("granting twice keeps one row, moves granted_at and records the second granter", async () => {
    app.db
      .query("UPDATE pull_run_grant SET granted_at = '2000-01-01T00:00:00.000Z', user_id = 'first' WHERE issue_id = ?1 AND commit_oid = ?2")
      .run(issueId, a);
    const before = rows().length;
    grantRun(app.db, issueId, a, alice.id);
    grantRun(app.db, issueId, a, alice.id);
    expect(rows()).toHaveLength(before);
    expect(runGrantedAt(app.db, issueId, a)! > "2000-01-01T00:00:00.000Z").toBe(true);
    const row = app.db
      .query<{ user_id: string }, [string, string]>(
        "SELECT user_id FROM pull_run_grant WHERE issue_id = ?1 AND commit_oid = ?2",
      )
      .get(issueId, a)!;
    expect(row.user_id).toBe(alice.id);
  });

  test("an empty oid is never granted", () => {
    const before = rows().length;
    grantRun(app.db, issueId, "", alice.id);
    expect(runGrantedAt(app.db, issueId, "")).toBeUndefined();
    expect(rows()).toHaveLength(before);
    expect(pullMayRun(app.db, lib, pull(), "")).toBe(false);
  });

  test("a grant is not a review: the merge gate still wants one", async () => {
    expect(pullMayRun(app.db, lib, pull(), b)).toBe(true);
    const refused = await mergePull(app, alice, lib, pull(), "merge");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe("review_required");
    expect(
      app.db.query("SELECT COUNT(*) AS n FROM review WHERE issue_id = ?1").get(issueId),
    ).toEqual({ n: 0 });
  });
});
