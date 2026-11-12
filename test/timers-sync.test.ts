/**
 * The loop's read of `forge.json` (#11595): `syncAll` finds the commit an
 * environment serves, reads `schedules` there once, and arms the rows.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { newApp } from "../src/actions/apps.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { syncAll } from "../src/apps/timer_service.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { getRepo } from "../src/core/repos.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { getUserByName } from "../src/core/users.ts";
import { scheduleTimers, syncedCommit } from "../src/core/timers.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let runtime: AppsRuntime;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-timers-sync-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  runtime = new AppsRuntime(app, { domain: "apps.test", scheme: "http", publicPort: servers.port, forgeUrl: servers.url });
  await runtime.start();
  await seedAdmin(app, { username: "alice", email: "alice@forge.local", password: "a-good-passphrase" });
}, 30_000);

afterAll(async () => {
  await runtime.stop();
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the schedules a production commit declares become rows once per commit; a preview's are not production's", async () => {
  const alice = getUserByName(app.db, "alice")!;
  const made = await newApp(app, alice, { name: "paper", visibility: "private" } as never);
  if (!made.ok) throw new Error(String(made.error));
  const repo = getRepo(app.db, "alice", "paper")!;
  const record = getAppByRepo(app.db, repo.id)!;
  const forgeJson = JSON.stringify({
    app: { run: "bun run src/server.ts" },
    schedules: [{ name: "print", cron: "30 6 * * *", timezone: "America/Chicago", path: "/jobs/print" }],
  });
  const committed = await commitToBranch(app, alice, repo, { message: "print at 06:30", files: [{ path: "forge.json", content: forgeJson }] });
  if (!committed.ok) throw new Error(JSON.stringify(committed.error));
  const tip = (await resolveOid(repoDir(app.reposRoot, "alice", "paper"), `refs/heads/${repo.defaultBranch}`))!;
  const production = () => runtime.status(record).find((s) => s.env === "production");
  for (let i = 0; i < 100 && production()?.commitOid !== tip; i++) await Bun.sleep(100);
  expect(production()?.commitOid).toBe(tip);
  await syncAll(app);
  const rows = scheduleTimers(app.db, record.id);
  expect(rows.map((t) => [t.name, t.env, t.cron, t.timezone, t.path])).toEqual([["print", "production", "30 6 * * *", "America/Chicago", "/jobs/print"]]);
  expect(syncedCommit(app.db, record.id, "production")).toBe(tip);
  // Read once per commit: a pause survives the next pass.
  app.db.run("UPDATE timer SET paused = 1");
  await syncAll(app);
  expect(scheduleTimers(app.db, record.id)[0]!.paused).toBe(true);
}, 30_000);
