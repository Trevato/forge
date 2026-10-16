/**
 * OAuth for the MCP, step two: the whole dance with a fake client — register,
 * consent, a one-time code, a PKCE exchange — and the refusals that make it
 * safe: a wrong verifier, a replayed code, an unregistered redirect, a forged
 * consent, an expired code.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { listTokens } from "../src/core/tokens.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { verifyIdToken } from "../src/core/oidc.ts";
import { sha256 } from "../src/kernel/hash.ts";
import { serve, type Servers } from "../src/http/server.ts";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const verifier = "v".repeat(60);
const challenge = new Bun.CryptoHasher("sha256")
  .update(verifier)
  .digest("base64url");

describe("oauth authorize and token", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let cookie: string;
  let clientId: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-oauth-flow-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const made = await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    cookie = `forge_session=${createSession(app.db, alice.id).token}`;
    const res = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Fake <b>Client</b>", redirect_uris: [REDIRECT] }),
    });
    clientId = ((await res.json()) as any).client_id;
  });
  afterAll(async () => {
    servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const query = (over: Record<string, string> = {}) =>
    new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "st-1",
      ...over,
    });
  const get = (q: URLSearchParams, withCookie = true) =>
    fetch(`${base}/oauth/authorize?${q}`, {
      redirect: "manual",
      headers: withCookie ? { cookie } : {},
    });
  const consent = (
    q: URLSearchParams,
    extra: Record<string, string> = {},
    headers: Record<string, string> = {},
  ) =>
    fetch(`${base}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, origin: base, ...headers },
      body: new URLSearchParams({
        ...Object.fromEntries(q),
        decision: "allow",
        grant: "ro",
        name: "my phone",
        lifetime: "never",
        ...extra,
      }),
    });
  const exchange = (over: Record<string, string> = {}) =>
    fetch(`${base}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
        ...over,
      }),
    });
  const codeFrom = async (extra: Record<string, string> = {}) => {
    const res = await consent(query(), extra);
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe(REDIRECT);
    expect(to.searchParams.get("state")).toBe("st-1");
    return to.searchParams.get("code")!;
  };
  const mcp = async (token: string, name: string, args: unknown = {}) => {
    const res = await fetch(`${base}/mcp`, {
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
    const out = (await res.json()) as any;
    return { error: out.result.isError === true, text: out.result.content[0].text as string };
  };

  test("a signed-out visitor is sent to sign in, then back", async () => {
    const res = await get(query(), false);
    expect(res.status).toBe(303);
    const to = res.headers.get("location")!;
    expect(to.startsWith("/signin?next=")).toBe(true);
    expect(decodeURIComponent(to)).toContain("/oauth/authorize?");
  });

  test("the page names the client (escaped) and the redirect host", async () => {
    const res = await get(query());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Fake &lt;b&gt;Client&lt;/b&gt;");
    expect(text).not.toContain("<b>Client</b>");
    expect(text).toContain("claude.ai");
    expect(text).toContain('name="grant"');
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("the full dance mints a listed, revocable token that works", async () => {
    const code = await codeFrom();
    const res = await exchange({ code });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const out = (await res.json()) as any;
    expect(out.token_type).toBe("Bearer");
    expect(out.scope).toBe("ro");
    expect(out.expires_in).toBeUndefined();
    const listed = listTokens(app.db, alice.id).find((t) => t.name === "my phone");
    expect(listed?.scope).toBe("ro");
    expect(listed?.expiresAt).toBeNull();

    expect((await mcp(out.access_token, "apps")).error).toBe(false);
    const tell = await mcp(out.access_token, "tell", { repo: "alice/x", text: "hi" });
    expect(tell.error).toBe(true);
    expect(tell.text).toContain("forbidden");
  });

  test("the code is stored hashed, never raw", async () => {
    const code = await codeFrom();
    const count = (hash: string) =>
      app.db
        .query<{ n: number }, [string]>("SELECT count(*) AS n FROM oauth_code WHERE code_hash = ?1")
        .get(hash)!.n;
    expect(count(code)).toBe(0);
    expect(count(sha256(code))).toBe(1);
  });

  test("the consent page lets its form go to the registered origin only", async () => {
    const csp = (await get(query())).headers.get("content-security-policy")!;
    expect(csp).toContain("form-action 'self' https://claude.ai;");
  });

  test("a chunked token body past the cap is refused and not read in full", async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode("x".repeat(4096));
    const body = new ReadableStream({
      pull(c) {
        pulled++;
        if (pulled > 64) return c.close();
        c.enqueue(chunk);
      },
    });
    const res = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(((await res.json()) as any).error).toBe("invalid_request");
  });

  test("an expiry is asked for and set", async () => {
    const out = (await (await exchange({ code: await codeFrom({ lifetime: "day", grant: "rw", name: "short" }) })).json()) as any;
    expect(out.expires_in).toBe(86400);
    expect(out.scope).toBe("rw");
    const listed = listTokens(app.db, alice.id).find((t) => t.name === "short");
    expect(listed?.scope).toBe("rw");
    expect(Date.parse(listed!.expiresAt!)).toBeGreaterThan(Date.now());
  });

  test("a wrong verifier is refused, and burns the code", async () => {
    const code = await codeFrom();
    const bad = await exchange({ code, code_verifier: "w".repeat(60) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toBe("invalid_grant");
    expect((await exchange({ code })).status).toBe(400);
  });

  test("a replayed code is refused", async () => {
    const code = await codeFrom();
    expect((await exchange({ code })).status).toBe(200);
    expect((await exchange({ code })).status).toBe(400);
  });

  test("a code for another client or redirect, or an expired one, is refused", async () => {
    expect((await exchange({ code: await codeFrom(), client_id: "other" })).status).toBe(400);
    expect((await exchange({ code: await codeFrom(), redirect_uri: "https://evil.example/cb" })).status).toBe(400);
    const code = await codeFrom();
    app.db.query("UPDATE oauth_code SET expires_at = ?1").run(new Date(Date.now() - 1000).toISOString());
    expect((await exchange({ code })).status).toBe(400);
  });

  test("the token endpoint refuses other grants and junk", async () => {
    expect(((await (await exchange({ grant_type: "password" })).json()) as any).error).toBe("unsupported_grant_type");
    expect((await exchange({ code: "" })).status).toBe(400);
  });

  test("an unregistered redirect is shown, never followed", async () => {
    for (const uri of ["https://evil.example/cb", `${REDIRECT}/x`, `${REDIRECT}?a=1`]) {
      const q = query({ redirect_uri: uri });
      expect((await get(q)).status).toBe(400);
      const res = await consent(q);
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
    expect((await get(query({ client_id: "nobody" }))).status).toBe(400);
  });

  test("PKCE S256 is required", async () => {
    expect((await get(query({ code_challenge_method: "plain" }))).status).toBe(400);
    expect((await get(query({ code_challenge: "short" }))).status).toBe(400);
  });

  test("a consent from another origin, or with no session, grants nothing", async () => {
    const before = listTokens(app.db, alice.id).length;
    expect((await consent(query(), {}, { origin: "https://evil.example" })).status).toBe(403);
    const anon = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: base },
      body: new URLSearchParams({ ...Object.fromEntries(query()), decision: "allow", grant: "ro" }),
    });
    expect(anon.status).toBe(403);
    expect((await consent(query(), { grant: "admin" })).status).toBe(400);
    expect(listTokens(app.db, alice.id).length).toBe(before);
  });

  test("deny returns access_denied with the state", async () => {
    const res = await consent(query(), { decision: "deny" });
    const to = new URL(res.headers.get("location")!);
    expect(to.searchParams.get("error")).toBe("access_denied");
    expect(to.searchParams.get("state")).toBe("st-1");
    expect(to.searchParams.get("code")).toBeNull();
  });

  const b64 = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());

  test("scope=openid with a nonce returns a verifiable id_token beside the access token, and userinfo answers", async () => {
    const q = query({ scope: "openid profile email ro", nonce: "n-0S6_WzA2Mj" });
    const code = new URL((await consent(q)).headers.get("location")!).searchParams.get("code")!;
    const res = await exchange({ code });
    expect(res.status).toBe(200);
    const out = (await res.json()) as any;
    expect(out.access_token.startsWith("forge_")).toBe(true);
    const claims = b64(out.id_token.split(".")[1]);
    expect(claims.iss).toBe(base);
    expect(claims.aud).toBe(clientId);
    expect(claims.sub).toBe(alice.id);
    expect(claims.nonce).toBe("n-0S6_WzA2Mj");
    expect(claims.preferred_username).toBe("alice");
    expect(claims.email).toBe("alice@forge.local");
    const verified = await verifyIdToken(app.db, dataDir, out.id_token, { issuer: base, clientId });
    expect(verified.ok).toBe(true);
    // The same grant: the id_token is not a second credential.
    const info = await fetch(`${base}/oauth/userinfo`, {
      headers: { authorization: `Bearer ${out.access_token}` },
    });
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ sub: alice.id, email: "alice@forge.local" });
    expect((await fetch(`${base}/oauth/userinfo`, { headers: { authorization: `Bearer ${out.id_token}` } })).status).toBe(401);
    expect((await fetch(`${base}/oauth/userinfo`)).status).toBe(401);
  });

  test("consent lists the identity an openid grant shares, and a plain grant lists none", async () => {
    const open = await (await get(query({ scope: "openid email" }))).text();
    expect(open).toContain("What it will learn about you");
    expect(open).toContain("your email address");
    expect(open).not.toContain("your username and name");
    const profile = await (await get(query({ scope: "openid profile email" }))).text();
    expect(profile).toContain("your username and name");
    const plain = await (await get(query())).text();
    expect(plain).not.toContain("What it will learn about you");
    expect(plain).not.toContain("your email address");
  });

  test("a plain grant has no id_token and its token is refused by userinfo", async () => {
    const out = (await (await exchange({ code: await codeFrom() })).json()) as any;
    expect(out.id_token).toBeUndefined();
    const info = await fetch(`${base}/oauth/userinfo`, {
      headers: { authorization: `Bearer ${out.access_token}` },
    });
    expect(info.status).toBe(401);
  });

  test("a person suspended between consent and exchange gets no token and no id_token", async () => {
    const tokensBefore = listTokens(app.db, alice.id).length;
    for (const q of [query({ scope: "openid", nonce: "n-0S6_WzA2Mj" }), query()]) {
      const code = new URL((await consent(q)).headers.get("location")!).searchParams.get("code")!;
      const tokensConsented = listTokens(app.db, alice.id).length;
      app.db.query("UPDATE user SET suspended_at = ?1 WHERE id = ?2").run(new Date().toISOString(), alice.id);
      try {
        const res = await exchange({ code });
        expect(res.status).toBe(400);
        const out = (await res.json()) as any;
        expect(out.error).toBe("invalid_grant");
        expect(out.id_token).toBeUndefined();
        expect(out.access_token).toBeUndefined();
        expect(listTokens(app.db, alice.id).length).toBe(tokensConsented);
      } finally {
        app.db.query("UPDATE user SET suspended_at = NULL WHERE id = ?1").run(alice.id);
      }
    }
    expect(listTokens(app.db, alice.id).length).toBe(tokensBefore);
  });

  test("an overlong nonce is refused",async () => {
    const res = await get(query({ scope: "openid", nonce: "n".repeat(300) }));
    expect(res.status).toBe(400);
  });
});
