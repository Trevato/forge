/** The pulls list reads every row's step in one batch (#8387): the same step `stepOfStored` gives each pull, read fast. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { recordDecision } from "../src/core/decisions.ts";
import { setHold } from "../src/core/holds.ts";
import { createIssue, setIssueState } from "../src/core/issues.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { stepOfStored, stepsOfStored } from "../src/flow/path.ts";
import { quietLogs } from "./helpers/globals.ts";
import { statements } from "./helpers/statements.ts";
import { expectWork } from "./helpers/work.ts";
import { askForReviews } from "./helpers/reviews.ts";

quietLogs();

let dataDir = "";
let app: App;
let alice: User, bob: User;
let repo: Repo;

const user = async (username: string): Promise<User> => {
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username,
    email: `${username}@forge.local`,
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  return made.value;
};

const oid = (n: number, salt = "a"): string => `${salt}${n.toString(16)}`.padEnd(40, "0");

/** A pull row written straight to the database: the step reads rows, not the repository. */
function pull(n: number, base = "main"): Pull {
  const issue = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title: `p${n}`, kind: "pull" });
  if (!issue.ok) throw new Error(String(issue.error));
  app.db
    .query(
      `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .run(issue.value.id, base, `b${n}`, oid(0, "b"), oid(n), repo.id);
  return getPull(app.db, repo.id, issue.value.number)!;
}

const setRun = (id: string, state: string): void => {
  app.db.query("UPDATE run SET state = ?1 WHERE id = ?2").run(state, id);
};

const reread = (p: Pull): Pull => getPull(app.db, repo.id, p.number)!;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-steps-"));
  app = createApp({ dataDir, port: 0 });
  alice = await user("alice");
  bob = await user("bob");
  const made = await createRepo(app, alice, { name: "steps", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  // These pulls wait on a review, as reviews asked for say (#11666).
  askForReviews(app.db, made.value.id);
  repo = { ...made.value, requireReview: true };
  const record = createAppRecord(app.db, { repoId: repo.id, slug: "steps", access: "public" });
  if (!record.ok) throw new Error(record.error);
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("the batch gives each open, merged and closed pull the same step as stepOfStored", () => {
  const pulls: Pull[] = [];
  for (let n = 1; n <= 24; n++) {
    const p = pull(n, n % 12 === 11 ? "other" : "main");
    const head = p.headOid;
    // Every fact the step reads, varied across the rows.
    if (n % 6 !== 0) {
      const run = createRun(app.db, { repoId: repo.id, kind: "check", issueId: p.id, commitOid: head });
      setRun(run.id, (["queued", "running", "ok", "failed", "cancelled"] as const)[n % 5]!);
    }
    // An older check on another head never counts.
    if (n % 4 === 0) setRun(createRun(app.db, { repoId: repo.id, kind: "check", issueId: p.id, commitOid: oid(n, "c") }).id, "failed");
    if (n % 3 === 0)
      submitReview(app.db, { issueId: p.id, authorId: bob.id, state: "approved", commitOid: head });
    if (n % 7 === 0)
      submitReview(app.db, { issueId: p.id, authorId: bob.id, state: "changes_requested", commitOid: n % 2 ? head : oid(n, "c") });
    if (n % 8 === 0) setHold(app.db, p.id, alice.id, "waiting on a call");
    if (n % 9 === 0)
      recordDecision(app.db, {
        kind: "land",
        repoId: repo.id,
        issueId: p.id,
        state: { head, plain: ["reaches example.com"] },
        answer: "wall",
        p: 1,
        by: "test",
        ms: 0,
      });
    pulls.push(p);
  }
  // Some land before production serves a deploy, some after; some close unmerged.
  const merge = (p: Pull, at: string): void => {
    app.db.query("UPDATE pull SET merged_at = ?1 WHERE issue_id = ?2").run(at, p.id);
    setIssueState(app.db, p.id, "closed");
  };
  merge(pulls[2]!, "2026-01-01T00:00:00.000Z");
  merge(pulls[10]!, "2026-01-01T00:00:00.000Z");
  merge(pulls[13]!, "2099-01-01T00:00:00.000Z");
  setIssueState(app.db, pulls[4]!.id, "closed");
  setIssueState(app.db, pulls[5]!.id, "closed");
  const deploy = createRun(app.db, { repoId: repo.id, kind: "deploy", env: "production", commitOid: oid(1) });
  app.db.query("UPDATE run SET created_at = '2026-06-01T00:00:00.000Z', serving_at = created_at WHERE id = ?1").run(deploy.id);

  const all = pulls.map(reread);
  const batch = stepsOfStored(app.db, repo, all);
  expect(batch.size).toBe(all.length);
  for (const p of all) expect({ n: p.number, step: batch.get(p.id) }).toEqual({ n: p.number, step: stepOfStored(app.db, repo, p) });
  // The fixture reaches every branch it means to.
  const steps = [...batch.values()];
  expect(steps.filter((s) => s === null).length).toBe(2);
  expect(new Set(steps.map((s) => s?.step))).toEqual(new Set(["check", "review", "land", "live", undefined]));
  expect(steps.some((s) => s?.step === "live" && s.done)).toBe(true);
  expect(steps.some((s) => s?.step === "live" && !s.done)).toBe(true);
  expect(steps.some((s) => s?.why.includes("holds it"))).toBe(true);
  expect(steps.some((s) => s?.why.includes("access wall"))).toBe(true);
  expect(stepsOfStored(app.db, repo, []).size).toBe(0);
});

test("fifty open pulls read their steps in the statements five do: one batch, not one per row", async () => {
  const pulls: Pull[] = [];
  for (let n = 100; n < 150; n++) {
    const p = pull(n);
    setRun(createRun(app.db, { repoId: repo.id, kind: "check", issueId: p.id, commitOid: p.headOid }).id, n % 2 ? "ok" : "running");
    if (n % 3 === 0) submitReview(app.db, { issueId: p.id, authorId: bob.id, state: "approved", commitOid: p.headOid });
    pulls.push(p);
  }
  expect(stepsOfStored(app.db, repo, pulls).size).toBe(50);
  const five = await statements(app.db, () => void stepsOfStored(app.db, repo, pulls.slice(0, 5)));
  const fifty = await statements(app.db, () => void stepsOfStored(app.db, repo, pulls));
  expect(fifty).toBe(five);
  expectWork(fifty, { max: 5 });
});
