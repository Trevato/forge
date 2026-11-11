/**
 * Forge-level secrets: sealed under `secret:<scope>:<name>`, the narrowest
 * scope wins, the list never carries a value, admins alone write, and every
 * open through the resolver leaves an event without the value in it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createOrg } from "../src/core/orgs.ts";
import {
  listSecretNames,
  resolveSecrets,
  setSecret,
} from "../src/core/secret_store.ts";
import { createUser, type User } from "../src/core/users.ts";
import { open, seal } from "../src/kernel/secret.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { tokenFor } from "./helpers/tokens.ts";

quietLogs();

describe("forge-level secrets", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let orgId = "";
  let repoId = "";
  let adminToken = "";
  let bobToken = "";

  const stored = (name: string, scope: string): string | undefined =>
    app.db
      .query<{ value_enc: string }, [string, string]>(
        "SELECT value_enc FROM secret WHERE name = ?1 AND scope = ?2",
      )
      .get(name, scope)?.value_enc;
  const ask = (names: string[], who = {}) =>
    resolveSecrets(app.db, dataDir, app.bus, names, who);
  const api = (path: string, init: RequestInit = {}, token = adminToken) =>
    fetch(`${servers.url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });
  const mint = async (username: string): Promise<string> => tokenFor(app, username, "admin");

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-secret-store-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.test",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, { origin: "seed", trusted: true,
      username: "bob",
      email: "bob@forge.test",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    const org = createOrg(app.db, "acme", alice.id);
    if (!org.ok) throw new Error(org.error);
    orgId = org.value.id;
    const repo = await createRepo(app, alice, {
      name: "site",
      visibility: "private",
    });
    if (!repo.ok) throw new Error(String(repo.error));
    repoId = repo.value.id;
    adminToken = await mint("alice");
    bobToken = await mint("bob");
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a value is sealed under its scope and name, and opens only there", () => {
    const set = setSecret(app.db, dataDir, "forge", "", "CF_TOKEN", "s3cret-1");
    expect(set.ok).toBe(true);
    const sealed = stored("CF_TOKEN", "forge")!;
    expect(sealed).toStartWith("v2:");
    expect(sealed).not.toContain("s3cret-1");
    const right = open(dataDir, sealed, "secret:forge:CF_TOKEN");
    expect(right.ok && right.value).toBe("s3cret-1");
    // Lifted under another name or scope, it stops opening.
    expect(open(dataDir, sealed, "secret:forge:OTHER").ok).toBe(false);
    expect(open(dataDir, sealed, "secret:org:CF_TOKEN").ok).toBe(false);
    expect(ask(["CF_TOKEN"])).toEqual({ CF_TOKEN: "s3cret-1" });
  });

  test("the narrowest scope wins, and a name nobody set is absent", () => {
    app.db.query("DELETE FROM secret WHERE name = 'BUCKET_KEY'").run();
    setSecret(app.db, dataDir, "forge", "", "BUCKET_KEY", "forge-key");
    expect(ask(["BUCKET_KEY"], { org: orgId, repo: repoId })).toEqual({
      BUCKET_KEY: "forge-key",
    });
    setSecret(app.db, dataDir, "org", orgId, "BUCKET_KEY", "org-key");
    expect(ask(["BUCKET_KEY"], { org: orgId, repo: repoId })).toEqual({
      BUCKET_KEY: "org-key",
    });
    setSecret(app.db, dataDir, "repo", repoId, "BUCKET_KEY", "repo-key");
    expect(ask(["BUCKET_KEY"], { org: orgId, repo: repoId })).toEqual({
      BUCKET_KEY: "repo-key",
    });
    // Without the repo or org named, only the forge's answers.
    expect(ask(["BUCKET_KEY"])).toEqual({ BUCKET_KEY: "forge-key" });
    expect(ask(["NEVER_SET"], { repo: repoId })).toEqual({});
  });

  test("a row that will not open is skipped, not substituted by a wider one", () => {
    setSecret(app.db, dataDir, "forge", "", "ROTATED", "wide");
    setSecret(app.db, dataDir, "repo", repoId, "ROTATED", "narrow");
    app.db
      .query(
        "UPDATE secret SET value_enc = ?1 WHERE name = 'ROTATED' AND scope = 'repo'",
      )
      .run(seal(dataDir, "narrow", "secret:repo:SOMETHING_ELSE"));
    expect(ask(["ROTATED"], { repo: repoId })).toEqual({});
  });

  test("names and values are validated at the boundary", () => {
    const bad = (scope: string, id: string, name: string, value: string) =>
      setSecret(app.db, dataDir, scope, id, name, value);
    expect(bad("forge", "", "lower", "x")).toEqual({
      ok: false,
      error: "invalid_name",
    });
    expect(bad("forge", "", "A", "")).toEqual({
      ok: false,
      error: "invalid_value",
    });
    expect(bad("forge", "", "A", "a\0b")).toEqual({
      ok: false,
      error: "invalid_value",
    });
    expect(bad("galaxy", "", "A", "x")).toEqual({
      ok: false,
      error: "invalid_scope",
    });
    expect(bad("org", "", "A", "x")).toEqual({
      ok: false,
      error: "invalid_scope",
    });
  });

  test("listing is names and timestamps, never a value", async () => {
    setSecret(app.db, dataDir, "forge", "", "CF_TOKEN", "s3cret-1");
    const listed = listSecretNames(app.db, "forge");
    expect(listed.map((s) => s.name)).toContain("CF_TOKEN");
    expect(JSON.stringify(listed)).not.toContain("s3cret-1");

    const res = await api("/api/v1/secrets/forge");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"name":"CF_TOKEN"');
    expect(text).toContain('"lastReadAt"');
    expect(text).not.toContain("s3cret-1");
    expect(text).not.toContain("value_enc");
  });

  test("only a forge admin writes, over the API, at every scope", async () => {
    setSecret(app.db, dataDir, "forge", "", "CF_TOKEN", "s3cret-1");
    app.db.query("DELETE FROM secret WHERE scope = 'org'").run();
    setSecret(app.db, dataDir, "org", orgId, "BUCKET_KEY", "org-key");
    const put = (token: string, path: string, body: unknown) =>
      api(path, { method: "PUT", body: JSON.stringify(body) }, token);
    expect(
      (await put(bobToken, "/api/v1/secrets/forge/NOPE", { value: "x" }))
        .status,
    ).toBe(404);
    expect(stored("NOPE", "forge")).toBeUndefined();
    expect((await api("/api/v1/secrets/forge", {}, bobToken)).status).toBe(404);
    expect(
      (
        await api(
          "/api/v1/secrets/forge/CF_TOKEN",
          { method: "DELETE" },
          bobToken,
        )
      ).status,
    ).toBe(404);
    expect(stored("CF_TOKEN", "forge")).toBeDefined();

    expect(
      (await put(adminToken, "/api/v1/secrets/forge/API_SET", { value: "v" }))
        .status,
    ).toBe(200);
    expect(
      (
        await put(adminToken, "/api/v1/secrets/org/ORG_SET", {
          value: "v",
          ref: "acme",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await put(adminToken, "/api/v1/secrets/repo/REPO_SET", {
          value: "v",
          ref: "alice/site",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await put(adminToken, "/api/v1/secrets/org/X", {
          value: "v",
          ref: "nobody",
        })
      ).status,
    ).toBe(404);
    expect(
      (await put(adminToken, "/api/v1/secrets/forge/bad", { value: "v" }))
        .status,
    ).toBe(422);
    expect(listSecretNames(app.db, "org", orgId).map((s) => s.name)).toEqual([
      "BUCKET_KEY",
      "ORG_SET",
    ]);

    expect(
      (await api("/api/v1/secrets/forge/API_SET", { method: "DELETE" })).status,
    ).toBe(200);
    expect(
      (await api("/api/v1/secrets/forge/API_SET", { method: "DELETE" })).status,
    ).toBe(422);
    expect(stored("API_SET", "forge")).toBeUndefined();
  });

  test("every open leaves an event with who, which run and what name — not the value", () => {
    setSecret(app.db, dataDir, "forge", "", "AUDITED", "plain-audited");
    const before = app.db
      .query<{ n: number }, []>(
        "SELECT count(*) n FROM event WHERE kind = 'secret.read'",
      )
      .get()!.n;
    ask(["AUDITED"], { actor: alice.id, run: "run-42", repo: repoId });
    const events = app.db
      .query<
        { actor_id: string | null; repo_id: string | null; payload: string },
        []
      >(
        "SELECT actor_id, repo_id, payload FROM event WHERE kind = 'secret.read' ORDER BY id DESC",
      )
      .all();
    expect(events.length).toBe(before + 1);
    expect(events[0]!.actor_id).toBe(alice.id);
    expect(JSON.parse(events[0]!.payload)).toEqual({
      name: "AUDITED",
      scope: "forge",
      run: "run-42",
    });
    expect(JSON.stringify(events)).not.toContain("plain-audited");
    // The set and delete events carry names too, and no value.
    const all = app.db
      .query<{ payload: string }, []>(
        "SELECT payload FROM event WHERE kind LIKE 'secret.%'",
      )
      .all();
    expect(JSON.stringify(all)).not.toContain("s3cret-1");
    // And last_read_at is stamped.
    expect(
      listSecretNames(app.db, "forge").find((s) => s.name === "AUDITED")!
        .lastReadAt,
    ).not.toBeNull();
  });

  test("a secret never reaches an app's environment", () => {
    // The namespaces are apart: the app resolver reads app_env only.
    const row = app.db
      .query<{ n: number }, []>("SELECT count(*) n FROM app_env")
      .get()!;
    expect(row.n).toBe(0);
  });

  test("the settings pages: forge, org and repo cards, admins only", async () => {
    setSecret(app.db, dataDir, "forge", "", "CF_TOKEN", "s3cret-1");
    const login = async (username: string): Promise<string> => {
      const res = await fetch(`${servers.url}/signin`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: servers.url,
        },
        body: new URLSearchParams({ username, password: "a-good-passphrase" }),
      });
      return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    };
    const cookie = await login("alice");
    const get = (path: string, c: string) =>
      fetch(`${servers.url}${path}`, { headers: { cookie: c } });
    for (const path of ["/settings/secrets", "/acme", "/alice/site/settings"]) {
      const page = await (await get(path, cookie)).text();
      expect(page).toContain("Secrets");
      expect(page).not.toContain("s3cret-1");
    }
    expect(await (await get("/settings/secrets", cookie)).text()).toContain(
      "CF_TOKEN",
    );
    expect(await (await get("/settings/secrets", cookie)).text()).toContain(
      "Signup has no human check. Set FORGE_TURNSTILE_SECRET and FORGE_TURNSTILE_SITEKEY",
    );
    const bob = await login("bob");
    expect((await get("/settings/secrets", bob)).status).toBe(404);
    expect(await (await get("/acme", bob)).text()).not.toContain("Seal");

    const set = await fetch(`${servers.url}/settings/secrets`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        origin: servers.url,
      },
      body: new URLSearchParams({
        scope: "forge",
        ref: "",
        name: "FORM_SET",
        value: "v",
      }),
    });
    expect(set.status).toBe(303);
    expect(stored("FORM_SET", "forge")).toBeDefined();
    const cross = await fetch(`${servers.url}/settings/secrets`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://evil.test",
      },
      body: new URLSearchParams({
        scope: "forge",
        ref: "",
        name: "CROSS",
        value: "v",
      }),
    });
    expect(cross.status).toBe(403);
    expect(stored("CROSS", "forge")).toBeUndefined();
  });
});
