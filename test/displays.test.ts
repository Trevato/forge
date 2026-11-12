/** `PUT /api/v1/repos/:owner/:name/display/builds`: choosing a display's builds. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { setRole } from "../src/actions/roles.ts";
import { createToken } from "../src/core/tokens.ts";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { pinBuild } from "../src/git/builds.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";

describe("choosing a display's builds", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  const url = "/api/v1/repos/alice/karts/display/builds";

  const cookie = (u: User) => `forge_session=${createSession(app.db, u.id).token}`;
  const get = (path: string, u: User) => fetch(`${servers.url}${path}`, { headers: { cookie: cookie(u) } });
  const put = (body: string, u: User, origin?: string) =>
    fetch(`${servers.url}${url}`, {
      method: "PUT",
      headers: { cookie: cookie(u), "content-type": "application/json", ...(origin === undefined ? {} : { origin }) },
      body,
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-displays-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const name of ["alice", "bob"]) {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username: name, email: `${name}@forge.local`, password: "a-good-passphrase", adminIfFirst: true });
      if (!made.ok) throw new Error(made.error);
      if (name === "alice") alice = made.value;
      else bob = made.value;
    }
    proveAll(app);
    const made = await createRepo(app, alice, { name: "karts", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const repo = getRepo(app.db, "alice", "karts")!;
    const commit = async (path: string, content: string) => {
      const c = await commitToBranch(app, alice, repo, { message: path, files: [{ path, content }] });
      if (!c.ok) throw new Error(JSON.stringify(c.error));
      return c.value.commitOid;
    };
    const oid = await commit("a.txt", "a");
    for (const label of ["fiesta", "encore"]) {
      const pinned = await pinBuild(repoDir(app.reposRoot, "alice", "karts"), {
        label, oid, note: "", source: "commit", tagger: { name: "alice", email: "alice@forge.local" }, at: 1_800_000_000,
        demo: { name: label === "fiesta" ? "krazy-karts" : "encore-karts", version: "1.0", page: "/", showcase: true, launch: "shots" },
      });
      if (!pinned.ok) throw new Error(pinned.error);
    }
    await commit("display.json", JSON.stringify({ title: "Kart night", layout: "grid", sources: ["alice/karts"], builds: ["alice/karts:fiesta"] }));
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a writer's form is on the page, a reader's is not", async () => {
    expect(await (await get("/alice/karts/display", alice)).text()).toContain("data-choose=");
    expect(await (await get("/alice/karts/display", bob)).text()).not.toContain("data-choose=");
  });

  test("a malformed body is a 422, bad JSON a 400, and nothing changes", async () => {
    expect((await put('{"builds":"x"}', alice)).status).toBe(422);
    expect((await put('{"builds":["nonsense"]}', alice)).status).toBe(422);
    expect((await put('{"builds":["alice/karts:nope"]}', alice)).status).toBe(422);
    expect((await put('{"builds":["alice/karts:fiesta","alice/karts:fiesta"]}', alice)).status).toBe(422);
    expect((await put('{"builds":[],"title":"x"}', alice)).status).toBe(422);
    expect((await put("not json", alice)).status).toBe(400);
    const page = await (await get("/alice/karts/display", bob)).text();
    expect(page).toContain("krazy-karts");
    expect(page).not.toContain("encore-karts");
  });

  test("a cross-origin PUT and a reader's PUT are refused", async () => {
    const body = '{"builds":["alice/karts:encore"]}';
    expect((await put(body, alice, "https://evil.example")).status).toBe(403);
    expect((await put(body, bob)).status).toBe(403);
    expect((await fetch(`${servers.url}${url}`, { method: "PUT", body })).status).toBe(401);
    expect(await (await get("/alice/karts/display", bob)).text()).not.toContain("encore-karts");
  });

  test("a good PUT changes what the display page shows, after a reload", async () => {
    const res = await put('{"builds":["alice/karts:encore"]}', alice);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ builds: ["alice/karts:encore"] });
    const page = await (await get("/alice/karts/display", bob)).text();
    expect(page).toContain("encore-karts");
    expect(page).not.toContain("krazy-karts");
    // The form for the writer holds the choice.
    expect(await (await get("/alice/karts/display", alice)).text()).toMatch(/value="alice\/karts:encore"\s+checked/);
  });

  test("an agent that writes the repository is refused, a stale tip is a 409, a good tip saves", async () => {
    const bot = await createAgent(app, alice, { username: "botty" });
    if (!bot.ok) throw new Error(String(bot.error));
    const added = addToCrew(app, alice, getRepo(app.db, "alice", "karts")!, "botty");
    if (!added.ok) throw new Error(String(added.error));
    const token = createToken(app.db, bot.value.user.id, "t", "rw").token;
    const agent = await fetch(`${servers.url}${url}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: '{"builds":["alice/karts:fiesta"]}',
    });
    expect(agent.status).toBe(403);

    const stale = await put(`{"builds":["alice/karts:fiesta"],"tip":"${"0".repeat(40)}"}`, alice);
    expect(stale.status).toBe(409);
    expect((await put('{"builds":[],"tip":"nope"}', alice)).status).toBe(422);
    const tip = /name="tip" value="([0-9a-f]{40})"/.exec(await (await get("/alice/karts/display", alice)).text())?.[1];
    expect(tip).toBeDefined();
    expect((await put(`{"builds":["alice/karts:fiesta"],"tip":"${tip}"}`, alice)).status).toBe(200);
  });

  test("a build in a repository the caller cannot read is a 422", async () => {
    const vault = await createRepo(app, alice, { name: "vault", visibility: "private" });
    if (!vault.ok) throw new Error(String(vault.error));
    const v = getRepo(app.db, "alice", "vault")!;
    const c = await commitToBranch(app, alice, v, { message: "v", files: [{ path: "v.txt", content: "v" }] });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const pinned = await pinBuild(repoDir(app.reposRoot, "alice", "vault"), {
      label: "hush", oid: c.value.commitOid, note: "", source: "commit", tagger: { name: "alice", email: "alice@forge.local" }, at: 1_800_000_000,
    });
    if (!pinned.ok) throw new Error(pinned.error);
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "carol", email: "carol@forge.local", password: "a-good-passphrase" });
    if (!made.ok) throw new Error(made.error);
    proveAll(app);
    const member = setRole(app, alice, "carol", "member");
    if (!member.ok) throw new Error(member.error);
    const show = await createRepo(app, made.value, { name: "show", visibility: "public" });
    if (!show.ok) throw new Error(String(show.error));
    const d = await commitToBranch(app, made.value, getRepo(app.db, "carol", "show")!, { message: "d", files: [{ path: "display.json", content: JSON.stringify({ title: "Show", layout: "grid", sources: ["carol/show"] }) }] });
    if (!d.ok) throw new Error(JSON.stringify(d.error));
    const res = await fetch(`${servers.url}/api/v1/repos/carol/show/display/builds`, {
      method: "PUT",
      headers: { cookie: cookie(made.value), "content-type": "application/json" },
      body: '{"builds":["alice/vault:hush"]}',
    });
    expect(res.status).toBe(422);
    // The owner of the private repository may name it.
    const own = await fetch(`${servers.url}${url}`, {
      method: "PUT",
      headers: { cookie: cookie(alice), "content-type": "application/json" },
      body: '{"builds":["alice/vault:hush"]}',
    });
    expect(own.status).toBe(200);
  });

  test("the form works without script: a same-origin POST saves and redirects, a cross-origin one is refused", async () => {
    const post = (u: User, origin?: string) =>
      fetch(`${servers.url}/alice/karts/display`, {
        method: "POST",
        headers: { cookie: cookie(u), "content-type": "application/x-www-form-urlencoded", ...(origin === undefined ? {} : { origin }) },
        body: "build=alice%2Fkarts%3Aencore",
        redirect: "manual",
      });
    expect((await post(alice, "https://evil.example")).status).toBe(403);
    expect((await post(bob)).status).toBe(403);
    const res = await post(alice, servers.url);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/karts/display");
    const page = await (await get("/alice/karts/display", bob)).text();
    expect(page).toContain("encore-karts");
    expect(page).not.toContain("krazy-karts");
  });
});
