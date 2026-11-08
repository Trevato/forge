/**
 * An approved pull red for 24 h gets one re-check per head, then goes back
 * to its builder naming the failing test (#6349). `now` is passed in.
 */
import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { provideChecksForTest, type ChecksHandle } from "../src/checks/service.ts";
import {} from "../src/core/agents.ts";
import { listComments } from "../src/core/issues.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { listReviews, submitReview } from "../src/core/reviews.ts";
import { claimRun, createRun, finishRun, INFRA_SUMMARY, listRuns } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { recheckRedApproved } from "../src/crew/red_approved.ts";

let dataDir: string;
let app: App;
let repo: Repo;
let pull: Pull;
let quill: User;

const HOUR = 3_600_000;
const t0 = Date.now();
const rechecks = () =>
  listRuns(app.db, repo.id, { kind: "check" }).filter((r) => r.reason === "recheck");

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-red-approved-"));
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
  const alice = a.value;
  const made = await createRepo(app, alice, { name: "engine", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  await commitToBranch(app, alice, repo, { message: "Start", files: [{ path: "a.ts", content: "1\n" }] });
  for (const name of ["mason", "quill"]) {
    await createAgent(app, alice, { username: name });
    addToCrew(app, alice, repo, name);
  }
  const mason = getUserByName(app.db, "mason")!;
  quill = getUserByName(app.db, "quill")!;
  seatAs(app.db, repo.id, quill.id, "reviewer");
  await commitToBranch(app, alice, repo, {
    branch: "feature/x",
    base: "main",
    message: "X",
    files: [{ path: "x.ts", content: "2\n" }],
  });
  const opened = await openPull(app, mason, repo, {
    title: "X",
    body: "",
    baseBranch: "main",
    headBranch: "feature/x",
  });
  if (!opened.ok) throw new Error(String(opened.error));
  pull = opened.value;
  submitReview(app.db, { issueId: pull.id, authorId: quill.id, state: "approved", commitOid: pull.headOid });
  app.db.query("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2 WHERE id = ?1").run(repo.id, alice.id);
  repo = { ...repo, autonomy: "autonomous", autonomyBy: alice.id };
  const request: ChecksHandle["request"] = async (r, env, oid, reason, issueId) =>
    createRun(app.db, { repoId: r.id, kind: "check", env, commitOid: oid, reason, issueId });
  provideChecksForTest(app, { request } as unknown as ChecksHandle);
  // The pull's own check, red since 25 h before t0.
  const run = createRun(app.db, { repoId: repo.id, kind: "check", env: `pull-${pull.number}`, commitOid: pull.headOid, issueId: pull.id });
  claimRun(app.db, run.id);
  finishRun(app.db, run.id, { state: "failed", summary: "check failed", checkDetail: { passed: 3, failed: 1, names: ["parses the flag"] } });
  app.db.query("UPDATE run SET finished_at = ?1 WHERE id = ?2").run(new Date(t0 - 25 * HOUR).toISOString(), run.id);
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("red for 23 h is left alone", async () => {
  expect(await recheckRedApproved(app, repo, new Date(t0 - 2 * HOUR))).toEqual([]);
  expect(rechecks()).toHaveLength(0);
});

test("a check of another reason already in flight on the head: no comment, no move, no re-check", async () => {
  const other = createRun(app.db, { repoId: repo.id, kind: "check", env: `pull-${pull.number}`, commitOid: pull.headOid, issueId: pull.id, reason: "push" });
  for (const n of [0, 1]) expect(await recheckRedApproved(app, repo, new Date(t0 + n * HOUR))).toEqual([]);
  expect(rechecks()).toHaveLength(0);
  expect(listComments(app.db, pull.id).filter((c) => c.body.includes("re-check"))).toHaveLength(0);
  app.db.query("DELETE FROM run WHERE id = ?1").run(other.id);
});

test("25 h red gets one re-check, and the second tick queues none", async () => {
  const first = await recheckRedApproved(app, repo, new Date(t0));
  expect(first).toEqual([{ pull: pull.number, did: "re-check queued" }]);
  expect(rechecks()).toHaveLength(1);
  expect(listComments(app.db, pull.id).some((c) => c.body.includes("One re-check is queued"))).toBe(true);
  expect(await recheckRedApproved(app, repo, new Date(t0 + HOUR))).toEqual([]);
  expect(rechecks()).toHaveLength(1);
});

test("a re-check still running or ended green is left alone", async () => {
  const run = rechecks()[0]!;
  const reviews = listReviews(app.db, pull.id).length;
  for (const state of ["queued", "running", "ok"]) {
    app.db.query("UPDATE run SET state = ?1 WHERE id = ?2").run(state, run.id);
    expect(await recheckRedApproved(app, repo, new Date(t0 + 2 * HOUR))).toEqual([]);
  }
  expect(listReviews(app.db, pull.id)).toHaveLength(reviews);
  app.db.query("UPDATE run SET state = 'queued' WHERE id = ?1").run(run.id);
});

test("a re-check that failed on infrastructure does not hand the pull back", async () => {
  const run = rechecks()[0]!;
  const reviews = listReviews(app.db, pull.id).length;
  app.db.query("UPDATE run SET state = 'failed', summary = ?1 WHERE id = ?2").run(INFRA_SUMMARY, run.id);
  expect(await recheckRedApproved(app, repo, new Date(t0 + 2 * HOUR))).toEqual([]);
  expect(listReviews(app.db, pull.id)).toHaveLength(reviews);
  expect(rechecks()).toHaveLength(1);
  app.db.query("UPDATE run SET state = 'queued', summary = '' WHERE id = ?1").run(run.id);
});

test("red after the re-check hands the pull back, naming the test", async () => {
  const run = rechecks()[0]!;
  claimRun(app.db, run.id);
  finishRun(app.db, run.id, { state: "failed", summary: "check failed", checkDetail: { passed: 3, failed: 1, names: ["parses the flag"] } });
  expect(await recheckRedApproved(app, repo, new Date(t0 + 2 * HOUR))).toEqual([{ pull: pull.number, did: "handed back" }]);
  const last = listReviews(app.db, pull.id).at(-1)!;
  expect(last.state).toBe("changes_requested");
  expect(last.authorName).toBe("quill");
  expect(last.body).toContain("parses the flag");
  // Changes requested: no longer approved, so nothing more is done.
  expect(await recheckRedApproved(app, repo, new Date(t0 + 3 * HOUR))).toEqual([]);
  expect(rechecks()).toHaveLength(1);
});
