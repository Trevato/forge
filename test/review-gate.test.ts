/**
 * The review gate: with a reviewer on the crew, a green pull — a person's or
 * an agent's — is queued for review and lands only on an approval of its
 * current head. Without a reviewer it lands as before.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { setCrewRole } from "../src/core/agents.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { listComments } from "../src/core/issues.ts";
import {
  REVIEW_ROUNDS,
  reviewSummary,
  submitReview,
} from "../src/core/reviews.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun, listRuns } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { landIfGreen, settleAgentRun } from "../src/crew/autonomy.ts";

describe("the review gate", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let mason: User;
  let quill: User;
  let repo: Repo;
  const fresh = () => getRepoById(app.db, repo.id)!;
  const reviewRuns = (pull: Pull) =>
    listRuns(app.db, repo.id, { issueId: pull.id }).filter(
      (r) => r.reason === "review",
    );

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-review-gate-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, {
      name: "engine",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# engine\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    for (const name of ["mason", "quill"]) {
      const agent = await createAgent(app, alice, { username: name });
      if (!agent.ok) throw new Error(String(agent.error));
      expect(addToCrew(app, alice, repo, name).ok).toBe(true);
    }
    mason = getUserByName(app.db, "mason")!;
    quill = getUserByName(app.db, "quill")!;
    app.db
      .query(
        "UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2 WHERE id = ?1",
      )
      .run(repo.id, alice.id);
  });

  afterAll(async () => {
    await app.close?.();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function greenPull(author: User, name: string): Promise<Pull> {
    const branch = await commitToBranch(app, alice, repo, {
      branch: `feature/${name}`,
      base: "main",
      message: name,
      files: [{ path: `${name}.ts`, content: `export const n = "${name}";\n` }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: name,
      baseBranch: "main",
      headBranch: `feature/${name}`,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    // Agents push through forks in production; the gate only reads the author.
    app.db
      .query("UPDATE issue SET author_id = ?2 WHERE id = ?1")
      .run(opened.value.id, author.id);
    return passCheck(opened.value);
  }

  function passCheck(pull: Pull): Pull {
    const check = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, check.id);
    finishRun(app.db, check.id, { state: "ok", summary: "check passed" });
    return pull;
  }

  const approve = (pull: Pull, by: User) =>
    submitReview(app.db, {
      issueId: pull.id,
      authorId: by.id,
      state: "approved",
      commitOid: pull.headOid,
    });

  test("with no reviewer on the crew a green pull lands as before", async () => {
    const pull = await greenPull(alice, "plain");
    expect(await landIfGreen(app, fresh(), pull)).toBe(true);
    expect(reviewRuns(pull)).toHaveLength(0);
  });

  for (const [who, author] of [
    ["a person's", () => alice],
    ["an agent's", () => mason],
  ] as const) {
    test(`${who} green pull is reviewed, and lands only on an approval of its head`, async () => {
      setCrewRole(app.db, repo.id, quill.id, "reviewer");
      const name = who.includes("person") ? "by-person" : "by-agent";
      const pull = await greenPull(author(), name);
      expect(await landIfGreen(app, fresh(), pull)).toBe(false);
      expect(reviewRuns(pull)).toHaveLength(1);
      expect(reviewRuns(pull)[0]!.actorId).toBe(quill.id);
      // Asked again: still one pass for this head, still not landed.
      expect(await landIfGreen(app, fresh(), pull)).toBe(false);
      expect(reviewRuns(pull)).toHaveLength(1);

      // A push resets: an approval of the old head means nothing.
      approve(pull, quill);
      const pushed = await commitToBranch(app, alice, repo, {
        branch: `feature/${name}`,
        base: "main",
        message: "more",
        files: [{ path: `${name}-2.ts`, content: "export const m = 1;\n" }],
      });
      if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
      const moved = passCheck(getPull(app.db, repo.id, pull.number)!);
      expect(moved.headOid).not.toBe(pull.headOid);
      expect(await landIfGreen(app, fresh(), moved)).toBe(false);
      expect(getPull(app.db, repo.id, pull.number)?.mergedAt).toBeNull();

      // A person's approval of the new head counts the same.
      approve(moved, alice);
      expect(await landIfGreen(app, fresh(), moved)).toBe(true);
      expect(getPull(app.db, repo.id, pull.number)?.mergedAt).not.toBeNull();
    });
  }

  test("a reviewer asked twice who never answers does not hold the pull: it lands, and says so", async () => {
    setCrewRole(app.db, repo.id, quill.id, "reviewer");
    const pull = await greenPull(mason, "unanswered");
    expect(await landIfGreen(app, fresh(), pull)).toBe(false);
    const ended = () => {
      for (const run of reviewRuns(pull).filter((r) => r.state === "queued")) {
        claimRun(app.db, run.id);
        finishRun(app.db, run.id, {
          state: "failed",
          summary: "reviewed: no verdict was posted",
        });
      }
    };
    ended();
    // Back with nothing: sent once more.
    expect(await landIfGreen(app, fresh(), pull)).toBe(false);
    expect(reviewRuns(pull)).toHaveLength(2);
    ended();
    expect(await landIfGreen(app, fresh(), pull)).toBe(true);
    expect(reviewRuns(pull)).toHaveLength(2);
    expect(
      listComments(app.db, pull.id).map((c) => c.body).join("\n"),
    ).toContain("without a review");
  });

  test("a change requested on the head holds the pull", async () => {
    setCrewRole(app.db, repo.id, quill.id, "reviewer");
    const pull = await greenPull(alice, "contested");
    submitReview(app.db, {
      issueId: pull.id,
      authorId: quill.id,
      state: "changes_requested",
      commitOid: pull.headOid,
    });
    expect(await landIfGreen(app, fresh(), pull)).toBe(false);
    expect(getPull(app.db, repo.id, pull.number)?.mergedAt).toBeNull();
  });

  const askChanges = (pull: Pull, by: User) =>
    submitReview(app.db, {
      issueId: pull.id,
      authorId: by.id,
      state: "changes_requested",
      commitOid: pull.headOid,
    });

  /** Push one more commit to the pull's branch and pass its check. */
  async function pushTo(pull: Pull, name: string): Promise<Pull> {
    const pushed = await commitToBranch(app, alice, repo, {
      branch: pull.headBranch,
      base: "main",
      message: name,
      files: [{ path: `${name}.ts`, content: `export const x = "${name}";\n` }],
    });
    if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
    return passCheck(getPull(app.db, repo.id, pull.number)!);
  }

  test("a reviewer taken off the crew no longer holds the pulls it judged", async () => {
    setCrewRole(app.db, repo.id, quill.id, "reviewer");
    const pull = await greenPull(mason, "judged");
    askChanges(pull, quill);
    expect(reviewSummary(app.db, pull.id, pull.headOid).changesRequested).toBe(1);
    setCrewRole(app.db, repo.id, quill.id, "builder");
    expect(reviewSummary(app.db, pull.id, pull.headOid).changesRequested).toBe(0);
    // A person's request is the person's, whatever their crew.
    askChanges(pull, alice);
    expect(reviewSummary(app.db, pull.id, pull.headOid).changesRequested).toBe(1);
  });

  test(`the reviewer gets ${REVIEW_ROUNDS} rounds of changes; a third is advice and the pull lands`, async () => {
    setCrewRole(app.db, repo.id, quill.id, "reviewer");
    let pull = await greenPull(mason, "rounds");
    askChanges(pull, quill);
    // Asked twice on one head is still one round.
    askChanges(pull, quill);
    pull = await pushTo(pull, "rounds-2");
    askChanges(pull, quill);
    expect(reviewSummary(app.db, pull.id, pull.headOid).changesRequested).toBe(1);
    pull = await pushTo(pull, "rounds-3");
    askChanges(pull, quill);
    expect(reviewSummary(app.db, pull.id, pull.headOid).changesRequested).toBe(0);
    approve(pull, alice);
    expect(await landIfGreen(app, fresh(), pull)).toBe(true);
  });

  test("a builder's run that answers a change request without pushing parks the pull", async () => {
    setCrewRole(app.db, repo.id, quill.id, "reviewer");
    setCrewRole(app.db, repo.id, mason.id, "builder");
    const pull = await greenPull(mason, "unmoved");
    askChanges(pull, quill);
    expect(
      settleAgentRun(app, fresh(), {
        issueId: pull.id,
        state: "ok",
        summary: "no changes pushed: I think it is fine",
        reason: "feedback",
        actorId: mason.id,
      }),
    ).toBe(true);
    expect(getPull(app.db, repo.id, pull.number)?.state).toBe("closed");

    // One that pushed is answering, and is left alone.
    const moved = await greenPull(mason, "moved");
    askChanges(moved, quill);
    expect(
      settleAgentRun(app, fresh(), {
        issueId: moved.id,
        state: "ok",
        summary: `updated pull #${moved.number} (abc1234)`,
        reason: "feedback",
        actorId: mason.id,
      }),
    ).toBe(false);
    expect(getPull(app.db, repo.id, moved.number)?.state).toBe("open");
  });
});
