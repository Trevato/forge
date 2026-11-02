/**
 * No proof before the line (#7779). An approved, green pull joins the merge
 * queue on its own check: the queue's gate is the one full run, and nothing
 * else is run, kept or told to the pull before it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { provideChecksForTest, type ChecksHandle } from "../src/checks/service.ts";
import { listComments } from "../src/core/issues.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { sweepGreen } from "../src/crew/autonomy.ts";
import { nextActor } from "../src/flow/next_actor.ts";
import { logLevel, setLogLevel } from "../src/kernel/log.ts";

let dataDir: string;
let app: App;
let alice: User;
let level: ReturnType<typeof logLevel>;
const gated: string[] = [];

beforeAll(async () => {
  level = logLevel();
  setLogLevel("error");
  dataDir = await mkdtemp(join(tmpdir(), "forge-merge-queue-no-proof-"));
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
  provideChecksForTest(app, {
    gate: async (_repo: Repo, _pull: Pull, commitOid: string) => {
      gated.push(commitOid);
      return { ok: true, error: "", lines: [] };
    },
    spareSlots: () => 0,
  } as unknown as ChecksHandle);
});

afterAll(async () => {
  setLogLevel(level);
  await app.close?.();
  await rm(dataDir, { recursive: true, force: true });
});

test("an approved green pull joins the merge queue and lands with no proof run", async () => {
  const made = await createRepo(app, alice, { name: "no-proof", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  const seeded = await commitToBranch(app, alice, made.value, {
    message: "Start",
    files: [
      { path: "README.md", content: "# no-proof\n" },
      { path: "forge.json", content: JSON.stringify({ check: { run: "true", fast: "true" } }) },
    ],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  app.db.query("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2 WHERE id = ?1").run(made.value.id, alice.id);
  const repo = getRepoById(app.db, made.value.id)!;
  const pushed = await commitToBranch(app, alice, repo, {
    branch: "feature/fine",
    base: "main",
    message: "fine",
    files: [{ path: "fine.ts", content: "export const n = 1;\n" }],
  });
  if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
  const opened = await openPull(app, alice, repo, { title: "fine", baseBranch: "main", headBranch: "feature/fine" });
  if (!opened.ok) throw new Error(String(opened.error));
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

  // Admitted at once: no wait for a proof, so the one sweep lands it.
  expect(await sweepGreen(app, repo)).toBe(1);
  expect(getPull(app.db, repo.id, pull.number)!.mergedAt).not.toBeNull();
  expect(gated).toHaveLength(1);
  expect(listComments(app.db, pull.id)).toHaveLength(0);
  expect(app.db.query("SELECT 1 FROM decision WHERE kind = 'proof'").get()).toBeNull();
});

test("the next-actor line of an approved green pull says nothing of a proof", () => {
  const next = nextActor({ held: null, conflicted: false, check: "ok", changesRequested: 0, approvals: 1, pushedSince: 0 });
  expect(next).toEqual({ who: "queue", why: "approved and green" });
});
