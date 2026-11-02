import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { listAppEnvNames } from "../src/core/app_env.ts";
import { createOrigin } from "../src/core/origins.ts";
import { getRepo } from "../src/core/repos.ts";
import { getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { settled } from "../src/origins/jobs.ts";
import { needsOf, originOnHost, parseBringLink } from "../src/origins/bring.ts";
import { syncsSettled } from "../src/origins/sync.ts";
import { SYSTEM_NAMES } from "../src/core/reserved.ts";
import { newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";
import { proveAll } from "./helpers/verified.ts";
import { seedAdmin } from "./helpers/admin.ts";

setDefaultTimeout(60_000);

describe("the link and the needs", () => {
  test("a link names its host and repository, however deep or dressed", () => {
    for (const text of [
      "https://codeberg.org/ana/notes",
      " https://Codeberg.org/ana/notes.git ",
      "https://codeberg.org/ana/notes/pulls/3?x=1#y",
      "codeberg.org/ana/notes",
    ])
      expect(parseBringLink(text)).toEqual({
        ok: true,
        value: { host: "codeberg.org", fullName: "ana/notes" },
      });
  });

  test("anything else is refused with a reason", () => {
    expect(parseBringLink("")).toEqual({ ok: false, error: "empty" });
    expect(parseBringLink("javascript:alert(1)")).toEqual({ ok: false, error: "not_a_link" });
    expect(parseBringLink("ftp://x.org/a/b")).toEqual({ ok: false, error: "not_a_link" });
    expect(parseBringLink("https://u:p@x.org/a/b")).toEqual({ ok: false, error: "not_a_link" });
    expect(parseBringLink("https://x.org/ana")).toEqual({ ok: false, error: "not_a_repository" });
    expect(parseBringLink("https://x.org/a/..")).toEqual({ ok: false, error: "not_a_repository" });
    expect(parseBringLink("https://x.org/a/b".padEnd(400, "c"))).toEqual({ ok: false, error: "not_a_link" });
  });

  test("an origin is picked by host, and a spent one is not", () => {
    const o = (webUrl: string, needsReauth: boolean) => ({ webUrl, needsReauth }) as never;
    expect(originOnHost([o("https://a.org", false), o("https://b.org", false)], "b.org")).toBeDefined();
    expect(originOnHost([o("https://b.org", true)], "b.org")).toBeUndefined();
    expect(originOnHost([], "b.org")).toBeUndefined();
  });

  test("needs are names only, from NAME= lines", () => {
    expect(
      needsOf("# keys\nAPI_KEY=abc123\nexport DB_URL = x\nlower=1\nAPI_KEY=again\n\nPORT=3000\n"),
    ).toEqual(["API_KEY", "DB_URL", "PORT"]);
  });

  test("bring is a page, so no account may take the name", () => {
    expect(SYSTEM_NAMES).toContain("bring");
  });
});

const LOGIN = "octo";
const TOKEN = "octo-secret-7089";
const PASSWORD = "alice-secret-7089";
const basic = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

describe("bringing an app whole", () => {
  let dirs: string[] = [];
  let app: App;
  let gitApp: App;
  let servers: Servers;
  let gitServers: Servers;
  let fake: FakeForge;
  const alice = () => getUserByName(app.db, "alice")!;
  const post = (path: string, body: Record<string, string>) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { authorization: basic("alice", PASSWORD), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });

  beforeAll(async () => {
    dirs = [await mkdtemp(join(tmpdir(), "forge-bring-")), await mkdtemp(join(tmpdir(), "forge-bring-git-"))];
    gitApp = createApp({ dataDir: dirs[1]!, port: 0 });
    gitServers = await serve(gitApp);
    await seedAdmin(gitApp, { username: LOGIN, email: "octo@upstream.test", password: TOKEN });
    proveAll(gitApp);
    const auth = { "content-type": "application/json", authorization: basic(LOGIN, TOKEN) };
    await fetch(`${gitServers.url}/api/v1/repos`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "widgets", visibility: "public" }),
    });
    const made = await fetch(`${gitServers.url}/api/v1/repos/octo/widgets/contents`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        branch: "main",
        message: "an app",
        files: [
          { path: "forge.json", content: '{"app":{"run":"bun run index.ts"}}\n' },
          { path: ".env.example", content: "API_KEY=changeme\nGREETING=hello\n" },
          { path: ".env", content: "API_KEY=real-secret\n" },
        ],
      }),
    });
    expect(made.status).toBeLessThan(300);
    const state = newFakeState("forgejo", LOGIN, TOKEN);
    state.repos.push({
      id: 41,
      fullName: "octo/widgets",
      defaultBranch: "main",
      cloneUrl: `${gitServers.url}/octo/widgets.git`,
    });
    fake = serveFakeForge(state);
    state.repos[0]!.htmlUrl = `${fake.url}/octo/widgets`;
    app = createApp({ dataDir: dirs[0]!, port: 0 });
    servers = await serve(app);
    await seedAdmin(app, { username: "alice", email: "alice@forge.test", password: PASSWORD });
    proveAll(app);
  }, 120_000);

  afterAll(async () => {
    await syncsSettled();
    fake.stop();
    servers.stop();
    gitServers.stop();
    app.close();
    gitApp.close();
    for (const d of dirs) await rm(d, { recursive: true, force: true, maxRetries: 5 });
  }, 120_000);

  test("the new app page links to it", async () => {
    const res = await fetch(`${servers.url}/apps/new`, { headers: { authorization: basic("alice", PASSWORD) } });
    expect(await res.text()).toContain('href="/bring"');
  });

  test("the page asks for a link", async () => {
    const res = await fetch(`${servers.url}/bring`, { headers: { authorization: basic("alice", PASSWORD) } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('name="link"');
  });

  test("a bad link and an unconnected forge are refused in words, starting nothing", async () => {
    const bad = await post("/bring", { link: "nonsense" });
    expect(bad.status).toBe(400);
    const none = await post("/bring", { link: `${fake.url}/octo/widgets` });
    expect(none.status).toBe(400);
    expect(await none.text()).toContain("/settings/origins");
    expect(getRepo(app.db, "alice", "widgets")).toBeUndefined();
  });

  test("a link comes across, private, linked back, asking only by name", async () => {
    const made = createOrigin(app.db, app.config.dataDir, {
      userId: alice().id,
      kind: "forgejo",
      apiUrl: fake.apiUrl,
      webUrl: fake.url,
      login: LOGIN,
      token: TOKEN,
    });
    if (!made.ok) throw new Error(made.error);

    const started = await post("/bring", { link: `${fake.url}/octo/widgets.git` });
    expect(started.status).toBe(303);
    const where = started.headers.get("location")!;
    const jobId = where.split("/").pop()!;
    expect(where).toBe(`/bring/${made.value.id}/${jobId}`);
    expect((await settled(jobId))?.stage).toBe("done");

    // A GET only looks: the copy is here, nothing is registered or running.
    const get = () => fetch(`${servers.url}${where}`, { headers: { authorization: basic("alice", PASSWORD) } });
    const before = await get();
    expect(before.status).toBe(200);
    expect(await before.text()).toContain(`${where}/run`);
    expect(getAppByRepo(app.db, getRepo(app.db, "alice", "widgets")!.id)).toBeUndefined();

    const ran = await post(`${where}/run`, {});
    expect(ran.status).toBe(303);
    expect(ran.headers.get("location")).toBe(where);
    const landed = await get();
    expect(landed.status).toBe(200);
    const text = await landed.text();
    expect(text).toContain("/alice/widgets/app");
    expect(text).toContain("API_KEY");
    expect(text).toContain("GREETING");
    expect(text).not.toContain("real-secret");

    const repo = getRepo(app.db, "alice", "widgets")!;
    expect(getAppByRepo(app.db, repo.id)?.access).toBe("private");
    const link = app.db
      .query<{ origin_full_name: string }, [string]>("SELECT origin_full_name FROM repo WHERE id = ?1")
      .get(repo.id);
    expect(link?.origin_full_name).toBe("octo/widgets");
    // Nothing came by default: not the example's values, not the author's .env.
    expect(listAppEnvNames(app.db, getAppByRepo(app.db, repo.id)!.id)).toEqual([]);

    // One form sets what was filled, only for names the app asked for.
    const saved = await post(`${where}/env`, { v_API_KEY: "mine", v_GREETING: "", v_EVIL: "x" });
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe("/alice/widgets/app");
    expect(listAppEnvNames(app.db, getAppByRepo(app.db, repo.id)!.id).map((e) => e.name)).toEqual(["API_KEY"]);
  });
});
