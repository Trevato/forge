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
import { getQuotas, quotaChanges } from "../src/settings/quotas.ts";
import { createToken } from "../src/core/tokens.ts";
import { newApp } from "../src/actions/apps.ts";
import { createRepo } from "../src/actions/repos.ts";
import { makeItYours } from "../src/actions/make_it_yours.ts";
import { getRepo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

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
