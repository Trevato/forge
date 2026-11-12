/**
 * The queue's half of the disk guard (#11799): while the forge's disk is
 * 80% used no queued check is picked. It stays queued, its log says why
 * once, and the tick that finds room starts it.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { listRuns } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { provideDiskForTest } from "../src/kernel/disk_reading.ts";
import { readRunLog } from "../src/runs/log.ts";

process.env["FORGE_CELLS"] = "off";

const TOTAL = 1000 * 1024 ** 3;
/** The share of the disk used, as every default reading sees it. */
let used = 0.81;

let dataDir: string;
let app: App;
let checks: ChecksHandle;

beforeAll(async () => {
  provideDiskForTest(() => ({ freeBytes: Math.round(TOTAL * (1 - used)), totalBytes: TOTAL }));
  dataDir = await mkdtemp(join(tmpdir(), "forge-disk-hold-"));
  app = createApp({ dataDir, port: 0 });
  checks = startChecks(app, { forgeUrl: "http://forge.test", concurrency: 1 });
});

afterAll(async () => {
  await checks.stop({ drain: false });
  app.close();
  await rm(dataDir, { recursive: true, force: true });
  // Back to the suite's roomy disk (`helpers/roomy-disk.ts`).
  provideDiskForTest(() => ({ freeBytes: 900 * 1024 ** 3, totalBytes: TOTAL }));
});

const until = async <T>(find: () => T | undefined, timeoutMs = 15_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = find();
    if (found !== undefined) return found;
    await Bun.sleep(20);
  }
  throw new Error("did not happen in time");
};

test("at 81% used a queued check stays queued with one line; at 79% it starts", async () => {
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  const made = await createRepo(app, u.value, { name: "kiln", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  const repo = made.value;
  const pushed = await commitToBranch(app, u.value, repo, {
    message: "A check",
    files: [{ path: "forge.json", content: `{"check": {"run": "exit 0", "install": ""}}\n` }],
  });
  if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
  const oid = pushed.value.commitOid;
  const check = () => listRuns(app.db, repo.id, { kind: "check", limit: 50 }).find((r) => r.commitOid === oid);

  const queued = await until(check);
  const held = await until(() => {
    const log = readRunLog(dataDir, queued.id).lines.join("\n");
    return log.includes("queued, not started: this host's disk is 81.0% used") ? log : undefined;
  });
  // A tick passes and the check is still queued, its line said once.
  await Bun.sleep(5_500);
  expect(check()?.state).toBe("queued");
  const lines = readRunLog(dataDir, queued.id).lines.filter((l) => l.includes("this host's disk is"));
  expect(lines).toHaveLength(1);
  expect(held).toContain("80% builds wait for");

  used = 0.79;
  const done = await until(() => {
    const run = check();
    return run && run.state !== "queued" && run.state !== "running" ? run : undefined;
  });
  expect(done.state).toBe("ok");
}, 30_000);
