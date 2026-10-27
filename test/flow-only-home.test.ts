/** FLOW ONLY on the home (#6395): one button after the alarms, for the admin alone; the auto-off item reads once. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo, getRepoById, updateRepoSettings, type Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { FLOW_ONLY_CLEAR_MS, FLOW_ONLY_OFF_NOTE, stepFlowOnly } from "../src/flow/flow_only_auto.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir = "";
let app: App;
let servers: Servers;
let owner: User;
let guest: User;
let repo: Repo;
let was: string | undefined;
const fresh = (): Repo => getRepoById(app.db, repo.id)!;
const count = (s: string, needle: string): number => s.split(needle).length - 1;
const get = async (path: string, who?: User): Promise<string> =>
  (
    await fetch(`${servers.url}${path}`, {
      headers: who ? { cookie: `forge_session=${createSession(app.db, who.id).token}` } : {},
    })
  ).text();

beforeAll(async () => {
  was = process.env.FORGE_SENTINEL_REPO;
  process.env.FORGE_SENTINEL_REPO = "maker/svc";
  dataDir = await mkdtemp(join(tmpdir(), "forge-flow-home-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "maker",
    email: "maker@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error("user");
  owner = made.value;
  const g = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "visitor",
    email: "visitor@forge.local",
    password: "a-good-passphrase",
  });
  if (!g.ok) throw new Error("guest");
  guest = g.value;
  const r = await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: "svc", visibility: "public" });
  if (!r.ok) throw new Error("repo");
  repo = updateRepoSettings(app.db, r.value, {
    autonomy: "assisted",
    autonomyDirection: "keep the shop open",
    autonomySlots: 2,
    autonomyCeilingUsd: 15,
    autonomyBy: owner.id,
  });
  // A ready issue nobody has started: the idle-crew alarm stands.
  const issue = openIssue(app, owner, repo, { title: "Waiting" });
  if (!issue.ok) throw new Error(String(issue.error));
  app.db
    .query("UPDATE issue SET created_at = ?1 WHERE id = ?2")
    .run(new Date(Date.now() - 3_600_000).toISOString(), issue.value.id);
}, 30_000);

afterAll(async () => {
  if (was === undefined) delete process.env.FORGE_SENTINEL_REPO;
  else process.env.FORGE_SENTINEL_REPO = was;
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the admin's home carries one Flow only button after the alarms; others get no form", async () => {
  const page = await get("/?all=1", owner);
  expect(page).toContain("no crew run has started");
  expect(count(page, 'action="/maker/svc/settings/flow-only"')).toBe(1);
  expect(await get("/?all=1", guest)).not.toContain("settings/flow-only");
  expect(await get("/")).not.toContain("settings/flow-only");
});

test("no button once the switch is on", async () => {
  updateRepoSettings(app.db, fresh(), { flowOnly: true });
  expect(await get("/?all=1", owner)).not.toContain('action="/maker/svc/settings/flow-only"');
});

test("the auto-off item reads once on the admin's home", async () => {
  const t = Date.now();
  stepFlowOnly(app.db, app.bus, fresh(), false, t - FLOW_ONLY_CLEAR_MS - 1);
  expect(stepFlowOnly(app.db, app.bus, fresh(), false, t)).toBe(true);
  const page = await get("/?all=1", owner);
  expect(count(page, FLOW_ONLY_OFF_NOTE)).toBe(1);
});
