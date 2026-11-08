/**
 * grant_type=refresh_token (#8361): an expiring OAuth token renews without a
 * new sign-in; the refresh token rotates, reuse ends the family, scope only narrows.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createClient, issueCode, parseAuthRequest, type OAuthClient } from "../src/core/oauth.ts";
import { deleteToken, pruneTokens, revokeToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const verifier = "v".repeat(60);
const challenge = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");

describe("oauth refresh", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let client: OAuthClient;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-oauth-refresh-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    client = createClient(app.db, { name: "Fake", redirectUris: [REDIRECT] });
  });
  afterAll(async () => {
    servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const post = async (path: string, params: Record<string, string>) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
    const text = await res.text();
    return { status: res.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
  };
  const exchange = async (scope: "ro" | "rw", lifetimeS: number | null) => {
    const params: Record<string, string> = {
      client_id: client.id,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: challenge,
      scope,
    };
    const request = parseAuthRequest(app.db, (n) => params[n] ?? "");
    if (!request.ok) throw new Error(request.error);
    const code = issueCode(app.db, alice.id, request.value, { scope, name: "Fake", lifetimeS });
    return post("/oauth/token", {
      grant_type: "authorization_code",
      code,
      client_id: client.id,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
  };
  const refresh = (token: unknown, extra: Record<string, string> = {}) =>
    post("/oauth/token", { grant_type: "refresh_token", refresh_token: String(token), client_id: client.id, ...extra });
  const api = (token: unknown) =>
    fetch(`${base}/api/v1/asked`, { headers: { authorization: `Bearer ${String(token)}` } }).then((r) => r.status);

  test("a code with a lifetime returns a refresh token, stored hashed; one without does not", async () => {
    const lived = await exchange("rw", 86_400);
    const refreshToken = String(lived.body["refresh_token"]);
    expect(refreshToken.length).toBeGreaterThan(20);
    const rows = app.db.query<{ token_hash: string }, []>("SELECT token_hash FROM oauth_refresh").all();
    expect(rows.some((r) => r.token_hash === refreshToken)).toBe(false);
    expect(rows.length).toBeGreaterThan(0);
    const forever = await exchange("rw", null);
    expect(forever.body["refresh_token"]).toBeUndefined();
    expect(forever.body["expires_in"]).toBeUndefined();
  });

  test("refresh swaps for a new pair and the old pair stops working", async () => {
    const first = await exchange("rw", 86_400);
    expect(await api(first.body["access_token"])).not.toBe(401);
    const next = await refresh(first.body["refresh_token"]);
    expect(next.status).toBe(200);
    expect(next.body["token_type"]).toBe("Bearer");
    expect(next.body["expires_in"]).toBe(86_400);
    expect(next.body["scope"]).toBe("rw");
    expect(next.body["access_token"]).not.toBe(first.body["access_token"]);
    expect(next.body["refresh_token"]).not.toBe(first.body["refresh_token"]);
    expect(await api(first.body["access_token"])).toBe(401);
    expect(await api(next.body["access_token"])).not.toBe(401);
    expect((await refresh(next.body["refresh_token"])).status).toBe(200);
  });

  test("reusing a spent refresh token revokes the whole family and audits it", async () => {
    const first = await exchange("rw", 86_400);
    const second = await refresh(first.body["refresh_token"]);
    expect(second.status).toBe(200);
    const replay = await refresh(first.body["refresh_token"]);
    expect(replay.status).toBe(400);
    expect(replay.body["error"]).toBe("invalid_grant");
    expect(await api(second.body["access_token"])).toBe(401);
    expect((await refresh(second.body["refresh_token"])).body["error"]).toBe("invalid_grant");
    const audit = app.db
      .query<{ actor_id: string; payload: string }, []>(
        "SELECT actor_id, payload FROM event WHERE kind = 'token.deleted' ORDER BY seq DESC LIMIT 1",
      )
      .get();
    expect(audit?.actor_id).toBe(alice.id);
    expect(audit?.payload).toContain("oauth_refresh_reuse");
  });

  test("scope narrows on refresh and never widens", async () => {
    const first = await exchange("rw", 86_400);
    const narrow = await refresh(first.body["refresh_token"], { scope: "ro" });
    expect(narrow.status).toBe(200);
    expect(narrow.body["scope"]).toBe("ro");
    const widen = await refresh(narrow.body["refresh_token"], { scope: "rw" });
    expect(widen.status).toBe(400);
    expect(widen.body["error"]).toBe("invalid_scope");
    const both = await refresh(narrow.body["refresh_token"], { scope: "ro rw" });
    expect(both.body["error"]).toBe("invalid_scope");
    const unknown = await refresh(narrow.body["refresh_token"], { scope: "admin" });
    expect(unknown.body["error"]).toBe("invalid_scope");
    // a refused widening spends nothing
    const kept = await refresh(narrow.body["refresh_token"]);
    expect(kept.status).toBe(200);
    expect(kept.body["scope"]).toBe("ro");
  });

  test("an unknown token, another client and an access token are all invalid_grant", async () => {
    const first = await exchange("rw", 86_400);
    expect((await refresh("nope")).body["error"]).toBe("invalid_grant");
    expect((await refresh(first.body["access_token"])).body["error"]).toBe("invalid_grant");
    const other = createClient(app.db, { name: "Other", redirectUris: [REDIRECT] });
    const res = await post("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: String(first.body["refresh_token"]),
      client_id: other.id,
    });
    expect(res.body["error"]).toBe("invalid_grant");
    expect((await refresh(first.body["refresh_token"])).status).toBe(200);
  });

  test("revoking the refresh token ends the family; so does revoking the access token", async () => {
    const a = await exchange("rw", 86_400);
    await post("/oauth/revoke", { token: String(a.body["refresh_token"]) });
    expect(await api(a.body["access_token"])).toBe(401);
    expect((await refresh(a.body["refresh_token"])).body["error"]).toBe("invalid_grant");
    const b = await exchange("rw", 86_400);
    await post("/oauth/revoke", { token: String(b.body["access_token"]) });
    expect((await refresh(b.body["refresh_token"])).body["error"]).toBe("invalid_grant");
  });

  const accessIdOf = (refreshToken: unknown) =>
    app.db
      .query<{ token_id: string }, [string]>("SELECT token_id FROM oauth_refresh WHERE token_hash = ?1")
      .get(new Bun.CryptoHasher("sha256").update(String(refreshToken)).digest("hex"))?.token_id ?? "";

  test("a delete by someone other than the owner leaves the family refreshing", async () => {
    const a = await exchange("rw", 86_400);
    const rotated = await refresh(a.body["refresh_token"]);
    expect(rotated.status).toBe(200);
    const tokenId = accessIdOf(rotated.body["refresh_token"]);
    expect(deleteToken(app.db, "someone-else", tokenId)).toBe(false);
    expect((await refresh(rotated.body["refresh_token"])).status).toBe(200);
  });

  test("deleteToken and revokeToken each end the token's refresh family", async () => {
    const a = await exchange("rw", 86_400);
    expect(deleteToken(app.db, alice.id, accessIdOf(a.body["refresh_token"]))).toBe(true);
    expect((await refresh(a.body["refresh_token"])).body["error"]).toBe("invalid_grant");
    const b = await exchange("rw", 86_400);
    const tokenId = accessIdOf(b.body["refresh_token"]);
    const family = app.db.query<{ family: string }, [string]>("SELECT family FROM oauth_refresh WHERE token_id = ?1").get(tokenId)?.family;
    expect(revokeToken(app.db, tokenId)).toBe(true);
    expect((await refresh(b.body["refresh_token"])).body["error"]).toBe("invalid_grant");
    expect(app.db.query("SELECT 1 FROM oauth_refresh WHERE family = ?1").get(family ?? "")).toBeNull();
  });

  test("an access token that merely expires still refreshes", async () => {
    const a = await exchange("rw", 86_400);
    app.db.query("UPDATE token SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1").run(accessIdOf(a.body["refresh_token"]));
    expect(pruneTokens(app.db)).toBeGreaterThan(0);
    expect(await api(a.body["access_token"])).toBe(401);
    const next = await refresh(a.body["refresh_token"]);
    expect(next.status).toBe(200);
    expect(await api(next.body["access_token"])).not.toBe(401);
  });

  test("spent rows stay bounded: a family keeps one predecessor however often it refreshes", async () => {
    const a = await exchange("rw", 86_400);
    let token = a.body["refresh_token"];
    for (let i = 0; i < 6; i++) token = (await refresh(token)).body["refresh_token"];
    const rows = app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM oauth_refresh WHERE family = (SELECT family FROM oauth_refresh ORDER BY rowid DESC LIMIT 1)").get();
    expect(rows?.n).toBe(2);
  });

  test("minting purges rows past expiry, abandoned families included", async () => {
    await exchange("rw", 86_400);
    app.db.query("UPDATE oauth_refresh SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    const b = await exchange("rw", 86_400);
    await refresh(b.body["refresh_token"]);
    const old = app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM oauth_refresh WHERE expires_at < '2001'").get();
    expect(old?.n).toBe(0);
  });

  test("revoking a refresh token after its access token was deleted succeeds without an empty audit", async () => {
    const a = await exchange("rw", 86_400);
    app.db.query("DELETE FROM token WHERE id = (SELECT token_id FROM oauth_refresh ORDER BY rowid DESC LIMIT 1)").run();
    app.db.query("UPDATE oauth_refresh SET token_id = NULL WHERE token_id NOT IN (SELECT id FROM token)").run();
    const res = await post("/oauth/revoke", { token: String(a.body["refresh_token"]) });
    expect(res.status).toBe(200);
    expect((await refresh(a.body["refresh_token"])).body["error"]).toBe("invalid_grant");
    const empty = app.db.query("SELECT 1 FROM event WHERE kind = 'token.deleted' AND payload LIKE '%\"tokenId\":\"\"%'").get();
    expect(empty).toBeNull();
  });

  test("a deactivated user's refresh ends the family", async () => {
    const a = await exchange("rw", 86_400);
    app.db.query("UPDATE user SET suspended_at = ?1 WHERE id = ?2").run(new Date().toISOString(), alice.id);
    expect((await refresh(a.body["refresh_token"])).body["error"]).toBe("invalid_grant");
    app.db.query("UPDATE user SET suspended_at = NULL WHERE id = ?1").run(alice.id);
    expect((await refresh(a.body["refresh_token"])).body["error"]).toBe("invalid_grant");
    const left = app.db.query("SELECT 1 FROM oauth_refresh WHERE token_hash = ?1").get(new Bun.CryptoHasher("sha256").update(String(a.body["refresh_token"])).digest("hex"));
    expect(left).toBeNull();
  });

  test("an expired refresh token is refused", async () => {
    const a = await exchange("rw", 86_400);
    app.db.query("UPDATE oauth_refresh SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await refresh(a.body["refresh_token"])).body["error"]).toBe("invalid_grant");
  });

  test("both metadata documents list refresh_token", async () => {
    for (const path of ["oauth-authorization-server", "openid-configuration"]) {
      const doc = (await (await fetch(`${base}/.well-known/${path}`)).json()) as Record<string, unknown>;
      expect(doc["grant_types_supported"]).toEqual(["authorization_code", "refresh_token"]);
    }
  });
});
