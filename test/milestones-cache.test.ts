/** The milestones page keeps its plan until the repository changes (#3429). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIssue, setIssueState } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getRepo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { savePlaces } from "../src/core/limb_order.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { clearMapCache, planBuildCount } from "../src/web/map_cache.ts";
import { seedMilestones } from "./fixtures/milestones-seed.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let user: { id: string; username: string };

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-milestones-cache-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  proveAll(app);
  user = { id: u.value.id, username: "alice" };
  const made = await createRepo(app, user as never, { name: "forge" });
  if (!made.ok) throw new Error(made.error);
  seedMilestones(app.db, made.value.id, u.value.id, new Date());
  servers = await serve(app);
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

let cookie = "";
const get = async (): Promise<number> => {
  if (cookie === "") {
    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      headers: { origin: servers.url },
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
      redirect: "manual",
    });
    cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
  }
  const res = await fetch(`${servers.url}/alice/forge/milestones`, { headers: { cookie } });
  await res.text();
  return res.status;
};

test("a repeat visit does not read the plan again; a new or closed issue does", async () => {
  clearMapCache();
  const before = planBuildCount();
  expect(await get()).toBe(200);
  expect(planBuildCount()).toBe(before + 1);
  expect(await get()).toBe(200);
  expect(planBuildCount()).toBe(before + 1);

  const repo = getRepo(app.db, "alice", "forge")!;
  const owner = getUserByName(app.db, "alice")!;
  const opened = openIssue(app, owner, repo, { title: "Another" });
  expect(opened.ok).toBe(true);
  expect(await get()).toBe(200);
  expect(planBuildCount()).toBe(before + 2);
  expect(await get()).toBe(200);
  expect(planBuildCount()).toBe(before + 2);

  if (!opened.ok) return;
  expect(setIssueState(app, owner, repo, opened.value, "closed").ok).toBe(true);
  expect(await get()).toBe(200);
  expect(planBuildCount()).toBe(before + 3);
});

test("a run starting, its cost changing and a limb moving each rebuild the plan", async () => {
  clearMapCache();
  const repo = getRepo(app.db, "alice", "forge")!;
  const issue = app.db
    .query<{ id: string }, [string]>("SELECT id FROM issue WHERE repo_id = ?1 AND kind = 'issue' LIMIT 1")
    .get(repo.id)!;
  await get();
  const warm = planBuildCount();
  await get();
  expect(planBuildCount()).toBe(warm);

  // A run writes no event.
  const run = createRun(app.db, { repoId: repo.id, kind: "agent", issueId: issue.id });
  await get();
  expect(planBuildCount()).toBe(warm + 1);
  await get();
  expect(planBuildCount()).toBe(warm + 1);

  app.db.query("UPDATE run SET cost_usd = 1.5 WHERE id = ?1").run(run.id);
  await get();
  expect(planBuildCount()).toBe(warm + 2);

  savePlaces(app.db, repo.id, "top", [issue.id]);
  await get();
  expect(planBuildCount()).toBe(warm + 3);
});
