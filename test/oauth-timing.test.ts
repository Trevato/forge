/** `GET /oauth/authorize` names its phases in Server-Timing (#3736). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
let root = "";
let app: App;
let servers: Servers;
let cookie = "";
let clientId = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-oauth-timing-"));
  app = createApp({ dataDir: root, port: 0 });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  servers = await serve(app);
  cookie = `forge_session=${createSession(app.db, u.value.id).token}`;
  const res = await fetch(`${servers.url}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Timed", redirect_uris: [REDIRECT] }),
  });
  clientId = ((await res.json()) as any).client_id;
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const names = (res: Response): string[] =>
  (res.headers.get("server-timing") ?? "").split(", ").map((p) => p.split(";")[0]!);

const authorize = (over: Record<string, string> = {}, headers: Record<string, string> = { cookie }) =>
  fetch(
    `${servers.url}/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: "c".repeat(43),
      code_challenge_method: "S256",
      state: "s",
      ...over,
    })}`,
    { redirect: "manual", headers },
  );

test("the consent page names session, request and render", async () => {
  const res = await authorize();
  expect(res.status).toBe(200);
  expect(names(res)).toEqual(expect.arrayContaining(["session", "request", "render"]));
});

test("a refused request names session and request", async () => {
  const res = await authorize({ client_id: "nope" });
  expect(res.status).toBe(400);
  expect(names(res)).toEqual(expect.arrayContaining(["session", "request"]));
  expect(names(res)).not.toContain("render");
});

test("the signed-out redirect is unchanged", async () => {
  const res = await authorize({}, {});
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toStartWith("/signin?next=");
  expect(names(res)).not.toContain("request");
});
