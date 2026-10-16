/**
 * A new MCP client's whole road, in order, using only what the forge
 * advertises: an unauthenticated request, its 401 challenge, the
 * protected-resource document, the authorization-server document, dynamic
 * registration, authorize with S256 (as a signed-in, consenting user), the
 * token, and a tools/list with it. Each next URL is read from the previous
 * answer, never written down here. The same walk with `plain` stops at authorize.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const REDIRECT = "https://client.example/callback";
const verifier = "w".repeat(60);
const challenge = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");

describe("an MCP client walks from nothing to a tool list", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let cookie: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-walk-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const made = await createUser(app.db, {
      trusted: true,
      username: "walker",
      email: "walker@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    cookie = `forge_session=${createSession(app.db, made.value.id).token}`;
  });
  afterAll(async () => {
    servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const listTools = (token?: string) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
  const json = async (url: string, init?: RequestInit) => {
    const res = await fetch(url, init);
    return { res, doc: (await res.json()) as any };
  };

  /** Everything up to authorize, each URL taken from the answer before. */
  const discover = async () => {
    const first = await listTools();
    expect(first.status).toBe(401);
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(
      first.headers.get("www-authenticate") ?? "",
    )?.[1];
    expect(metadataUrl).toBeString();

    const resource = (await json(metadataUrl!)).doc;
    const issuer: string = resource.authorization_servers[0];
    expect(issuer).toBeString();

    const server = (
      await json(new URL("/.well-known/oauth-authorization-server", issuer).href)
    ).doc;
    expect(server.code_challenge_methods_supported).toContain("S256");

    const reg = await json(server.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Walker", redirect_uris: [REDIRECT] }),
    });
    expect(reg.res.status).toBe(201);
    return { resource, server, clientId: reg.doc.client_id as string };
  };

  const params = (clientId: string, method: string) =>
    new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: method,
      state: "walk-1",
    });

  test("401 to tools/list with a token, using only advertised URLs", async () => {
    const { resource, server, clientId } = await discover();
    const q = params(clientId, "S256");

    const page = await fetch(`${server.authorization_endpoint}?${q}`, {
      redirect: "manual",
      headers: { cookie },
    });
    expect(page.status).toBe(200);

    const allowed = await fetch(server.authorization_endpoint, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, origin: base },
      body: new URLSearchParams({
        ...Object.fromEntries(q),
        decision: "allow",
        grant: "ro",
        name: "walk",
        lifetime: "never",
      }),
    });
    expect(allowed.status).toBe(303);
    const back = new URL(allowed.headers.get("location")!);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("walk-1");
    const code = back.searchParams.get("code")!;
    expect(code).toBeString();

    const token = await json(server.token_endpoint, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        code,
        code_verifier: verifier,
      }),
    });
    expect(token.res.status).toBe(200);
    expect(token.doc.access_token).toBeString();

    // The token is used against the resource the metadata named.
    const res = await fetch(resource.resource, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.doc.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as any;
    expect(out.result.tools.length).toBeGreaterThan(0);
  });

  test("the same walk with plain is refused at authorize", async () => {
    const { server, clientId } = await discover();
    const q = params(clientId, "plain");
    const page = await fetch(`${server.authorization_endpoint}?${q}`, {
      redirect: "manual",
      headers: { cookie },
    });
    expect(page.status).toBe(400);
    const post = await fetch(server.authorization_endpoint, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, origin: base },
      body: new URLSearchParams({
        ...Object.fromEntries(q),
        decision: "allow",
        grant: "ro",
        name: "walk",
        lifetime: "never",
      }),
    });
    expect(post.status).toBe(400);
    expect(post.headers.get("location")).toBeNull();
  });
});
