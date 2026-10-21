/**
 * The Releases page (#1824): it lists each kept release, escaped, with the
 * live one marked and the pull linked; a writer of the forge's repository
 * gets a Roll back button on a kept, schema-compatible release and anyone
 * else gets none and a 403; a cross-origin POST is refused; the home links
 * the live release.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { migrations } from "../src/core/schema.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { releaseDir } from "../src/release/checkout.ts";
import { recordRelease } from "../src/release/record.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();
// The page imports a kept release's schema module and users are hashed: both
// scale with the check machine's load, so the verdict gets room, not a race.
setDefaultTimeout(30_000);

const LIVE = "a".repeat(40);
const KEPT = "b".repeat(40);
const PRUNED = "c".repeat(40);

describe("the releases page", () => {
  let root = "";
  let app: App;
  let servers: Servers;
  let aliceCookie = "";
  const was = process.env["FORGE_COMMIT"];

  // A session minted directly: the sign-in form's password hash is slow on a loaded
  // check machine and is not what these tests are about.
  const login = async (username: string, _password: string) => {
    const u = app.db.query<{ id: string }, [string]>("SELECT id FROM user WHERE username = ?").get(username)!;
    return `forge_session=${createSession(app.db, u.id).token}`;
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
        origin: "seed",
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
    writeFileSync(join(dir, "src", "core", "schema.ts"), "export const migrations = " + JSON.stringify(Array(migrations.length + 1).fill("SELECT 1")) + ";\n");
    servers = await serve(app);
    // Password hashing is the slow step under a loaded check machine: do it once, here, with room.
    aliceCookie = await login("alice", "a-good-passphrase");
    // Warm the page (the first render imports the kept release's schema module) outside any test's clock.
    await (await fetch(`${servers.url}/releases`, { headers: { cookie: aliceCookie } })).text();
  }, 60_000);
  // The page reads the live commit from the process environment at render time; pin it per test so
  // nothing another suite in this process does to it can unmark the live release.
  beforeEach(() => {
    process.env["FORGE_COMMIT"] = LIVE;
  });
  afterAll(() => {
    if (was === undefined) delete process.env["FORGE_COMMIT"];
    else process.env["FORGE_COMMIT"] = was;
    servers.stop();
    app.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("it lists the releases, marks the live one and links the pull", async () => {
    const body = await (await fetch(`${servers.url}/releases`, { headers: { cookie: aliceCookie } })).text();
    expect(body).toContain("aaaaaaa");
    expect(body).toContain("bbbbbbb");
    expect(body).toContain("live");
    expect(body).toContain('href="/alice/forge/pulls/7"');
    expect(body).toContain('href="/alice/forge/pulls/6"');
  });

  test("a writer gets a button on a kept release, not on the live or a pruned one", async () => {
    const body = await (await fetch(`${servers.url}/releases`, { headers: { cookie: aliceCookie } })).text();
    expect(body).toContain(`/releases/${KEPT}/rollback`);
    expect(body).not.toContain(`/releases/${LIVE}/rollback`);
    expect(body).not.toContain(`/releases/${PRUNED}/rollback`);
  });

  test("a non-admin is refused with a 403 and gets no live line, even as a reader of the repository", async () => {
    const cookie = await login("bob", "another-good-passphrase");
    const get = (path: string) => fetch(`${servers.url}${path}`, { headers: { cookie } });
    expect((await get("/releases")).status).toBe(403);
    const home = await (await get("/")).text();
    expect(home).not.toContain("live-release");
    expect(home).not.toContain("aaaaaaa");
    expect((await post(`/releases/${KEPT}/rollback`, cookie, servers.url)).status).toBe(403);

    app.db.query("UPDATE repo SET visibility = 'public' WHERE name = 'forge'").run();
    const refused = await get("/releases");
    expect(refused.status).toBe(403);
    const body = await refused.text();
    expect(body).not.toContain("bbbbbbb");
    expect(body).not.toContain("/rollback");
    expect((await post(`/releases/${KEPT}/rollback`, cookie, servers.url)).status).toBe(403);
    expect((await post(`/releases/${KEPT}/rollback`, "", servers.url)).status).toBe(403);
    expect(await (await get("/")).text()).not.toContain("live-release");
    app.db.query("UPDATE repo SET visibility = 'private' WHERE name = 'forge'").run();
  });

  test("an agent that can write the repository gets no button and a 403", async () => {
    const u = await createUser(app.db, {
      origin: "seed",
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
