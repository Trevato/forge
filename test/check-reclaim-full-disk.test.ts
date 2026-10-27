/**
 * A check that starts on a disk under its free floor first sweeps the
 * checkouts nobody is using (#6945) — and only those: a checkout whose run
 * is running with a fresh lease is another check's, and stays.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { diskReading } from "../src/checks/disk_red.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { claimRun, createRun, listRuns } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { statDisk } from "../src/kernel/vitals.ts";
import { readRunLog } from "../src/runs/log.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let checks: ChecksHandle;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-check-reclaim-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  checks = startChecks(app, { forgeUrl: servers.url, concurrency: 1 });
});
afterAll(async () => {
  diskReading.read = statDisk;
  await checks.stop();
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a check starting under the floor sweeps the orphan checkout, keeps a live one, and says so", async () => {
  const alice = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!alice.ok) throw new Error(alice.error);
  const made = await createRepo(app, alice.value, { name: "full", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  const repo = made.value;

  const live = createRun(app.db, { repoId: repo.id, kind: "check" });
  expect(claimRun(app.db, live.id)?.state).toBe("running");
  const liveDir = join(dataDir, "checks", live.id);
  const orphan = join(dataDir, "checks", "orphan");
  mkdirSync(liveDir, { recursive: true });
  mkdirSync(orphan, { recursive: true });

  diskReading.read = () => ({ freeBytes: 50, totalBytes: 1000 });
  const c = await commitToBranch(app, alice.value, repo, {
    message: "Declare a check",
    files: [{ path: "forge.json", content: '{"check": {"run": "exit 0"}}\n' }],
  });
  if (!c.ok) throw new Error(JSON.stringify(c.error));

  const deadline = Date.now() + 30_000;
  let mine = listRuns(app.db, repo.id, { kind: "check", limit: 50 }).filter((r) => r.id !== live.id);
  while (Date.now() < deadline && !mine.some((r) => r.state !== "queued" && r.state !== "running")) {
    await Bun.sleep(50);
    mine = listRuns(app.db, repo.id, { kind: "check", limit: 50 }).filter((r) => r.id !== live.id);
  }
  expect(mine.length).toBeGreaterThan(0);
  const log = readRunLog(dataDir, mine[0]!.id).lines;
  expect(log).toContain("disk under its free floor: swept unused checkouts");
  expect(existsSync(orphan)).toBe(false);
  expect(existsSync(liveDir)).toBe(true);
}, 60_000);
