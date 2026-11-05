import { everyoneIsAMember } from "./helpers/members.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import { newFakeOAuth, newFakeState, serveFakeForge, type FakeForge, type FakeOAuth } from "./fake-origin.ts";
import { withoutEnv } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";

/** A sign-in begun from /bring comes back to /bring with the link kept, through the real flow routes (#9388). */

const PASSWORD = "alice-login-secret";
const CLIENT_ID = "Iv1.forge-test-client";
const auth = `Basic ${Buffer.from(`alice:${PASSWORD}`).toString("base64")}`;
withoutEnv("FORGE_URL");

let dir: string;
let app: App;
let servers: Servers;
let fake: FakeForge;
let oauth: FakeOAuth;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-bring-oauth-"));
  oauth = newFakeOAuth(CLIENT_ID);
  const state = newFakeState("github", "octo", "unused-pat");
  state.oauth = oauth;
  fake = serveFakeForge(state);
  process.env.FORGE_GITHUB_CLIENT_ID = CLIENT_ID;
  app = createApp({ dataDir: dir, port: 0 });
  everyoneIsAMember(app.db);
  servers = await serve(app);
  await fetch(`${servers.url}/api/v1/users`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "alice", email: "alice@forge.test", password: PASSWORD }),
  });
  proveAll(app);
  forgetProviders(dir);
});
afterAll(async () => {
  delete process.env.FORGE_GITHUB_CLIENT_ID;
  fake.stop();
  servers.stop();
  app.close();
  forgetProviders(dir);
  await rm(dir, { recursive: true, force: true });
});

const form = (path: string, body: Record<string, string>) =>
  fetch(`${servers.url}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

describe("sign in from /bring and come back to it", () => {
  test("start, poll while pending, poll when approved: each step keeps the link", async () => {
    const link = `${fake.url}/octo/widgets`;
    const query = `then=bring&link=${encodeURIComponent(link)}`;
    const started = await form("/settings/origins/oauth", { host: fake.url, kind: "github", then: "bring", link });
    expect(started.status).toBe(303);
    const flowPage = started.headers.get("location")!;
    expect(flowPage).toContain("/settings/origins/flows/");
    expect(flowPage).toContain(query);
    const flowId = flowPage.split("/flows/")[1]!.split("?")[0]!;

    // The page names where the poll goes, with the return in its query.
    const shown = await fetch(`${servers.url}${flowPage}`, { headers: { authorization: auth } });
    expect(await shown.text()).toContain(`/settings/origins/flows/${flowId}/poll?${query.replaceAll("&", "&amp;")}`);

    // Not approved yet: back to the flow page, still carrying the return.
    const pending = await form(`/settings/origins/flows/${flowId}/poll?${query}`, {});
    expect(pending.status).toBe(303);
    expect(pending.headers.get("location")).toBe(`/settings/origins/flows/${flowId}?${query}`);

    // Approved: the poll lands on /bring with the link and a connected flag.
    oauth.approved = true;
    const done = await form(`/settings/origins/flows/${flowId}/poll?${query}`, {});
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe(`/bring?link=${encodeURIComponent(link)}&connected=1`);

    const back = await fetch(`${servers.url}${done.headers.get("location")!}`, { headers: { authorization: auth } });
    expect(back.status).toBe(200);
    expect(await back.text()).toContain(`value="${link}"`);
  });
});
