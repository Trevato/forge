/**
 * A check past its budget is killed, queued again once, and on the second
 * overrun failed and carried by the vitals as a card (#1271).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { BUDGETS, budgetSummary } from "../src/kernel/budgets.ts";
import { vitals } from "../src/kernel/vitals.ts";
import { listRuns } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";

process.env["FORGE_CELLS"] = "off";

let dataDir: string;
let app: App;
let checks: ChecksHandle;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-budget-"));
  app = createApp({ dataDir, port: 0 });
  checks = startChecks(app, {
    forgeUrl: "http://forge.test",
    concurrency: 1,
    budgetMs: 1_500,
  });
});

afterAll(async () => {
  await checks.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the summary names the thing, the time and the limit", () => {
  expect(budgetSummary("a full gate", 18 * 60_000, BUDGETS.gate)).toBe(
    "budget: a full gate took 18 min, limit 60",
  );
});

test("a check past its budget is re-queued once; the second overrun fails it and is a card", async () => {
  const u = await createUser(app.db, {
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  const made = await createRepo(app, u.value, {
    name: "slow",
    visibility: "public",
  });
  if (!made.ok) throw new Error(String(made.error));
  const repo = made.value;
  const pushed = await commitToBranch(app, u.value, repo, {
    message: "A check that never ends",
    files: [
      {
        path: "forge.json",
        content: `{"check": {"run": "sleep 30", "install": ""}}\n`,
      },
    ],
  });
  if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
  const oid = pushed.value.commitOid;

  const deadline = Date.now() + 30_000;
  let runs = listRuns(app.db, repo.id, { kind: "check", limit: 50 });
  while (
    Date.now() < deadline &&
    !runs.some((r) => r.commitOid === oid && r.state === "failed")
  ) {
    await Bun.sleep(100);
    runs = listRuns(app.db, repo.id, { kind: "check", limit: 50 });
  }
  const mine = runs.filter((r) => r.commitOid === oid);
  expect(mine).toHaveLength(2);
  const first = mine.find((r) => r.attempt === 0)!;
  const second = mine.find((r) => r.attempt === 1)!;
  expect(first.state).toBe("cancelled");
  expect(first.summary).toBe("budget: a full gate took 1 min, limit 1");
  expect(second.state).toBe("failed");
  expect(second.summary).toMatch(/^budget: a full gate took \d+ min, limit \d+$/);

  const seen = vitals({ db: app.db, signals: app.signals, dataDir });
  expect(seen.ok).toBe(false);
  expect(seen.needs.some((n) => n.includes("budget: a full gate"))).toBe(true);
}, 60_000);
