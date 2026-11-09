/** The app page's Pull now button (#10125): a writer's same-origin POST runs `pullNow`; anyone else gets 404; cross-origin is refused. */
import { afterAll, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { PULL_NOW_REFUSALS } from "../src/actions/app_pull.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { repoDir } from "../src/git/repos.ts";
import { commitFiles } from "../src/git/write.ts";
import { getRepo } from "../src/core/repos.ts";
import { listPullRuns } from "../src/core/runs.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { promote } from "./helpers/members.ts";
import { tokenFor } from "./helpers/tokens.ts";

let dataDir: string, app: App, servers: Servers, runtime: AppsRuntime, adapterApp: ReturnType<typeof Bun.serve>;
let appId: string, aliceRw: string, bobRw: string, awake = true;

const send = (token: string, origin: string | undefined) =>
  fetch(`${servers.url}/alice/hello/app/pull`, {
    method: "POST",
    redirect: "manual",
    headers: { authorization: `Bearer ${token}`, ...(origin ? { origin } : {}) },
  });
const page = (token: string, qs = "") =>
  fetch(`${servers.url}/alice/hello${qs}`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.text());

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-adapter-pull-button-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  await seedAdmin(app, { username: "alice", email: "alice@forge.local", password: "a-good-passphrase" });
  const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
  if (!b.ok) throw new Error(b.error);
  promote(app.db, b.value);
  const made = await newApp(app, getUserByName(app.db, "alice")!, { name: "hello", visibility: "public" } as never);
  if (!made.ok) throw new Error(String(made.error));
  const repo = getRepo(app.db, "alice", "hello")!;
  appId = (app.db.query("SELECT id FROM app WHERE repo_id = ?1").get(repo.id) as { id: string }).id;
  aliceRw = tokenFor(app, "alice", "rw");
  bobRw = tokenFor(app, "bob", "rw");
  adapterApp = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ pulled: 2, skipped: 1, cursor: "r1", errors: 0 }) });
  runtime = new AppsRuntime(app, { domain: "pull.test", scheme: "http", publicPort: servers.port, forgeUrl: servers.url });
  spyOn(AppsRuntime.prototype, "envStatus").mockImplementation(
    (): EnvStatus =>
      (awake
        ? { env: "production", state: "running", commitOid: "0".repeat(40), url: "", port: adapterApp.port }
        : { env: "production", state: "stopped", commitOid: "0".repeat(40), url: "" }) as EnvStatus,
  );
  const c = await commitFiles(repoDir(app.reposRoot, "alice", "hello"), {
    branch: repo.defaultBranch,
    message: "forge.json",
    files: [{ path: "forge.json", content: JSON.stringify({ run: "bun run src/server.ts", adapter: { schedule: { every: 3600 } } }) }],
    author: { name: "T", email: "t@forge.test" },
  });
  if (!c.ok) throw new Error(JSON.stringify(c.error));
}, 30_000);

afterAll(async () => {
  mock.restore();
  await runtime.stop();
  adapterApp.stop(true);
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("only a writer is offered the button", async () => {
  expect(await page(aliceRw)).toContain('action="/alice/hello/app/pull"');
  expect(await page(bobRw)).not.toContain("/app/pull");
});

test("a writer's same-origin POST records a run and returns to the app page", async () => {
  const res = await send(aliceRw, servers.url);
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toContain("/alice/hello");
  const runs = listPullRuns(app.db, appId);
  expect(runs.length).toBe(1);
  expect(runs[0]).toMatchObject({ state: "ok", written: 2, cursor: "r1" });
});

test("a reader gets 404 and nothing is recorded", async () => {
  expect((await send(bobRw, servers.url)).status).toBe(404);
  expect(listPullRuns(app.db, appId).length).toBe(1);
});

test("a cross-origin POST is refused", async () => {
  const res = await send(aliceRw, "http://evil.example");
  expect(res.status).toBe(403);
  expect(listPullRuns(app.db, appId).length).toBe(1);
});

test("a refusal shows its sentence in one muted line, and an unknown code shows nothing", async () => {
  awake = false;
  const res = await send(aliceRw, servers.url);
  expect(res.headers.get("location")).toContain("pull=asleep");
  const shown = await page(aliceRw, "?pull=asleep");
  expect(shown).toContain(`<p class="muted small">${PULL_NOW_REFUSALS.asleep.replace("'", "&#39;")}</p>`);
  const section = async (qs: string) => {
    const text = await page(aliceRw, qs);
    return text.slice(text.indexOf("<h2>Adapter"), text.indexOf("</section>", text.indexOf("<h2>Adapter")));
  };
  expect(await section("?pull=%3Cb%3E")).not.toContain("muted small");
  expect(await section("?pull=constructor")).not.toContain("muted small");
  awake = true;
});
