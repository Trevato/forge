/**
 * A landed pull checks main's new head (#1883): landing emits pull.merged,
 * not a push, so a red main only cleared when someone pushed to it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { redMain } from "../src/checks/red_main.ts";
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
  dataDir = await mkdtemp(join(tmpdir(), "forge-land-main-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  checks = startChecks(app, { forgeUrl: servers.url, concurrency: 1 });
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

test("landing a pull on a red main checks the merge commit, and a green one clears the red", async () => {
  const red = await commitToBranch(app, alice, repo, {
    message: "Declare a check that fails",
    files: [{ path: "forge.json", content: checkJson("test -f OK.md") }],
  });
  if (!red.ok) throw new Error(JSON.stringify(red.error));
  const failed = await finished((r) => r.commitOid === red.value.commitOid);
  expect(failed.state).toBe("failed");
  expect(redMain(app.db, repo.id)).toBeDefined();

  const branched = await commitToBranch(app, alice, repo, {
    branch: "fix",
    message: "Make the check pass",
    files: [{ path: "OK.md", content: "ok\n" }],
  });
  if (!branched.ok) throw new Error(JSON.stringify(branched.error));
  const opened = await openPull(app, alice, repo, {
    title: "Fix",
    baseBranch: "main",
    headBranch: "fix",
  });
  if (!opened.ok) throw new Error(String(opened.error));
  const landed = await mergePull(app, alice, repo, opened.value, "merge");
  if (!landed.ok) throw new Error(JSON.stringify(landed.error));
  const { mergeOid } = landed.value;

  const own = await finished((r) => r.commitOid === mergeOid);
  expect(own).toMatchObject({ env: "main", issueId: null, state: "ok" });
  expect(redMain(app.db, repo.id)).toBeUndefined();
}, 60_000);
