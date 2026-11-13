/**
 * #11834: the Ready stage's age is when an issue became ready, not when it
 * was opened. An issue opened 56 days ago whose blocker closed an hour ago,
 * or whose last agent run ended an hour ago, has waited an hour for a
 * builder; reading 56 days named Ready the bottleneck while checks (27 min)
 * were the real, and only, queue.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { bottleneck, readPipeline } from "../src/flow/pipeline.ts";

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
let dataDir: string;
let app: App;

const ready = () => readPipeline(app.db).find((s) => s.key === "ready")!;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-ready-since-"));
  app = createApp({ dataDir, port: 0 });
});
afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("ready age starts at the unblocking or the last run's end, not at opening", async () => {
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "a@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  const made = await createRepo(app, u.value, { name: "shop" });
  if (!made.ok) throw new Error(String(made.error));
  const set = await updateRepoSettings(app, u.value, made.value, {
    autonomy: "assisted", autonomyDirection: "x", autonomySlots: 2, autonomyCeilingUsd: 15, autonomyBy: u.value.id,
  });
  if (!set.ok) throw new Error(String(set.error));
  const repo = set.value;
  const open = (title: string, at: number) => {
    const i = openIssue(app, u.value, repo, { title });
    if (!i.ok) throw new Error(String(i.error));
    app.db.query("UPDATE issue SET created_at = ?1 WHERE id = ?2").run(ago(at), i.value.id);
    return i.value;
  };

  // Untouched since opening: waited since opening.
  const plain = open("plain", 56 * 24 * HOUR);
  expect(ready().oldestWaiting).toBe((app.db.query("SELECT created_at c FROM issue WHERE id = ?1").get(plain.id) as { c: string }).c);

  // Blocked for weeks, the blocker closed an hour ago: waiting one hour.
  app.db.query("UPDATE issue SET created_at = ?1 WHERE id = ?2").run(ago(HOUR / 4), plain.id);
  const blocker = open("blocker", 60 * 24 * HOUR);
  const blocked = open("blocked", 56 * 24 * HOUR);
  const linked = addDependency(app.db, blocked, blocker, u.value.id);
  if (!linked.ok) throw new Error(linked.error);
  expect(ready().waiting).toBe(2); // plain + blocker
  const closedAt = ago(HOUR);
  app.db.query("UPDATE issue SET state = 'closed', closed_at = ?1 WHERE id = ?2").run(closedAt, blocker.id);
  expect(ready().waiting).toBe(2); // plain + blocked
  expect(ready().oldestWaiting).toBe(closedAt);

  // A builder's run on `plain` ended two hours ago and left nothing in flight.
  const run = createRun(app.db, { repoId: repo.id, kind: "agent", reason: "assigned", issueId: blocked.id });
  const ended = ago(30 * 60_000);
  app.db.query("UPDATE run SET state = 'failed', finished_at = ?1 WHERE id = ?2").run(ended, run.id);
  expect(ready().oldestWaiting).toBe(ended > closedAt ? ended : closedAt);
  expect(bottleneck(readPipeline(app.db))?.key).toBe("ready");
});
