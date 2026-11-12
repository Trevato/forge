/** Connecting an origin speaks the home page's language (#9905): one heading, plain sections, no card. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { createFlow } from "../src/origins/oauth.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { everyoneIsAMember } from "./helpers/members.ts";

let dir = "";
let app: App;
let servers: Servers;
let cookie = "";
let userId = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-flow-lang-"));
  app = createApp({ dataDir: dir, port: 0 });
  everyoneIsAMember(app.db);
  servers = await serve(app);
  const made = await createUser(app.db, {
    username: "ada", email: "ada@forge.test", password: "a-long-flow-lang-passphrase",
    origin: "seed", trusted: true,
  });
  if (!made.ok) throw new Error(made.error);
  userId = made.value.id;
  cookie = `forge_session=${createSession(app.db, userId).token}`;
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const device = (ttlMs?: number) =>
  createFlow(app.db, dir, {
    userId,
    flow: "device",
    app: { kind: "github", apiUrl: "https://api.github.com", webUrl: "https://github.com", clientId: "cid", clientSecret: "" } as never,
    deviceCode: "secret-device-code-xyz",
    userCode: "WDJB-MJHT",
    verificationUri: "https://github.com/login/device",
    target: "https://github.com/login/device",
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });

const get = async (id: string): Promise<string> => {
  const res = await fetch(`${servers.url}/settings/origins/flows/${id}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const text = await res.text();
  return text.slice(text.indexOf("<main"), text.indexOf("</main>"));
};

function plain(page: string): void {
  expect(page.match(/<h1[\s>]/g)?.length).toBe(1);
  expect(page).not.toContain('class="card');
  expect(page).not.toContain("card-body");
  expect(page).not.toContain("secret-device-code-xyz");
}

test("a waiting device grant: the code and where to type it, no card", async () => {
  const page = await get(device().id);
  plain(page);
  expect(page).toContain("WDJB-MJHT");
  expect(page).toMatch(/<a href="https:\/\/github.com\/login\/device" rel="noreferrer noopener"/);
  expect(page).toContain("/poll");
});

test("an expired flow: the notice and the start-again form, no card", async () => {
  const flow = device(-60_000);
  const page = await get(flow.id);
  plain(page);
  expect(page).toContain("This connect link expired");
  expect(page).toContain('action="/settings/origins/oauth"');
  expect(page).not.toContain("WDJB-MJHT");
});
