/**
 * Per-account quotas (#2092): unset by default, an admin sets and clears
 * each from the API or the page, a non-admin is refused, a bad value is a
 * 422, and every change is kept. Nothing enforces them yet.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { createAgent } from "../src/actions/crew.ts";
import { makeItYours } from "../src/actions/make_it_yours.ts";
import { createRepo, forkRepo } from "../src/actions/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { mirrorAndWait, newFakeState, serveFakeForge } from "./fake-origin.ts";
import { proveAll } from "./helpers/verified.ts";
import { getQuotas, quotaChanges } from "../src/settings/quotas.ts";
import { createToken } from "../src/core/tokens.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { newRepoScreen } from "../src/tui/screens/newrepo.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";

describe("quotas", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-quotas-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const username of ["alice", "bob"]) {
      const made = await createUser(app.db, {
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: username === "alice",
      });
      if (!made.ok) throw new Error(made.error);
      if (username === "alice") alice = made.value;
      else bob = made.value;
    }
  });
  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const api = (token: string, method: string, body?: unknown) =>
    fetch(`${servers.url}/api/v1/admin/settings`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  test("limits start unset, an admin sets one and clears it, each change is kept", async () => {
    const t = createToken(app.db, alice.id, "t", "admin").token;
    expect(getQuotas(app.db)).toEqual({ repositories: null, apps: null });
    expect(await (await api(t, "GET")).json()).toMatchObject({
      quotas: { repositories: null, apps: null },
      changes: [],
    });

    const set = await api(t, "PATCH", { quotas: { repositories: 5, apps: "3" } });
    expect(set.status).toBe(200);
    expect(getQuotas(app.db)).toEqual({ repositories: 5, apps: 3 });

    const cleared = await api(t, "PATCH", { quotas: { repositories: null, apps: "" } });
    expect(cleared.status).toBe(200);
    expect(getQuotas(app.db)).toEqual({ repositories: null, apps: null });

    const changes = app.db
      .query<{ n: number }, []>(
        "SELECT count(*) AS n FROM forge_setting_change WHERE key LIKE 'quota.%'",
      )
      .get();
    expect(changes?.n).toBe(4);
    // The audit can be read: through the API, newest first, with who.
    const read = (await (await api(t, "GET")).json()) as any;
    expect(read.changes).toHaveLength(4);
    expect(read.changes[0]).toMatchObject({ actorName: "alice" });
    expect(quotaChanges(app.db).map((c) => c.key).sort()).toEqual([
      "apps",
      "apps",
      "repositories",
      "repositories",
    ]);
  });

  const rpc = async (token: string, name: string, args: unknown = {}) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  test("the quotas tool: dry by default, an admin scope to change, never a non-admin", async () => {
    const admin = createToken(app.db, alice.id, "t", "admin").token;
    const ro = createToken(app.db, alice.id, "t", "ro").token;
    const bobAdmin = createToken(app.db, bob.id, "t", "admin").token;
    expect((await rpc(bobAdmin, "quotas")).error).toContain("no such tool");

    expect((await rpc(ro, "quotas")).value.quotas).toEqual({ repositories: null, apps: null });
    const dry = await rpc(admin, "quotas", { key: "apps", value: "9" });
    expect(dry.value.says).toContain("Would set");
    expect(getQuotas(app.db).apps).toBeNull();

    const refused = await rpc(ro, "quotas", { key: "apps", value: "9", dryRun: false });
    expect(refused.error).toContain("forbidden");
    expect(getQuotas(app.db).apps).toBeNull();

    expect((await rpc(admin, "quotas", { key: "apps", value: "0", dryRun: false })).error).toContain(
      "invalid_quota",
    );
    const done = await rpc(admin, "quotas", { key: "apps", value: "9", dryRun: false });
    expect(done.value.quotas.apps).toBe(9);
    expect(getQuotas(app.db).apps).toBe(9);
    await rpc(admin, "quotas", { key: "apps", value: "", dryRun: false });
    expect(getQuotas(app.db).apps).toBeNull();
    expect((await rpc(admin, "quotas")).value.changes[0]).toMatchObject({ key: "apps", to: "" });
  });

  test("a non-admin is refused", async () => {
    const t = createToken(app.db, bob.id, "t", "admin").token;
    expect((await api(t, "GET")).status).toBe(404);
    expect((await api(t, "PATCH", { quotas: { apps: 2 } })).status).toBe(404);
    expect(getQuotas(app.db).apps).toBeNull();
  });

  test("a bad value is a 422 and changes nothing", async () => {
    const t = createToken(app.db, alice.id, "t", "admin").token;
    for (const bad of [0, -1, 1.5, "abc", "1e3", true, [], 2_000_000_000]) {
      const res = await api(t, "PATCH", { quotas: { apps: 4, repositories: bad } });
      expect(res.status).toBe(422);
    }
    expect((await api(t, "PATCH", { quotas: { nope: 1 } })).status).toBe(422);
    expect((await api(t, "PATCH", {})).status).toBe(422);
    expect(getQuotas(app.db)).toEqual({ repositories: null, apps: null });
  });

  test("the admin page form sets a quota and refuses a bad one", async () => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    });
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const post = (form: Record<string, string>) =>
      fetch(`${servers.url}/admin/quotas`, {
        method: "POST",
        redirect: "manual",
        headers: {
          cookie,
          "content-type": "application/x-www-form-urlencoded",
          origin: servers.url,
        },
        body: new URLSearchParams(form),
      });
    await post({ repositories: "7", apps: "" });
    expect(getQuotas(app.db)).toEqual({ repositories: 7, apps: null });
    await post({ repositories: "0", apps: "2" });
    expect(getQuotas(app.db)).toEqual({ repositories: 7, apps: null });
    const page = await fetch(`${servers.url}/admin/limits`, { headers: { cookie } });
    const text = await page.text();
    expect(text).toContain('name="repositories"');
    expect(text).toContain("alice");
    expect(text).toContain("no limit");
  });

  test("with the apps limit at 1, a fresh account's second app is refused, the owner's is not", async () => {
    const admin = createToken(app.db, alice.id, "t", "admin").token;
    const bobT = createToken(app.db, bob.id, "t", "admin").token;
    const create = (token: string, name: string) =>
      fetch(`${servers.url}/api/v1/apps`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
    // No limit set: nothing changes.
    expect((await create(bobT, "free-one")).status).toBe(201);
    expect((await create(bobT, "free-two")).status).toBe(201);
    app.db.run("DELETE FROM app WHERE repo_id IN (SELECT id FROM repo WHERE owner_id = ?1)", [bob.id]);

    await api(admin, "PATCH", { quotas: { apps: 1 } });
    try {
      expect((await create(bobT, "first")).status).toBe(201);
      const second = await create(bobT, "second");
      expect(second.status).toBe(403);
      const refusal = (await second.json()) as any;
      expect(refusal).toMatchObject({ error: "app_limit", limit: 1, count: 1 });
      expect(refusal.message).toContain("1 of 1 apps");

      // The same sentence on the page.
      const signin = await fetch(`${servers.url}/signin`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
        body: new URLSearchParams({ username: "bob", password: "a-good-passphrase" }),
      });
      const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const form = await fetch(`${servers.url}/apps/new`, {
        method: "POST",
        redirect: "manual",
        headers: {
          cookie,
          "content-type": "application/x-www-form-urlencoded",
          origin: servers.url,
        },
        body: new URLSearchParams({ name: "third", visibility: "private" }),
      });
      expect(form.status).toBe(422);
      expect(await form.text()).toContain("1 of 1 apps");

      // The owner is never limited.
      expect((await create(admin, "owner-one")).status).toBe(201);
      expect((await create(admin, "owner-two")).status).toBe(201);
    } finally {
      await api(admin, "PATCH", { quotas: { apps: null } });
    }
  });

  test("at the limit, make-it-yours, the repo app endpoint and the settings form refuse the same way", async () => {
    const admin = createToken(app.db, alice.id, "t", "admin").token;
    const made = await createUser(app.db, {
      trusted: true,
      username: "carol",
      email: "carol@forge.local",
      password: "a-good-passphrase",
    });
    if (!made.ok) throw new Error(made.error);
    const carol = made.value;
    const source = await newApp(app, alice, { name: "seed", visibility: "public" });
    if (!source.ok) throw new Error(String(source.error));
    await api(admin, "PATCH", { quotas: { apps: 1 } });
    try {
      expect((await newApp(app, carol, { name: "mine", visibility: "private" })).ok).toBe(true);
      const bare = await createRepo(app, carol, { name: "bare" });
      if (!bare.ok) throw new Error(String(bare.error));

      // Make it yours: refused before the fork, no repository left behind.
      for (const dryRun of [true, false]) {
        const copied = await makeItYours(app, carol, source.value.repo, { dryRun });
        expect(copied.ok).toBe(false);
        if (!copied.ok) {
          expect(copied.error.kind).toBe("invalid");
          expect(JSON.stringify(copied.error)).toContain("1 of 1 apps");
        }
      }
      expect(getRepo(app.db, "carol", "seed")).toBeUndefined();

      // POST /api/v1/repos/:owner/:name/app
      const carolT = createToken(app.db, carol.id, "t", "admin").token;
      const enable = await fetch(`${servers.url}/api/v1/repos/carol/bare/app`, {
        method: "POST",
        headers: { authorization: `Bearer ${carolT}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(enable.status).toBe(403);
      const refusal = (await enable.json()) as any;
      expect(refusal).toMatchObject({ error: "app_limit", limit: 1, count: 1 });
      expect(refusal.message).toContain("1 of 1 apps");

      // The app settings form.
      const cookie = `forge_session=${createSession(app.db, carol.id).token}`;
      const form = await fetch(`${servers.url}/carol/bare/settings/app`, {
        method: "POST",
        redirect: "manual",
        headers: {
          cookie,
          "content-type": "application/x-www-form-urlencoded",
          origin: servers.url,
        },
        body: new URLSearchParams({ slug: "bare", access: "private", previewData: "copy" }),
      });
      expect(form.status).toBe(422);
      expect(await form.text()).toContain("1 of 1 apps");
    } finally {
      await api(admin, "PATCH", { quotas: { apps: null } });
    }
  });

  test("a stranger naming an account at its limit is told forbidden_owner, never its count", async () => {
    const admin = createToken(app.db, alice.id, "t", "admin").token;
    const bobT = createToken(app.db, bob.id, "t", "admin").token;
    const owned = await newApp(app, alice, { name: "alices-one", visibility: "private" });
    if (!owned.ok) throw new Error(String(owned.error));
    await api(admin, "PATCH", { quotas: { apps: 1 } });
    try {
      const res = await fetch(`${servers.url}/api/v1/apps`, {
        method: "POST",
        headers: { authorization: `Bearer ${bobT}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "x", owner: "alice" }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as any;
      expect(body.error).toBe("forbidden_owner");
      expect(body).not.toHaveProperty("count");
      expect(JSON.stringify(body)).not.toContain("apps");
    } finally {
      await api(admin, "PATCH", { quotas: { apps: null } });
    }
  });
});

describe("the repositories limit", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin: string;
  let fresh: string;
  let freshUser: User;
  let boss: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-quotas-limit-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const users: User[] = [];
    for (const username of ["boss", "fresh"]) {
      const made = await createUser(app.db, {
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: username === "boss",
      });
      if (!made.ok) throw new Error(made.error);
      users.push(made.value);
    }
    freshUser = users[1]!;
    boss = users[0]!;
    admin = createToken(app.db, users[0]!.id, "t", "admin").token;
    fresh = createToken(app.db, freshUser.id, "t", "rw").token;
  });
  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const post = (token: string, path: string, body: unknown) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const setLimit = (value: number | null) =>
    fetch(`${servers.url}/api/v1/admin/settings`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: JSON.stringify({ quotas: { repositories: value } }),
    });

  test("past the limit create and fork are refused with the sentence; admins and no limit are free", async () => {
    // No limit: nothing changes.
    expect((await post(admin, "/api/v1/repos", { name: "base", visibility: "public" })).status).toBe(201);
    expect((await setLimit(2)).status).toBe(200);

    for (const name of ["one", "two"])
      expect((await post(fresh, "/api/v1/repos", { name })).status).toBe(201);
    const third = await post(fresh, "/api/v1/repos", { name: "three" });
    expect(third.status).toBe(403);
    expect(await third.json()).toMatchObject({
      error: "repository_limit",
      message: "2 of 2 repositories",
    });
    const fork = await post(fresh, "/api/v1/repos/boss/base/forks", {});
    expect(fork.status).toBe(403);
    expect(((await fork.json()) as any).message).toBe("2 of 2 repositories");

    // The owner (an admin) is never limited.
    for (const name of ["a", "b", "c"])
      expect((await post(admin, "/api/v1/repos", { name })).status).toBe(201);

    // Clearing the limit lets the fresh account make one more.
    expect((await setLimit(null)).status).toBe(200);
    expect((await post(fresh, "/api/v1/repos", { name: "three" })).status).toBe(201);
  });
  test("a copy and a mirror say the sentence; an agent is not held to it", async () => {
    // alice's public app, owned by the admin, for the copy.
    const made = await newApp(app, boss, { name: "garden", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    expect((await setLimit(2)).status).toBe(200);
    // fresh owns three here, so it is over the line.
    const copy = await makeItYours(app, freshUser, made.value.repo, { dryRun: false });
    expect(copy.ok).toBe(false);
    if (!copy.ok) expect(copy.error).toEqual({ kind: "repository_limit", message: "3 of 2 repositories" });
    const viaApi = await post(fresh, "/api/v1/repos/boss/garden/make-it-yours", { dryRun: false });
    expect(viaApi.status).toBe(403);
    expect(((await viaApi.json()) as any).message).toBe("3 of 2 repositories");

    // A mirror is a repository too.
    const state = newFakeState("forgejo", "someone", "tok");
    state.repos.push({
      id: 1,
      fullName: "someone/gears",
      cloneUrl: "http://127.0.0.1:1/someone/gears.git",
      defaultBranch: "main",
    });
    const fake = serveFakeForge(state);
    try {
      proveAll(app);
      const freshAdmin = createToken(app.db, freshUser.id, "o", "admin").token;
      const connected = await post(freshAdmin, "/api/v1/user/origins", { host: fake.url, token: "tok" });
      expect(connected.status).toBe(201);
      const originId = ((await connected.json()) as { id: string }).id;
      const job = await mirrorAndWait(
        await post(freshAdmin, `/api/v1/user/origins/${originId}/mirror`, { fullName: "someone/gears" }),
      );
      expect(job?.stage).toBe("failed");
      expect(job?.error).toBe("Not mirrored: 3 of 2 repositories.");
    } finally {
      fake.stop();
    }

    // An agent is held to nothing: it forks per issue to work.
    const agent = await createAgent(app, boss, { username: "worker" });
    if (!agent.ok) throw new Error(String(agent.error));
    const forked = await forkRepo(app, agent.value.user, getRepo(app.db, "boss", "garden")!);
    expect(forked.ok).toBe(true);

    expect((await setLimit(null)).status).toBe(200);
  });
  test("owning exactly the limit is refused with 'N of N'; the pages and the terminal say so too", async () => {
    const made = await createUser(app.db, {
      trusted: true,
      username: "exact",
      email: "exact@forge.local",
      password: "a-good-passphrase",
    });
    if (!made.ok) throw new Error(made.error);
    const exact = made.value;
    expect((await setLimit(2)).status).toBe(200);
    for (const name of ["x1", "x2"]) expect((await createRepo(app, exact, { name })).ok).toBe(true);

    const refused = await createRepo(app, exact, { name: "x3" });
    expect(refused).toEqual({ ok: false, error: "repository_limit" });

    // The new-repository page: a 422 with the sentence on the form.
    const cookie = `forge_session=${createSession(app.db, exact.id).token}`;
    const form = await fetch(`${servers.url}/new`, {
      method: "POST",
      headers: { cookie, origin: servers.url },
      body: new URLSearchParams({ owner: "exact", name: "x3" }),
      redirect: "manual",
    });
    expect(form.status).toBe(422);
    expect(await form.text()).toContain("Not made: 2 of 2 repositories.");
    expect(getRepo(app.db, "exact", "x3")).toBeUndefined();

    // The terminal's new-repository screen: the same sentence, as a toast.
    const terminal = headlessTerminal(120, 30);
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: "exact", remoteAddress: "127.0.0.1", fingerprint: "SHA256:exact", user: exact },
      { terminal, exitHooks: false },
    );
    tui.start();
    try {
      tui.ctx.push(newRepoScreen(session, tui.ctx));
      await settleApp(tui);
      for (const ch of "x3")
        tui.dispatch({ type: "key", key: ch, ctrl: false, alt: false, shift: false });
      tui.dispatch({ type: "key", key: "d", ctrl: true, alt: false, shift: false });
      await settleApp(tui);
      expect(tui.screen.toText()).toContain("not made: 2 of 2 repositories");
    } finally {
      tui.stop();
    }
    expect(getRepo(app.db, "exact", "x3")).toBeUndefined();
    expect((await setLimit(null)).status).toBe(200);
  });
});
