/**
 * A sender takes a child's link back (#10725): a revoked link answers a plain
 * 410 and sets no session, a used link cannot be revoked, a cross-origin
 * revoke is refused, and a revoke can be undone for a minute.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childDirOf } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { CLAIM_TTL_MS, linkOf, REVOKE_UNDO_MS, restoreClaim, revokeClaim, spawnedOrg, undoable } from "../src/spawn/claim.ts";
import { changeLink } from "../src/spawn/manage.ts";
import { useChildFetch } from "../src/spawn/clients.ts";
import { firstBoot } from "../src/spawn/first-boot.ts";
import { quietLogs } from "./helpers/globals.ts";
import { passkeyFields } from "./helpers/passkey.ts";

quietLogs();

describe("revoking a forge link", () => {
  let dir = "";
  let parent: App;
  let parentServers: Servers;
  let alice: User;
  const kids: Record<string, { app: App; servers: Servers; token: string; dir: string }> = {};

  let rwToken = "";
  let aliceCookie = "";
  let bobCookie = "";
  const state = (name: string) => linkOf(kids[name]!.app.db)?.state;
  const orgOf = async (name: string) => (await spawnedOrg(kids[name]!.app))!.org.id;
  /** The page's button, as a browser posts it. */
  const post = (name: string, act: "revoke" | "undo", cookie = aliceCookie, origin = "https://forge.test") =>
    fetch(`${parentServers.url}/forges/${name}/${act}-link`, {
      method: "POST",
      headers: { ...(cookie ? { cookie } : {}), origin },
      redirect: "manual",
    });
  const revoke = async (name: string, act: "revoke" | "undo", origin = "https://forge.test") => ({
    ok: (await post(name, act, aliceCookie, origin)).headers.get("location")?.includes(act === "revoke" ? "link=revoked" : "link=restored") === true,
  });
  const claim = (name: string) =>
    fetch(`${kids[name]!.servers.url}/claim/options`, {
      method: "POST",
      headers: { origin: kids[name]!.servers.url, "content-type": "application/json" },
      body: JSON.stringify({ token: kids[name]!.token, username: `${name}-owner`, email: `${name}@x.test` }),
    });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-claim-revoke-"));
    parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const made = await createUser(parent.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.test", password: "a-long-claim-passphrase", isAdmin: true });
    if (!made.ok) throw new Error("user");
    alice = made.value;
    aliceCookie = `forge_session=${createSession(parent.db, alice.id).token}`;
    const bob = await createUser(parent.db, { origin: "seed", trusted: true, username: "bob", email: "b@x.test", password: "a-long-claim-passphrase" });
    if (!bob.ok) throw new Error("bob");
    bobCookie = `forge_session=${createSession(parent.db, bob.value.id).token}`;
    const rw = createToken(parent.db, alice.id, "rw", "rw").token;
    rwToken = rw;
    parentServers = await serve(parent);
    for (const name of ["one", "two"]) {
      const res = await fetch(`${parentServers.url}/api/v1/forges`, {
        method: "POST",
        headers: { authorization: `Bearer ${rw}`, "content-type": "application/json" },
        body: JSON.stringify({ name, apps: [], dryRun: false }),
      });
      if (res.status !== 201) throw new Error(`spawn ${res.status} ${await res.text()}`);
      const body = (await res.json()) as { claimUrl: string; bodyId: string };
      const path = childDirOf(parent, body.bodyId);
      const app = createApp({ dataDir: path, port: 0 });
      await firstBoot(app);
      kids[name] = { app, servers: await serve(app), token: body.claimUrl.split("#")[1] ?? "", dir: path };
    }
    // The parent reaches each child at its own loopback port.
    useChildFetch(parent, (input, init) => {
      const at = new URL(String(input));
      const kid = kids[at.hostname.split(/--|\./)[0] ?? ""];
      return kid ? fetch(`${kid.servers.url}${at.pathname}`, init) : Promise.reject(new Error("no such child"));
    });
  }, 60_000);

  afterAll(async () => {
    for (const k of Object.values(kids)) {
      k.servers.stop();
      k.app.close();
    }
    parentServers.stop();
    parent.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("revoke-then-use answers 410 in plain words and sets no session", async () => {
    expect(state("one")).toBe("open");
    const done = await revoke("one", "revoke");
    expect(done.ok).toBe(true);
    expect(state("one")).toBe("ended");
    const res = await claim("one");
    expect(res.status).toBe(410);
    expect(res.headers.get("set-cookie")).toBeNull();
    const form = { token: kids["one"]!.token, username: "x", email: "x@x.test" };
    const post = await fetch(`${kids["one"]!.servers.url}/claim`, {
      method: "POST",
      headers: { origin: kids["one"]!.servers.url },
      body: new URLSearchParams({ ...form, ...(await passkeyFields(kids["one"]!.servers.url, "/claim/options", form).catch(() => ({}))) }),
      redirect: "manual",
    });
    expect(post.status).toBe(410);
    expect(post.headers.get("set-cookie")).toBeNull();
    expect(await post.text()).toContain("This link has ended");
  });

  test("a revoke is receipted, and undone within the minute", async () => {
    const back = await revoke("one", "undo");
    expect(back.ok).toBe(true);
    expect(state("one")).toBe("open");
    const kinds = parent.db.query("SELECT kind, payload FROM event WHERE kind LIKE 'forge.claim_re%'").all() as { kind: string; payload: string }[];
    expect(kinds.map((k) => k.kind)).toEqual(["forge.claim_revoked", "forge.claim_restored"]);
    expect(kinds.map((k) => k.payload).join()).not.toContain(kids["one"]!.token);
    expect((await claim("one")).status).toBe(200);
  });

  test("a cross-origin revoke is refused and changes nothing", async () => {
    const done = await revoke("two", "revoke", "https://evil.test");
    expect(done.ok).toBe(false);
    expect(state("two")).toBe("open");
  });

  test("use-then-revoke: a used link cannot be revoked", async () => {
    const k = kids["two"]!;
    const form = { token: k.token, username: "two-owner", email: "two@x.test" };
    const res = await fetch(`${k.servers.url}/claim`, {
      method: "POST",
      headers: { origin: k.servers.url },
      body: new URLSearchParams({ ...form, ...(await passkeyFields(k.servers.url, "/claim/options", form)) }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(state("two")).toBe("used");
    const done = await revoke("two", "revoke");
    expect(done.ok).toBe(false);
    expect(state("two")).toBe("used");
  });

  test("an undo after a minute is refused, and an ended link past the minute offers no Undo", async () => {
    const id = await orgOf("one");
    const t = Date.now();
    expect(revokeClaim(kids["one"]!.app.db, id, t)).toBe(true);
    const info = linkOf(kids["one"]!.app.db, t)!;
    expect(undoable(info, t + REVOKE_UNDO_MS)).toBe(true);
    expect(undoable(info, t + REVOKE_UNDO_MS + 1_000)).toBe(false);
    expect(restoreClaim(kids["one"]!.app.db, id, t + 61_000)).toBe(false);
    expect(state("one")).toBe("ended");
    expect(restoreClaim(kids["one"]!.app.db, id, t + 59_000)).toBe(true);
    expect(state("one")).toBe("open");
  });

  test("an expired link cannot be revoked, nor brought back", async () => {
    const id = await orgOf("one");
    const later = Date.now() + 25 * 3_600_000;
    expect(linkOf(kids["one"]!.app.db, later)?.state).toBe("ended");
    expect(revokeClaim(kids["one"]!.app.db, id, later)).toBe(false);
    // Revoked just before its day ends: the minute has not passed, the day has.
    const edge = Date.now() + CLAIM_TTL_MS - 40_000;
    expect(revokeClaim(kids["one"]!.app.db, id, edge)).toBe(true);
    expect(restoreClaim(kids["one"]!.app.db, id, edge + 59_000)).toBe(false);
    expect(restoreClaim(kids["one"]!.app.db, id)).toBe(true);
  });

  test("an undo of a link that was never revoked changes nothing", async () => {
    expect(restoreClaim(kids["one"]!.app.db, await orgOf("one"))).toBe(false);
    expect(state("one")).toBe("open");
  });

  test("the routes: a member and a guest get nothing, and another origin is refused", async () => {
    for (const cookie of [bobCookie, ""]) {
      for (const act of ["revoke", "undo"] as const) expect((await post("one", act, cookie)).status).toBe(404);
    }
    const crossed = await post("one", "revoke", aliceCookie, "https://evil.test");
    expect(crossed.headers.get("location") ?? "").not.toContain("link=revoked");
    expect(state("one")).toBe("open");
  });

  test("the page: a revoke goes back to the row with its receipt and Undo; an undo takes Undo away", async () => {
    const res = await post("one", "revoke");
    expect(res.status).toBe(303);
    const where = res.headers.get("location")!;
    expect(where).toBe("/forges?link=revoked&forge=one");
    const list = await (await fetch(`${parentServers.url}${where}`, { headers: { cookie: aliceCookie } })).text();
    expect(list).toContain("has ended. Undo is beside it");
    expect(list).toContain('action="/forges/one/undo-link"');
    expect(list).not.toContain('action="/forges/one/revoke-link"');
    // Leaving the receipt behind, the row still offers Undo for the minute.
    const plain = await (await fetch(`${parentServers.url}/forges`, { headers: { cookie: aliceCookie } })).text();
    expect(plain).toContain('action="/forges/one/undo-link"');
    expect(plain).not.toContain("data-receipt");
    const back = await post("one", "undo");
    expect(back.headers.get("location")).toBe("/forges?link=restored&forge=one");
    const after = await (await fetch(`${parentServers.url}/forges`, { headers: { cookie: aliceCookie } })).text();
    expect(after).not.toContain('action="/forges/one/undo-link"');
    expect(after).toContain('action="/forges/one/revoke-link"');
  });

  test("a receipt names only a forge in the list, in fixed words", async () => {
    const page = await (await fetch(`${parentServers.url}/forges?link=revoked&forge=<b>x</b>`, { headers: { cookie: aliceCookie } })).text();
    expect(page).not.toContain("data-receipt");
    expect(page).not.toContain("<b>x</b>");
  });

  test("the MCP tool ends and restores a link, and says what it did", async () => {
    const call = async (action: string) => {
      const res = await fetch(`${parentServers.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${rwToken}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "claim_link", arguments: { name: "one", action } } }),
      });
      const r = ((await res.json()) as any).result;
      return { error: r.isError === true, text: r.content[0].text as string };
    };
    const ended = await call("revoke");
    expect(ended.error).toBe(false);
    expect(ended.text).toContain("has ended");
    expect(state("one")).toBe("ended");
    expect((await call("revoke")).error).toBe(true);
    expect((await call("undo")).error).toBe(false);
    expect(state("one")).toBe("open");
  });

  test("the terminal's action ends and restores a link through the same code, and names a missing forge", async () => {
    const ended = await changeLink(parent, alice.id, "one", "revoke");
    expect(ended.ok).toBe(true);
    expect(state("one")).toBe("ended");
    expect(await changeLink(parent, alice.id, "one", "revoke")).toMatchObject({ ok: false });
    expect((await changeLink(parent, alice.id, "one", "undo")).ok).toBe(true);
    expect(state("one")).toBe("open");
    expect(await changeLink(parent, alice.id, "nobody", "revoke")).toMatchObject({ ok: false, missing: true });
  });
});
