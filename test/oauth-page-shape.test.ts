/** /oauth/authorize speaks the home page's language: headed sections, no .card. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
let dir = "";
let app: App;
let servers: Servers;
let cookie = "";
let clientId = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-oauth-shape-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  cookie = `forge_session=${createSession(app.db, made.value.id).token}`;
  const res = await fetch(`${servers.url}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Shape Client", redirect_uris: [REDIRECT] }),
  });
  clientId = ((await res.json()) as any).client_id;
});
afterAll(async () => {
  servers.stop();
  await rm(dir, { recursive: true, force: true });
});

const get = (over: Record<string, string> = {}) =>
  fetch(
    `${servers.url}/oauth/authorize?${new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
      code_challenge: "c".repeat(43), code_challenge_method: "S256", state: "s", ...over,
    })}`,
    { redirect: "manual", headers: { cookie } },
  );

test("the consent page is a headed section with no card", async () => {
  const res = await get();
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("<h2>What it gets</h2>");
  expect(body).toContain("Shape Client");
  expect(body).toContain('name="grant"');
  expect(body).toContain('name="name"');
  expect(body).not.toMatch(/class="[^"]*\bcard\b/);
});

test("the can't-connect page is a headed section with no card, and is shown, not followed", async () => {
  const res = await get({ redirect_uri: "https://evil.example/cb" });
  expect(res.status).toBe(400);
  expect(res.headers.get("location")).toBeNull();
  const body = await res.text();
  expect(body).toContain("<section");
  expect(body).not.toContain("Nothing was granted");
  expect(body).not.toMatch(/class="[^"]*\bcard\b/);
});

test("the sign-in-only page is a headed section with no card and no token form", async () => {
  const res = await get({ scope: "openid profile" });
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("<h2>What it learns</h2>");
  expect(body).toContain("Sign in to <strong>claude.ai</strong>");
  expect(body).not.toContain('name="grant"');
  expect(body).not.toMatch(/class="[^"]*\bcard\b/);
});
