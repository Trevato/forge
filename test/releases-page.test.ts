/**
 * The Releases page (#1824): it lists each kept release, escaped, with the
 * live one marked and the pull linked; a writer of the forge's repository
 * gets a Roll back button on a kept, schema-compatible release and anyone
 * else gets none and a 403; a cross-origin POST is refused; the home links
 * the live release.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { releaseDir } from "../src/release/checkout.ts";
import { recordRelease } from "../src/release/record.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const LIVE = "a".repeat(40);
const KEPT = "b".repeat(40);
const PRUNED = "c".repeat(40);

describe("the releases page", () => {
  let root = "";
  let app: App;
  let servers: Servers;
  const was = process.env["FORGE_COMMIT"];

  const login = async (username: string, password: string) => {
    const r = await fetch(`${servers.url}/signin`, {
      method: "POST",
      headers: { origin: servers.url },
      body: new URLSearchParams({ username, password }),
      redirect: "manual",
    });
    return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  const post = (path: string, cookie: string, origin: string) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      headers: { cookie, origin },
      redirect: "manual",
    });

  beforeAll(async () => {
    process.env["FORGE_COMMIT"] = LIVE;
    root = mkdtempSync(join(tmpdir(), "forge-releases-"));
    app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
    for (const [username, password, adminIfFirst] of [
      ["alice", "a-good-passphrase", true],
      ["bob", "another-good-passphrase", false],
    ] as const) {
      const u = await createUser(app.db, {
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password,
        adminIfFirst,
      });
      if (!u.ok) throw new Error(u.error);
    }
    proveAll(app);
    const alice = app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username='alice'").get()!;
    const made = await createRepo(app, { id: alice.id, username: "alice" } as never, { name: "forge" });
    if (!made.ok) throw new Error(made.error);
    const repoId = app.db.query<{ id: string }, []>("SELECT id FROM repo WHERE name='forge'").get()!.id;
    for (const [s, pull, line] of [
      [LIVE, 7, "ok"],
      [KEPT, 6, "<script>alert(1)</script>"],
      [PRUNED, null, "ok"],
    ] as const)
      recordRelease(app.db, { sha: s, repoId, pullNumber: pull, ok: true, line });
    const dir = releaseDir(root, KEPT);
    mkdirSync(join(dir, "src", "core"), { recursive: true });
    writeFileSync(join(dir, "src", "core", "schema.ts"), "export const migrations = " + JSON.stringify(Array(10_000).fill("SELECT 1")) + ";\n");
    servers = await serve(app);
  });
  afterAll(() => {
    if (was === undefined) delete process.env["FORGE_COMMIT"];
    else process.env["FORGE_COMMIT"] = was;
    servers.stop();
    app.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("it lists the releases, marks the live one and links the pull", async () => {
    const cookie = await login("alice", "a-good-passphrase");
    const body = await (await fetch(`${servers.url}/releases`, { headers: { cookie } })).text();
    expect(body).toContain("aaaaaaa");
    expect(body).toContain("bbbbbbb");
    expect(body).toContain("live");
    expect(body).toContain('href="/alice/forge/pulls/7"');
    expect(body).toContain('href="/alice/forge/pulls/6"');
  });

  test("a writer gets a button on a kept release, not on the live or a pruned one", async () => {
    const cookie = await login("alice", "a-good-passphrase");
    const body = await (await fetch(`${servers.url}/releases`, { headers: { cookie } })).text();
    expect(body).toContain(`/releases/${KEPT}/rollback`);
    expect(body).not.toContain(`/releases/${LIVE}/rollback`);
    expect(body).not.toContain(`/releases/${PRUNED}/rollback`);
  });

  test("a non-reader gets a 404 and no live line; a reader who cannot write sees the list with no button", async () => {
    const cookie = await login("bob", "another-good-passphrase");
    const get = (path: string) => fetch(`${servers.url}${path}`, { headers: { cookie } });
    expect((await get("/releases")).status).toBe(404);
    const home = await (await get("/")).text();
    expect(home).not.toContain("live-release");
    expect(home).not.toContain("aaaaaaa");
    expect((await post(`/releases/${KEPT}/rollback`, cookie, servers.url)).status).toBe(403);

    app.db.query("UPDATE repo SET visibility = 'public' WHERE name = 'forge'").run();
    const body = await (await get("/releases")).text();
    expect(body).toContain("bbbbbbb");
    expect(body).not.toContain("/rollback");
    expect((await post(`/releases/${KEPT}/rollback`, cookie, servers.url)).status).toBe(403);
    expect((await post(`/releases/${KEPT}/rollback`, "", servers.url)).status).toBe(403);
    expect(await (await get("/")).text()).toContain("live-release");
    app.db.query("UPDATE repo SET visibility = 'private' WHERE name = 'forge'").run();
  });

  test("an agent that can write the repository gets no button and a 403", async () => {
    const u = await createUser(app.db, {
      trusted: true,
      username: "crew1",
      email: "crew1@forge.local",
      password: "crew-good-passphrase",
      adminIfFirst: false,
    });
    if (!u.ok) throw new Error(u.error);
    app.db.query("UPDATE user SET is_agent = 1, is_admin = 1 WHERE username = 'crew1'").run();
    const cookie = `forge_session=${createSession(app.db, u.value.id).token}`;
    const body = await (await fetch(`${servers.url}/releases`, { headers: { cookie } })).text();
    expect(body).toContain("bbbbbbb");
    expect(body).not.toContain("/rollback");
    expect((await post(`/releases/${KEPT}/rollback`, cookie, servers.url)).status).toBe(403);
  });

  test("a cross-origin POST is refused", async () => {
    const cookie = await login("alice", "a-good-passphrase");
    expect((await post(`/releases/${KEPT}/rollback`, cookie, "https://evil.example")).status).toBe(403);
  });

  test("a writer's POST with swapping off is told so and nothing swaps", async () => {
    const cookie = await login("alice", "a-good-passphrase");
    const res = await post(`/releases/${KEPT}/rollback`, cookie, servers.url);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/releases");
    const flash = (res.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");
    const shown = await (await fetch(`${servers.url}/releases`, { headers: { cookie: `${cookie}; ${flash}` } })).text();
    expect(shown).toContain("FORGE_SELF_SWAP is off");
  });

  test("the home links the live release", async () => {
    const cookie = await login("alice", "a-good-passphrase");
    const body = await (await fetch(`${servers.url}/`, { headers: { cookie } })).text();
    expect(body).toContain('href="/releases"');
    expect(body).toContain("live:");
    expect(body).toContain("aaaaaaa");
  });

  test("a signed-out visitor is sent to sign in", async () => {
    const res = await fetch(`${servers.url}/releases`, { redirect: "manual" });
    expect(res.status).toBe(303);
  });
});
