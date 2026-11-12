/**
 * The review gate: with a reviewer on the crew, a green pull — a person's or
 * an agent's — is queued for review and lands only on an approval of its
 * current head. An agent's pull never ships by lapse or for want of a
 * reviewer: it waits for a person (#597). A person's own pull lands as
 * before.
 */
import { seatAs } from "./helpers/seat.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import {} from "../src/core/agents.ts";
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
import { sendToReview, waitsForPerson } from "../src/crew/review.ts";
import { askLinesFor } from "../src/web/studio/asks.ts";
import { askForReviews } from "./helpers/reviews.ts";

describe("the review gate", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let mason: User;
  let quill: User;
  let repo: Repo;
  const fresh = () => getRepoById(app.db, repo.id)!;
  /** Whether the owner asks for reviews (#11666); each test starts with them off. */
  const askReviews = (on: boolean) =>
    askForReviews(app.db, repo.id, on);
  afterEach(() => askReviews(false));
  const reviewRuns = (pull: Pull) =>
    listRuns(app.db, repo.id, { issueId: pull.id }).filter(
      (r) => r.reason === "review",
    );

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-review-gate-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, { origin: "seed", trusted: true,
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
    // Read back: the pull as the forge now has it, author and all.
    return passCheck(getPull(app.db, repo.id, opened.value.number)!);
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
      seatAs(app.db, repo.id, quill.id, "reviewer");
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

  /** End every review run still queued on this pull with no verdict. */
  const unanswered = (pull: Pull) => {
    for (const run of reviewRuns(pull).filter((r) => r.state === "queued")) {
      claimRun(app.db, run.id);
      finishRun(app.db, run.id, {
        state: "failed",
        summary: "reviewed: no verdict was posted",
      });
    }
  };

  test("an agent's pull whose review lapses never ships: it waits for a person, and a person's approval lands it", async () => {
    seatAs(app.db, repo.id, quill.id, "reviewer");
    const pull = await greenPull(mason, "unanswered");
    expect(await landIfGreen(app, fresh(), pull)).toBe(false);
    unanswered(pull);
    // Back with nothing: sent once more.
    expect(await landIfGreen(app, fresh(), pull)).toBe(false);
    expect(reviewRuns(pull)).toHaveLength(2);
    unanswered(pull);
    // Lapsed: it does not ship, and is not sent a third time.
    expect(await landIfGreen(app, fresh(), pull)).toBe(false);
    expect(await landIfGreen(app, fresh(), pull)).toBe(false);
    expect(reviewRuns(pull)).toHaveLength(2);
    expect(getPull(app.db, repo.id, pull.number)?.mergedAt).toBeNull();
    expect(waitsForPerson(app.db, repo.id, getPull(app.db, repo.id, pull.number)!)?.why).toBe("lapsed");
    approve(pull, alice);
    expect(waitsForPerson(app.db, repo.id, getPull(app.db, repo.id, pull.number)!)).toBeUndefined();
    expect(await landIfGreen(app, fresh(), pull)).toBe(true);
  });

  test("with no reviewer on the crew an agent's pull waits for a person and says why", async () => {
    seatAs(app.db, repo.id, quill.id, "builder");
    const pull = await greenPull(mason, "no-reviewer");
    askReviews(true); // with them off this pull would land (#11666)
    expect(await landIfGreen(app, fresh(), pull)).toBe(false);
    expect(reviewRuns(pull)).toHaveLength(0);
    expect(waitsForPerson(app.db, repo.id, getPull(app.db, repo.id, pull.number)!)?.why).toBe("no reviewer");
    approve(pull, alice);
    expect(await landIfGreen(app, fresh(), pull)).toBe(true);
  });

  test("with reviews off, a green agent pull lands; changes asked on its head still hold it (#11666)", async () => {
    seatAs(app.db, repo.id, quill.id, "builder");
    const landing = await greenPull(mason, "reviews-off");
    expect(await landIfGreen(app, fresh(), landing)).toBe(true);
    const asked = await greenPull(mason, "reviews-off-changes");
    submitReview(app.db, { issueId: asked.id, authorId: alice.id, state: "changes_requested", commitOid: asked.headOid });
    expect(await landIfGreen(app, fresh(), asked)).toBe(false);
    expect(getPull(app.db, repo.id, asked.number)?.mergedAt).toBeNull();
  });

  test("a person's own pull is unchanged: a review that lapses does not hold it; it lands, and says so", async () => {
    seatAs(app.db, repo.id, quill.id, "reviewer");
    const pull = await greenPull(alice, "person-unanswered");
    expect(await landIfGreen(app, fresh(), pull)).toBe(false);
    unanswered(pull);
    expect(await landIfGreen(app, fresh(), pull)).toBe(false);
    unanswered(pull);
    expect(await landIfGreen(app, fresh(), pull)).toBe(true);
    expect(listComments(app.db, pull.id).map((c) => c.body).join("\n")).toContain("without a review");
    expect(waitsForPerson(app.db, repo.id, pull)).toBeUndefined();
  });

  test("a change requested on the head holds the pull", async () => {
    seatAs(app.db, repo.id, quill.id, "reviewer");
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
    seatAs(app.db, repo.id, quill.id, "reviewer");
    const pull = await greenPull(mason, "judged");
    askChanges(pull, quill);
    expect(reviewSummary(app.db, pull.id, pull.headOid).changesRequested).toBe(1);
    seatAs(app.db, repo.id, quill.id, "builder");
    expect(reviewSummary(app.db, pull.id, pull.headOid).changesRequested).toBe(0);
    // A person's request is the person's, whatever their crew.
    askChanges(pull, alice);
    expect(reviewSummary(app.db, pull.id, pull.headOid).changesRequested).toBe(1);
  });

  test(`the reviewer gets ${REVIEW_ROUNDS} rounds of changes; a third is advice and the pull lands`, async () => {
    seatAs(app.db, repo.id, quill.id, "reviewer");
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
    seatAs(app.db, repo.id, quill.id, "reviewer");
    seatAs(app.db, repo.id, mason.id, "builder");
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

describe("a pull nobody reviewed, however old (#1655)", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let mason: User;
  let repo: Repo;
  const fresh = () => getRepoById(app.db, repo.id)!;
  const later = new Date(Date.now() + 30 * 24 * 3_600_000);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-review-old-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, { name: "engine", visibility: "private" });
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
    seatAs(app.db, repo.id, getUserByName(app.db, "quill")!.id, "reviewer");
  });

  afterAll(async () => {
    await app.close?.();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function greenPull(name: string): Promise<Pull> {
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
    app.db.query("UPDATE issue SET author_id = ?2 WHERE id = ?1").run(opened.value.id, mason.id);
    const pull = getPull(app.db, repo.id, opened.value.number)!;
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

  const setAutonomy = (mode: "assisted" | "autonomous") =>
    app.db
      .query("UPDATE repo SET autonomy = ?2, autonomy_by = ?3 WHERE id = ?1")
      .run(repo.id, mode, alice.id);
  const reviewRuns = (pull: Pull) =>
    listRuns(app.db, repo.id, { issueId: pull.id }).filter((r) => r.reason === "review");

  test("an autonomous repository sends it to review at any age; an assisted one leaves it lapsed", async () => {
    const pull = await greenPull("ancient");
    setAutonomy("assisted");
    expect(await sendToReview(app, fresh(), pull, later)).toBe("lapsed");
    expect(reviewRuns(pull)).toHaveLength(0);
    setAutonomy("autonomous");
    expect(await sendToReview(app, fresh(), pull, later)).toBe("sent");
    expect(reviewRuns(pull)).toHaveLength(1);
  });

  test("the lapsed-review ask is the sweep's only while nothing was ever sent, and only when autonomous", async () => {
    const pull = await greenPull("lapsing");
    const asking = () =>
      askLinesFor(app.db, alice).some((r) => r.items.includes(`review:${pull.id}`));
    // Age the green check: the ask reads the wall clock.
    app.db.query("UPDATE run SET created_at = ?2, finished_at = ?2 WHERE issue_id = ?1 AND kind = 'check'")
      .run(pull.id, new Date(Date.now() - 30 * 24 * 3_600_000).toISOString());
    setAutonomy("assisted");
    expect(asking()).toBe(false); // assisted repositories ask through "look", not "review"
    setAutonomy("autonomous");
    expect(asking()).toBe(false);
    // Sent once and unanswered, it is lapsed with a history: it asks a person.
    const old = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
    expect(await sendToReview(app, fresh(), getPull(app.db, repo.id, pull.number)!, later)).toBe("sent");
    for (const run of reviewRuns(pull).filter((r) => r.state === "queued")) {
      claimRun(app.db, run.id);
      finishRun(app.db, run.id, { state: "failed", summary: "reviewed: no verdict was posted" });
    }
    app.db.query("UPDATE run SET created_at = ?2, finished_at = ?2 WHERE issue_id = ?1 AND reason = 'review'").run(pull.id, old);
    expect(asking()).toBe(true);
  });
});
