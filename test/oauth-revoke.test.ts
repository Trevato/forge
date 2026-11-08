/**
 * POST /oauth/revoke (RFC 7009, #8360): a harness that disconnects ends its
 * own token; an unknown token and a personal one get the same empty 200 and
 * are not touched.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createClient, issueCode, parseAuthRequest, redeemCode } from "../src/core/oauth.ts";
import { createToken, deleteToken, listTokens } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const verifier = "v".repeat(60);
const challenge = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");

describe("oauth revoke", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-oauth-revoke-"));
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
  });
  afterAll(async () => {
    servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function oauthToken(): Promise<string> {
    const client = createClient(app.db, { name: "Fake", redirectUris: [REDIRECT] });
    const params: Record<string, string> = {
      client_id: client.id,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: challenge,
      scope: "rw",
    };
    const request = parseAuthRequest(app.db, (n) => params[n] ?? "");
    if (!request.ok) throw new Error(request.error);
    const code = issueCode(app.db, alice.id, request.value, { scope: "rw", name: "Fake", lifetimeS: null });
    const minted = await redeemCode(app.db, dataDir, {
      code,
      clientId: client.id,
      redirectUri: REDIRECT,
      verifier,
      issuer: base,
    });
    if (!minted.ok || minted.value.token === undefined) throw new Error("no token");
    return minted.value.token;
  }

  const revoke = (token: string) =>
    fetch(`${base}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  const callApi = (token: string) =>
    fetch(`${base}/api/v1/asked`, { headers: { authorization: `Bearer ${token}` } });
  const mcp = (token: string) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

  test("a revoked token is refused by /api/v1 and /mcp, and the audit trail says so", async () => {
    const token = await oauthToken();
    expect((await mcp(token)).status).not.toBe(401);
    expect((await callApi(token)).status).not.toBe(401);
    const res = await revoke(token);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect((await mcp(token)).status).toBe(401);
    expect((await callApi(token)).status).toBe(401);
    const row = app.db
      .query<{ actor_id: string; payload: string }, []>(
        "SELECT actor_id, payload FROM event WHERE kind = 'token.deleted' ORDER BY seq DESC LIMIT 1",
      )
      .get();
    expect(row?.actor_id).toBe(alice.id);
    expect(row?.payload).toContain("oauth_revoke");
  });

  test("an unknown token, a repeat and an empty body all answer 200 with no body", async () => {
    for (const token of ["forge_nope", "", "x".repeat(500)]) {
      const res = await revoke(token);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
    }
    const token = await oauthToken();
    await revoke(token);
    expect((await revoke(token)).status).toBe(200);
  });

  test("a personal token is not revocable here", async () => {
    const mine = createToken(app.db, alice.id, "mine", "rw");
    const res = await revoke(mine.token);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(listTokens(app.db, alice.id).some((t) => t.id === mine.id)).toBe(true);
    expect((await callApi(mine.token)).status).not.toBe(401);
  });

  test("the revoke accepts a JSON body", async () => {
    const token = await oauthToken();
    const res = await fetch(`${base}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    expect((await callApi(token)).status).toBe(401);
  });

  test("the oauth_token row goes with the revoke, and with a delete in settings", async () => {
    const rows = () =>
      app.db.query<{ n: number }, []>("SELECT count(*) AS n FROM oauth_token").get()?.n ?? 0;
    const before = rows();
    const first = await oauthToken();
    expect(rows()).toBe(before + 1);
    await revoke(first);
    expect(rows()).toBe(before);
    const second = await oauthToken();
    expect(rows()).toBe(before + 1);
    const listed = listTokens(app.db, alice.id);
    for (const t of listed) deleteToken(app.db, alice.id, t.id);
    expect(rows()).toBe(before);
    expect((await callApi(second)).status).toBe(401);
  });

  test("past the per-address limit the revoke answers 429 with Retry-After", async () => {
    let last = 200;
    let waitHeader: string | null = null;
    for (let i = 0; i < 70 && last === 200; i++) {
      const res = await revoke("forge_nope");
      last = res.status;
      waitHeader = res.headers.get("retry-after");
    }
    expect(last).toBe(429);
    expect(Number(waitHeader)).toBeGreaterThan(0);
  });

  test("both metadata documents name the revocation endpoint", async () => {
    for (const path of ["oauth-authorization-server", "openid-configuration"]) {
      const doc = (await (await fetch(`${base}/.well-known/${path}`)).json()) as Record<string, unknown>;
      expect(doc["revocation_endpoint"]).toBe(`${base}/oauth/revoke`);
    }
  });
});
