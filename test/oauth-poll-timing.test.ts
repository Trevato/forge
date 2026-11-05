/** The OAuth connect poll names its phases in Server-Timing. */
import { everyoneIsAMember } from "./helpers/members.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import { newFakeOAuth, newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";

const CLIENT_ID = "Iv1.forge-test-client";
const PASSWORD = "alice-login-secret";
const auth = `Basic ${Buffer.from(`alice:${PASSWORD}`).toString("base64")}`;

let dataDir = "";
let app: App, servers: Servers, fake: FakeForge;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-oauthtime-"));
  const state = newFakeState("github", "octo", "unused-pat");
  state.oauth = newFakeOAuth(CLIENT_ID);
  fake = serveFakeForge(state);
  app = createApp({ dataDir, port: 0 });
  everyoneIsAMember(app.db);
  servers = await serve(app);
  await fetch(`${servers.url}/api/v1/users`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "alice", email: "alice@forge.test", password: PASSWORD }),
  });
  forgetProviders(dataDir);
  process.env.FORGE_GITHUB_CLIENT_ID = CLIENT_ID;
});

afterAll(async () => {
  delete process.env.FORGE_GITHUB_CLIENT_ID;
  fake.stop();
  servers.stop();
  app.close();
  forgetProviders(dataDir);
  await rm(dataDir, { recursive: true, force: true });
});

const names = (res: Response): string[] =>
  (res.headers.get("server-timing") ?? "").split(", ").map((p) => p.split(";")[0]!);

test("polling a pending connection names session and origin; an unknown id names session", async () => {
  const start = await fetch(`${servers.url}/api/v1/user/origins/oauth`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ host: fake.url, kind: "github" }),
  });
  expect(start.status).toBe(201);
  const { flowId } = (await start.json()) as { flowId: string };

  const pending = await fetch(`${servers.url}/api/v1/user/origins/oauth/${flowId}`, { headers: { authorization: auth } });
  await pending.arrayBuffer();
  expect(pending.status).toBe(200);
  expect(names(pending)).toContain("session");
  expect(names(pending)).toContain("origin");

  const unknown = await fetch(`${servers.url}/api/v1/user/origins/oauth/nope`, { headers: { authorization: auth } });
  await unknown.arrayBuffer();
  expect(unknown.status).toBe(404);
  expect(names(unknown)).toContain("session");
});
