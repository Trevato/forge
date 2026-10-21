/**
 * A merge-queue candidate lands its steps seconds apart, and each landing
 * asks for a check of main (#4061). The check settles before it may start,
 * so the next step supersedes it while still queued: the lane runs main's
 * newest head, not every step the candidate passed through.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Repo } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let checks: ChecksHandle;
let alice: User;
let repo: Repo;

const checkJson = (run: string): string =>
  `{"check": {"run": ${JSON.stringify(run)}, "install": ""}}\n`;

async function finished(where: (r: Run) => boolean): Promise<Run> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const run = listRuns(app.db, repo.id, { kind: "check", limit: 50 }).find(where);
    if (run && (run.state === "ok" || run.state === "failed")) return run;
    await Bun.sleep(50);
  }
  throw new Error("check did not settle");
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-land-settle-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  checks = startChecks(app, { forgeUrl: servers.url, concurrency: 2, landSettleMs: 1_500 });
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
  const made = await createRepo(app, alice, { name: "lib", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
});

afterAll(async () => {
  await checks.stop();
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function pullOf(branch: string, file: string) {
  const branched = await commitToBranch(app, alice, repo, {
    branch,
    message: `Add ${file}`,
    files: [{ path: file, content: "ok\n" }],
  });
  if (!branched.ok) throw new Error(JSON.stringify(branched.error));
  const opened = await openPull(app, alice, repo, { title: file, baseBranch: "main", headBranch: branch });
  if (!opened.ok) throw new Error(String(opened.error));
  return opened.value;
}

test("two landings seconds apart: the first step's main check is superseded before it starts", async () => {
  const declared = await commitToBranch(app, alice, repo, {
    message: "Declare a check",
    files: [{ path: "forge.json", content: checkJson("true") }],
  });
  if (!declared.ok) throw new Error(JSON.stringify(declared.error));
  await finished((r) => r.commitOid === declared.value.commitOid);

  const one = await pullOf("one", "ONE.md");
  const two = await pullOf("two", "TWO.md");
  const first = await mergePull(app, alice, repo, one, "merge");
  if (!first.ok) throw new Error(JSON.stringify(first.error));
  const second = await mergePull(app, alice, repo, two, "merge");
  if (!second.ok) throw new Error(JSON.stringify(second.error));

  const tip = await finished((r) => r.commitOid === second.value.mergeOid);
  expect(tip).toMatchObject({ env: "main", issueId: null, state: "ok" });
  const step = listRuns(app.db, repo.id, { kind: "check", limit: 50 }).find(
    (r) => r.commitOid === first.value.mergeOid,
  );
  expect(step).toMatchObject({
    state: "cancelled",
    startedAt: null,
    summary: `superseded by ${second.value.mergeOid.slice(0, 7)}`,
  });
}, 60_000);
