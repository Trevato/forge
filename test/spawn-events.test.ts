/**
 * The events spawn emits (#2932), driven through `spawnForge` and the door
 * with a fake placement: removing an append in either fails a test here.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { spawnForge, type SpawnDeps } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { commitFiles } from "../src/git/write.ts";
import { ok } from "../src/kernel/result.ts";
import { spawnDoor, usePlacement, useProbe } from "../src/spawn/door.ts";
import type { Placement } from "../src/spawn/placement.ts";
import type { SpawnSource } from "../src/spawn/plan.ts";
import type { Ctx } from "../src/http/context.ts";

let dir: string;
let app: App;
let alice: User;
let source: SpawnSource;
let retired: string[];
let bodyId: string;
const input = { name: "kid", org: "kids", apps: ["alice/notes"], carryBriefs: false, carrySubscriptions: false };

const placement = (): Placement => ({
  place: async (plan) => ok({ url: `https://${plan.name}.fake.test`, bodyId }),
  retire: async (id) => { retired.push(id); return ok(); },
});
const deps = (extra: Partial<SpawnDeps> = {}): SpawnDeps => ({
  placement: placement(),
  request: new Request("https://forge.test/spawn", { method: "POST", headers: { origin: "https://forge.test" } }),
  url: new URL("https://forge.test/spawn"),
  ...extra,
});
const events = () =>
  app.db.query("SELECT kind, payload FROM event WHERE kind LIKE 'forge.spawn.%' ORDER BY seq").all()
    .map((r) => ({ kind: (r as any).kind as string, payload: JSON.parse((r as any).payload) }));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-spawn-events-"));
  app = createApp({ dataDir: dir, url: "https://forge.test" });
  retired = [];
  bodyId = "body-1";
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.invalid", isAdmin: true });
  if (!made.ok) throw new Error("user");
  alice = made.value;
  const repo = await createRepo(app, alice, { name: "notes" });
  if (!repo.ok) throw new Error("repo");
  const c = await commitFiles(repoDir(app.reposRoot, "alice", "notes"), {
    branch: "main", message: "one", files: [{ path: "a.txt", content: "a" }], author: { name: "a", email: "a@x.invalid" },
  });
  if (!c.ok) throw new Error("commit");
  source = { catalog: [{ ref: "alice/notes", readable: true, bytes: 10, forgeJsonBytes: 0 }], briefs: [], subscriptions: [] };
});
afterEach(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("a good spawn appends exactly one started, and a retry of it none", async () => {
  expect((await spawnForge(app, alice, input, source, deps())).ok).toBe(true);
  expect(events()).toEqual([{ kind: "forge.spawn.started", payload: {} }]);
  const again = await spawnForge(app, alice, input, source, deps());
  expect(again.ok && again.value.existed).toBe(true);
  expect(events().length).toBe(1);
});

test("a retry after a failed copy starts again, so each failed has a started", async () => {
  const gone = repoDir(app.reposRoot, "alice", "notes");
  await Bun.$`mv ${gone} ${gone}.away`.quiet();
  await spawnForge(app, alice, input, source, deps());
  await spawnForge(app, alice, input, source, deps());
  expect(events().map((e) => e.kind)).toEqual([
    "forge.spawn.started", "forge.spawn.failed", "forge.spawn.started", "forge.spawn.failed",
  ]);
  await Bun.$`mv ${gone}.away ${gone}`.quiet();
  expect((await spawnForge(app, alice, input, source, deps())).ok).toBe(true);
  expect(events().map((e) => e.kind).slice(4)).toEqual(["forge.spawn.started"]);
});

test("an unsafe body id fails at place and retires the body", async () => {
  bodyId = "../escape";
  const r = await spawnForge(app, alice, input, source, deps());
  expect(r.ok).toBe(false);
  expect(retired).toEqual(["../escape"]);
  expect(events()).toEqual([{ kind: "forge.spawn.failed", payload: { step: "place" } }]);
});

test("a copy that breaks fails at copy, after started, with no words of the failure", async () => {
  await rm(repoDir(app.reposRoot, "alice", "notes"), { recursive: true, force: true });
  const r = await spawnForge(app, alice, input, source, deps());
  expect(r.ok).toBe(false);
  expect(events()).toEqual([
    { kind: "forge.spawn.started", payload: {} },
    { kind: "forge.spawn.failed", payload: { step: "copy" } },
  ]);
});

test("deps.drill marks started and failed as the drill", async () => {
  bodyId = "../escape";
  await spawnForge(app, alice, input, source, deps({ drill: true }));
  expect(events()).toEqual([{ kind: "forge.spawn.failed", payload: { step: "place", drill: 1 } }]);
  bodyId = "body-2";
  await spawnForge(app, alice, { ...input, name: "kid2", org: "kids2" }, source, deps({ drill: true }));
  expect(events()[1]).toEqual({ kind: "forge.spawn.started", payload: { drill: 1 } });
});

test("the door starts a watcher for a new child and not for an existing one", async () => {
  usePlacement(app, placement());
  const probed: string[] = [];
  useProbe(app, (url) => async () => { probed.push(url); return true; });
  const ctx = { app, request: deps().request, url: deps().url } as unknown as Ctx;
  const raw = { name: "kid", org: "kids", apps: ["alice/notes"], dryRun: false };
  const live = () => events().filter((e) => e.kind === "forge.spawn.live").length;
  const until = async (n: number) => { for (let i = 0; i < 100 && live() < n; i++) await Bun.sleep(20); };

  expect((await spawnDoor(ctx, alice, raw)).status).toBe(201);
  await until(1);
  expect(live()).toBe(1);
  expect(probed.length).toBe(1);

  expect((await spawnDoor(ctx, alice, raw)).status).toBe(200);
  await Bun.sleep(100);
  expect(probed.length).toBe(1);
  expect(live()).toBe(1);
});
