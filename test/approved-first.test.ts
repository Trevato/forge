/**
 * Which queued checks count as an approved pull's (#6396), read from real
 * reviews and fed to `pickNext` the way the checks service feeds it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { cancelRun, createRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { approvedForCheck, approvedOnce } from "../src/checks/approved_first.ts";
import { pickNext } from "../src/checks/service.ts";

let dataDir: string;
let app: App;
let alice: User;
let repo: Repo;

async function pull(n: number): Promise<Pull> {
  const branch = await commitToBranch(app, alice, repo, {
    branch: `feature/${n}`,
    base: "main",
    message: `Change ${n}`,
    files: [{ path: `f${n}.ts`, content: `export const f = ${n};\n` }],
  });
  if (!branch.ok) throw new Error(JSON.stringify(branch.error));
  const opened = await openPull(app, alice, repo, {
    title: `Change ${n}`,
    body: "",
    baseBranch: "main",
    headBranch: `feature/${n}`,
  });
  if (!opened.ok) throw new Error(String(opened.error));
  return opened.value;
}

const review = (p: Pull, state: "approved" | "changes_requested", commitOid = p.headOid) => {
  const r = submitReview(app.db, { issueId: p.id, authorId: alice.id, state, commitOid });
  if (!r.ok) throw new Error(r.error);
};

const check = (p: Pull, commitOid = p.headOid) =>
  createRun(app.db, { repoId: repo.id, kind: "check", env: `pull-${p.number}`, issueId: p.id, commitOid });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-approved-first-"));
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
  const made = await createRepo(app, alice, { name: "lane", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  const seeded = await commitToBranch(app, alice, repo, {
    message: "Start",
    files: [{ path: "a.ts", content: "export const a = 0;\n" }],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the older approved pull's check takes the slot; superseded and contested heads do not", async () => {
  const old = await pull(1);
  const contested = await pull(2);
  const superseded = await pull(3);
  const fresh = await pull(4);
  review(old, "approved");
  review(contested, "approved");
  review(contested, "changes_requested");
  // Approved on a head the pull has since moved past; the queued check is of the new one.
  review(superseded, "approved", "0".repeat(40));
  const runs = [old, contested, superseded, fresh].map((p) => check(p));
  const [oldRun, contestedRun, supersededRun, freshRun] = runs as [
    (typeof runs)[number], (typeof runs)[number], (typeof runs)[number], (typeof runs)[number],
  ];

  expect(approvedForCheck(app.db, oldRun)).toBe(true);
  expect(approvedForCheck(app.db, contestedRun)).toBe(false);
  expect(approvedForCheck(app.db, supersededRun)).toBe(false);
  expect(approvedForCheck(app.db, freshRun)).toBe(false);

  const now = Date.parse(freshRun.createdAt);
  expect(pickNext(runs, now, approvedOnce(app.db))?.id).toBe(oldRun.id);
  // Without it, the newest would have taken the slot.
  expect(pickNext(runs.filter((r) => r.id !== oldRun.id), now, approvedOnce(app.db))?.id).toBe(
    freshRun.id,
  );
  for (const run of runs) cancelRun(app.db, run.id);
});

test("a run with no pull is never approved, and each run is asked once", async () => {
  const p = await pull(5);
  review(p, "approved");
  const run = check(p);
  expect(approvedForCheck(app.db, { issueId: null, commitOid: p.headOid })).toBe(false);
  const ask = approvedOnce(app.db);
  expect(ask(run)).toBe(true);
  // A later change request is not seen: the answer was memoised for this pick.
  review(p, "changes_requested");
  expect(ask(run)).toBe(true);
  expect(approvedOnce(app.db)(run)).toBe(false);
  cancelRun(app.db, run.id);
});
