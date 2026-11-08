/**
 * A review run reviews. Its task is the review; the conversation on the pull
 * is context, and a comment addressed to the builder never becomes the
 * reviewer's task (#1237). A review that ends with no verdict is sent again,
 * to the other reviewer when the crew has one.
 */
import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import {} from "../src/core/agents.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun, listRuns } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { taskPrompt } from "../src/crew/brief.ts";
import { sendToReview } from "../src/crew/review.ts";

const base = {
  agent: { user: { username: "sentinel", displayName: "" } },
  repo: { ownerName: "alice", name: "engine", autonomyDirection: "" },
  issue: { number: 1130, title: "Widen", body: "", authorName: "scout" },
  branch: "sentinel/1130",
  forgeUrl: "http://forge.test",
  isApp: false,
  resuming: false,
  reason: "review" as const,
  reviews: [],
  reviewDiff: "+ the change",
};
const prompt = (extra: object) =>
  taskPrompt({ ...base, ...extra } as unknown as Parameters<typeof taskPrompt>[0]);

describe("the review prompt", () => {
  const nudge = {
    authorName: "alice",
    body: "@scout please rebase and push the fix",
  };

  test("states the task first, before any comment", () => {
    const p = prompt({ comments: [nudge] });
    expect(p.startsWith("Your task: review pull #1130")).toBe(true);
    expect(p.indexOf("Your task")).toBeLessThan(p.indexOf("please rebase"));
  });

  test("a comment to the builder is shown as addressed to them, and as context", () => {
    const p = prompt({ comments: [nudge] });
    expect(p).toContain("please rebase and push the fix");
    expect(p).toContain("addressed to @scout, not to you");
    expect(p).toContain("for context only");
    expect(p.trimEnd().endsWith("Then stop.")).toBe(true);
  });

  test("no conversation, no section; a retry restates the task", () => {
    expect(prompt({ comments: [] })).not.toContain("for context only");
    expect(prompt({ comments: [] })).not.toContain("ended without a verdict");
    expect(prompt({ comments: [], retry: true })).toContain(
      "ended without a verdict",
    );
  });
});

describe("a review that comes back with no verdict", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-review-retry-"));
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
    const made = await createRepo(app, alice, { name: "engine", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# engine\n" }],
    });
    for (const [name, brief] of [
      ["scout", "I am Scout."],
      ["juniper", "I am Juniper. I review the experience."],
      ["sentinel", "I am Sentinel. I read for security."],
    ] as const) {
      const m = await createAgent(app, alice, { username: name, brief });
      if (!m.ok) throw new Error(String(m.error));
      expect(addToCrew(app, alice, repo, name).ok).toBe(true);
    }
    for (const name of ["juniper", "sentinel"])
      seatAs(app.db, repo.id, getUserByName(app.db, name)!.id, "reviewer");
  });

  afterAll(async () => {
    await app.close?.();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("is sent once more, to the other reviewer", async () => {
    await commitToBranch(app, alice, repo, {
      branch: "feature/x",
      base: "main",
      message: "x",
      files: [{ path: "docs/x.md", content: "x\n" }],
    });
    const opened = await openPull(app, alice, repo, {
      title: "x",
      baseBranch: "main",
      headBranch: "feature/x",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    app.db
      .query("UPDATE issue SET author_id = ?2 WHERE id = ?1")
      .run(pull.id, getUserByName(app.db, "scout")!.id);
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

    expect(await sendToReview(app, repo, pull)).toBe("sent");
    const first = listRuns(app.db, repo.id, { issueId: pull.id }).filter(
      (r) => r.reason === "review",
    )[0]!;
    claimRun(app.db, first.id);
    finishRun(app.db, first.id, {
      state: "failed",
      summary: "declined: this message is addressed to scout",
    });

    expect(await sendToReview(app, repo, pull)).toBe("sent");
    const reviews = listRuns(app.db, repo.id, { issueId: pull.id }).filter(
      (r) => r.reason === "review",
    );
    expect(reviews).toHaveLength(2);
    expect(new Set(reviews.map((r) => r.actorId)).size).toBe(2);
  });
});
