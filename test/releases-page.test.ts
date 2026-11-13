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
import { markVerified } from "../src/core/verify.ts";
import { createSession } from "../src/core/sessions.ts";
import { migrations } from "../src/core/schema.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { releaseDir } from "../src/release/checkout.ts";
import { beginSwap, endSwap } from "../src/release/swap.ts";
import { recordRelease } from "../src/release/record.ts";
import { NO_RELEASES_YET } from "../src/release/words.ts";
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
  // Accounts inserted directly: no password hash is made, and none of these tests signs in with one.
  const addUser = (username: string, isAdmin: boolean) => {
    const id = `u-${username}`;
    app.db
      .query("INSERT INTO user (id, username, email, password_hash, is_admin) VALUES (?1, ?2, ?3, 'x', ?4)")
      .run(id, username, `${username}@forge.local`, isAdmin ? 1 : 0);
    markVerified(app.db, id, new Date().toISOString());
    return id;
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
    addUser("alice", true);
    addUser("bob", false);
    const made = await createRepo(app, { id: "u-alice", username: "alice" } as never, { name: "forge" });
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
    // And the rollback route's first call (lazy imports, form parsing), which swaps nothing here.
    await post(`/releases/${KEPT}/rollback`, aliceCookie, servers.url);
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

  test("a proven stranger's journey is one line on the page; no timings, no line", async () => {
    const was = process.env["FORGE_VERSION"];
    process.env["FORGE_VERSION"] = "9.9.9";
    try {
      const get = async () => (await fetch(`${servers.url}/releases`, { headers: { cookie: aliceCookie } })).text();
      mkdirSync(join(root, "release"), { recursive: true });
      writeFileSync(join(root, "release", "proof.json"), JSON.stringify({ version: "9.9.9", at: new Date().toISOString(), ok: true }));
      expect(await get()).not.toContain("a stranger&#39;s forge");
      writeFileSync(join(root, "release", "proof.json"), JSON.stringify({ version: "9.9.9", at: new Date().toISOString(), ok: true, journey: { readyMs: 12_000, firstActivityMs: 41_000, screens: [] } }));
      const body = await get();
      expect(body).toMatch(/id="journey-proof">a stranger(&#39;|')s forge was ready in 12 s and the crew working in 41 s/);
    } finally {
      if (was === undefined) delete process.env["FORGE_VERSION"];
      else process.env["FORGE_VERSION"] = was;
      rmSync(join(root, "release", "proof.json"), { force: true });
    }
  });

  test("the release list is rows, not a table or a card; the version is the one link", async () => {
    const body = await (await fetch(`${servers.url}/releases`, { headers: { cookie: aliceCookie } })).text();
    expect(body).not.toContain("<table");
    const list = body.slice(body.indexOf('<ul class="list setting-list">'));
    expect(list).not.toContain('class="card');
    expect(list).toContain('<a href="/alice/forge/pulls/7" class="row"');
    expect(list.match(/<li[ >]/g)!.length).toBeGreaterThanOrEqual(3);
    // The action stays a plain form beside the row, not inside its link.
    expect(list).toMatch(new RegExp(`<form method="post" action="/releases/${KEPT}/rollback">`));
  });

  test("the meta line: healthy since on the live row only; a pull link only where there is a pull", async () => {
    const body = await (await fetch(`${servers.url}/releases`, { headers: { cookie: aliceCookie } })).text();
    const items = body.slice(body.indexOf('<ul class="list setting-list">')).split("<li").slice(1);
    const rowOf = (s: string) => items.find((i) => i.includes(s))!;
    expect(rowOf("aaaaaaa")).toContain("healthy since");
    expect(rowOf("bbbbbbb")).not.toContain("healthy since");
    expect(rowOf("ccccccc")).not.toContain("healthy since");
    expect(rowOf("aaaaaaa")).toContain("#7 · ");
    expect(rowOf("ccccccc")).not.toMatch(/#\d+ · /);
    expect(rowOf("ccccccc")).not.toContain("/pulls/");
  });

  test("with no releases the page says so in one muted line, no list and no card", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-releases-empty-"));
    const empty = createApp({ dataDir: dir, port: 0, forgeRepo: "alice/forge" });
    const s = await serve(empty);
    try {
      empty.db
        .query("INSERT INTO user (id, username, email, password_hash, is_admin) VALUES ('u-alice','alice','alice@forge.local','x',1)")
        .run();
      markVerified(empty.db, "u-alice", new Date().toISOString());
      const made = await createRepo(empty, { id: "u-alice", username: "alice" } as never, { name: "forge" });
      if (!made.ok) throw new Error(made.error);
      const cookie = `forge_session=${createSession(empty.db, "u-alice").token}`;
      const res = await fetch(`${s.url}/releases`, { headers: { cookie } });
      expect(res.status).toBe(200);
      const body = await res.text();
      const at = body.indexOf('<p class="mt muted">No releases yet. ');
      expect(at).toBeGreaterThan(-1);
      const line = body.slice(at, body.indexOf("</p>", at));
      expect(line.replaceAll("&#39;", "'")).toContain(NO_RELEASES_YET);
      // After the keeper panel, only the muted line: no list, no card.
      const rest = body.slice(at, body.indexOf("</main>"));
      expect(rest).not.toContain("<ul");
      expect(rest).not.toContain('class="card');
    } finally {
      s.stop();
      empty.close();
      rmSync(dir, { recursive: true, force: true });
    }
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

    try {
      app.db.query("UPDATE repo SET visibility = 'public' WHERE name = 'forge'").run();
      const refused = await get("/releases");
      expect(refused.status).toBe(403);
      const body = await refused.text();
      expect(body).not.toContain("bbbbbbb");
      expect(body).not.toContain("/rollback");
      expect((await post(`/releases/${KEPT}/rollback`, cookie, servers.url)).status).toBe(403);
      expect((await post(`/releases/${KEPT}/rollback`, "", servers.url)).status).toBe(403);
      expect(await (await get("/")).text()).not.toContain("live-release");
    } finally {
      app.db.query("UPDATE repo SET visibility = 'private' WHERE name = 'forge'").run();
    }
  });

  test("an agent that can write the repository gets no button and a 403", async () => {
    const id = addUser("crew1", true);
    app.db.query("UPDATE user SET is_agent = 1 WHERE id = ?").run(id);
    const cookie = `forge_session=${createSession(app.db, id).token}`;
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
    const cookie = aliceCookie;
    const res = await post(`/releases/${KEPT}/rollback`, cookie, servers.url);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/releases");
    const flash = (res.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");
    const shown = await (await fetch(`${servers.url}/releases`, { headers: { cookie: `${cookie}; ${flash}` } })).text();
    expect(shown).toContain("FORGE_SELF_SWAP is off");
    // No swap began: the one turn this process may take is still free.
    const turn = beginSwap();
    if (turn.ok) endSwap(false);
    else expect(turn.line).not.toContain("already under way");
  });

  test("the home links the live release", async () => {
    const cookie = await login("alice", "a-good-passphrase");
    const body = await (await fetch(`${servers.url}/`, { headers: { cookie } })).text();
    expect(body).toContain('href="/releases"');
    // The Live lane's strip figure, or the plain line anyone else gets: both name the live version.
    expect(body).toContain("aaaaaaa");
  });

  test("a signed-out visitor is sent to sign in", async () => {
    const res = await fetch(`${servers.url}/releases`, { redirect: "manual" });
    expect(res.status).toBe(303);
  });
});
