/** The shelf of 40 apps is drawn in a fixed number of reads and says what it said before (#6123). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { enableApp } from "../src/actions/apps.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { createRun, claimRun, finishRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Repo } from "../src/core/repos.ts";
import type { Ctx } from "../src/http/context.ts";
import { takePhases } from "../src/core/route_timing.ts";
import { shelfRows } from "../src/web/studio/shelf.ts";
import { expectWork } from "./helpers/work.ts";
import { statements } from "./helpers/statements.ts";
import { appsForRepos } from "../src/core/apps.ts";
import { primaryHosts } from "../src/core/domains.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();

const GOLDEN = join(import.meta.dir, "fixtures", "shelf-speed.html");
let root = "";
let app: App;
let alice: User;
let repos: Repo[] = [];

const ctx = (): Ctx => ({
  app,
  request: new Request("http://forge.test/apps"),
  url: new URL("http://forge.test/apps"),
  params: {},
  auth: { user: alice, scope: undefined, via: "session" },
  theme: undefined,
});

/** The relative times and ids a run leaves are the clock's, not the shelf's. */
const steady = (s: string): string =>
  s.replace(/datetime="[^"]*"/g, 'datetime="T"').replace(/>[^<>]*\bago\b[^<>]*</g, ">T<").replace(/>(now|just now|\d+[smhd])</g, ">T<");

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-shelf-speed-"));
  app = createApp({ dataDir: root, port: 0 });
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  alice = u.value;
  proveAll(app);
  const runtime = new AppsRuntime(app, { domain: "apps.test", scheme: "http", publicPort: 80, forgeUrl: "http://forge.test", concurrency: 1 });
  for (let i = 0; i < 40; i++) {
    const made = await createRepo(app, alice, { name: `app-${String(i).padStart(2, "0")}`, visibility: i % 4 === 0 ? "private" : "public", description: `app number ${i}` });
    if (!made.ok) throw new Error(String(made.error));
    const enabled = enableApp(app, alice, made.value, { slug: `app-${i}` });
    if (!enabled.ok) throw new Error(String(enabled.error));
    repos.push(made.value);
    // Every other app has served: an environment asleep on a deploy run.
    if (i % 2 === 0) {
      const run = createRun(app.db, { repoId: made.value.id, kind: "deploy", env: "production", commitOid: "a".repeat(40), reason: "push" });
      claimRun(app.db, run.id);
      finishRun(app.db, run.id, { state: i % 6 === 0 ? "failed" : "ok", summary: "deployed" });
      // biome-ignore lint: reaching the runtime's own table is how a test seeds an environment
      const state = (runtime as any).envFor(enabled.value, "production");
      state.asleep = { commitOid: "a".repeat(40), dir: root, manifest: {}, runId: run.id, since: new Date().toISOString() };
    }
  }
});
afterAll(() => {
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("40 apps are drawn in few statements, in the phases Server-Timing names", async () => {
  await shelfRows(ctx(), repos); // warm
  const c = ctx();
  await shelfRows(c, repos);
  const phases = takePhases(c.request).map((p) => p.name);
  expect(phases).toEqual(["shelf-records", "shelf-runs", "shelf-production", "shelf-pulls", "shelf-rows"]);
  // Counted, not timed: the shelf reads in batches, so 40 apps cost no more statements than a handful.
  expectWork(await statements(app.db, async () => void (await shelfRows(ctx(), repos))), { max: 10 });
});

test("its rows are byte-identical to the ones drawn before the batch", async () => {
  const rows = (await shelfRows(ctx(), repos)).map((r) => steady(String(r))).join("\n---\n");
  if (process.env.WRITE_GOLDEN === "1") writeFileSync(GOLDEN, rows);
  expect(rows).toBe(readFileSync(GOLDEN, "utf8"));
});

test("primaryHosts names only verified hosts, the earliest verified first", () => {
  const [a, b, c] = repos.slice(1, 4).map((r) => appsForRepos(app.db, [r.id]).get(r.id)!.id);
  const add = (host: string, appId: string, at: string | null) =>
    app.db.query("INSERT INTO app_domain (host, app_id, env, token, created_at, verified_at) VALUES (?1, ?2, 'production', ?1, '2026-01-01T00:00:00Z', ?3)").run(host, appId, at);
  add("late.test", a!, "2026-03-01T00:00:00Z");
  add("early.test", a!, "2026-02-01T00:00:00Z");
  add("unproven.test", b!, null);
  expect(primaryHosts(app.db, [a!, b!, c!])).toEqual(new Map([[a!, "early.test"]]));
  expect(primaryHosts(app.db, [])).toEqual(new Map());
});

test("a viewer who may not enter a private app sees a sealed row for it", async () => {
  const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
  if (!b.ok) throw new Error(b.error);
  const c = { ...ctx(), auth: { user: b.value, scope: undefined, via: "session" as const } };
  const rows = (await shelfRows(c, repos.slice(0, 2))).map(String);
  expect(rows[0]).toContain("private app");
  expect(rows[0]).not.toContain(">live<");
  expect(rows[0]).not.toContain("not running");
  expect(rows[1]).not.toContain("private app");
});
