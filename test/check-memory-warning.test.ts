/** A declared memory above the ceiling is said in the check's log, and in the kill text (#3128). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { watchTree, WATCH, type Limits } from "../src/apps/contain.ts";
import { isTerminal, listRuns } from "../src/core/runs.ts";
import { readRunLog } from "../src/runs/log.ts";
import { createUser } from "../src/core/users.ts";

process.env["FORGE_CELLS"] = "off";
const savedCeiling = process.env["FORGE_CELL_MEMORY_MAX_MIB"];
process.env["FORGE_CELL_MEMORY_MAX_MIB"] = "4096";

let dataDir: string;
let app: App;
let checks: ChecksHandle;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-memwarn-"));
  app = createApp({ dataDir, port: 0 });
  checks = startChecks(app, { forgeUrl: "http://forge.test", concurrency: 1 });
});

afterAll(async () => {
  await checks.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
  if (savedCeiling === undefined) delete process.env["FORGE_CELL_MEMORY_MAX_MIB"];
  else process.env["FORGE_CELL_MEMORY_MAX_MIB"] = savedCeiling;
});

test("a check declaring memory above the ceiling logs the warning before its command", async () => {
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  const made = await createRepo(app, u.value, { name: "big", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  const repo = made.value;
  const pushed = await commitToBranch(app, u.value, repo, {
    message: "Asks for more memory than the machine grants",
    files: [
      {
        path: "forge.json",
        content: `{"check": {"run": "true", "install": "", "limits": {"memory": 8192}}}\n`,
      },
    ],
  });
  if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
  const oid = pushed.value.commitOid;

  const deadline = Date.now() + 30_000;
  const mine = () =>
    listRuns(app.db, repo.id, { kind: "check", limit: 50 }).find(
      (r) => r.commitOid === oid && isTerminal(r.state),
    );
  while (Date.now() < deadline && mine() === undefined) await Bun.sleep(100);
  if (mine() === undefined) throw new Error(`never came: still waiting while mine() === undefined`);
  const run = mine()!;
  const lines = readRunLog(dataDir, run.id).lines;
  const warned = lines.findIndex((l) => l.startsWith("warning: forge.json declares memory 8192 MiB"));
  const ran = lines.findIndex((l) => l.startsWith("$ "));
  expect(warned).toBeGreaterThanOrEqual(0);
  expect(lines[warned]).toContain("grants at most 4096");
  expect(ran).toBeGreaterThan(warned);
}, 60_000);

test("the breach text names where the limit came from", async () => {
  const saved = { ...WATCH };
  WATCH.tickMs = 100;
  const hog = Bun.spawn(
    ["bun", "-e", "const a = new Uint8Array(200 << 20).fill(1); await Bun.sleep(20000); console.log(a.length)"],
    { stdout: "ignore", stderr: "ignore" },
  );
  try {
    const why = await new Promise<string>((resolve) => {
      const limits: Limits = { memoryMiB: 64, memorySource: "ceiling", ceilingFrom: "env", cpus: 64, diskMiB: 1 << 20 };
      const unwatch = watchTree(hog.pid, limits, { bytes: 64 << 20, by: "watch" }, [], undefined, (w) => {
        unwatch();
        resolve(w);
      });
    });
    expect(why).toMatch(/^used \d+ MiB of memory, over its 64 MiB limit \(the machine's ceiling, FORGE_CELL_MEMORY_MAX_MIB;/);
  } finally {
    hog.kill();
    Object.assign(WATCH, saved);
  }
}, 30_000);
