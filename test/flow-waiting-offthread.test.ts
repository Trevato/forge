/**
 * The ready and approved counts are taken by a worker on a read-only handle
 * of the same file (so the forge's one thread never walks the issues): at the
 * moment it counts, the worker's answer is the answer of the thread.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { APPROVED, READY, readPipeline, waitingOffThread } from "../src/flow/pipeline.ts";

let app: App;

beforeAll(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-waiting-"));
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
  const made = await createRepo(app, a.value, { name: "shop" });
  if (!made.ok) throw new Error(String(made.error));
  const set = await updateRepoSettings(app, a.value, made.value, {
    autonomy: "assisted",
    autonomyDirection: "keep the shop open",
    autonomySlots: 2,
    autonomyCeilingUsd: 15,
    autonomyBy: a.value.id,
  });
  if (!set.ok) throw new Error(String(set.error));
  for (const title of ["Add a cart", "Show the prices", "Take payments"]) {
    const issue = openIssue(app, a.value, set.value, { title });
    if (!issue.ok) throw new Error(String(issue.error));
  }
});

afterAll(() => app.db.close());

test("a worker's ready and approved counts equal the thread's", async () => {
  const stages = readPipeline(app.db);
  const ready = stages.find((s) => s.key === "ready")!;
  const approved = stages.find((s) => s.key === "approved")!;
  expect(ready.waiting).toBeGreaterThanOrEqual(2);
  const r = await waitingOffThread(app.db, READY);
  expect(r.waiting).toBe(ready.waiting);
  expect(r.oldest).toBe(ready.oldestWaiting);
  const p = await waitingOffThread(app.db, APPROVED);
  expect(p.waiting).toBe(approved.waiting);
  expect(p.oldest).toBe(approved.oldestWaiting);
});
