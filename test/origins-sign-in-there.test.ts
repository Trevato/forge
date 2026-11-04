/** "Or sign in there" uses the address typed beside it, and an empty one says so. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { isAuthorizePath } from "../src/web/pages/origin-flow.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";
const before = process.env.FORGE_URL;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-sign-in-there-"));
  process.env.FORGE_URL = "https://forge.example.test";
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase" });
  if (!u.ok) throw new Error(String(u.error));
  cookie = `forge_session=${createSession(app.db, u.value.id).token}`;
});

afterAll(async () => {
  if (before === undefined) delete process.env.FORGE_URL;
  else process.env.FORGE_URL = before;
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the button submits the form holding the typed address, skipping the token it doesn't need", async () => {
  const page = await (await fetch(`${servers.url}/settings/origins`, { headers: { cookie } })).text();
  const form = /<form method="post" action="\/settings\/origins\/token">[\s\S]*?<\/form>/.exec(page)?.[0] ?? "";
  expect(form).toContain('name="host"');
  expect(form).toMatch(/formnovalidate\s+formaction="\/settings\/origins\/oauth"/);
  expect(form).toContain("Or sign in there");
});

test("with no address it asks for one, rather than saying it isn't a forge", async () => {
  const res = await fetch(`${servers.url}/settings/origins/oauth`, {
    method: "POST",
    headers: { cookie, origin: servers.url, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ host: "", token: "" }),
  });
  const body = await res.text();
  expect(res.status).toBe(422);
  expect(body).toContain("Type the forge&#39;s address first");
  expect(body).not.toContain("does not look like a forge");
});

test("the link to sign in is kept for Forgejo's path and another forge's, and no other", () => {
  expect(isAuthorizePath("/login/oauth/authorize", "/")).toBe(true);
  expect(isAuthorizePath("/oauth/authorize", "/")).toBe(true);
  expect(isAuthorizePath("/git/oauth/authorize", "/git/")).toBe(true);
  expect(isAuthorizePath("/oauth/authorize/../evil", "/")).toBe(false);
  expect(isAuthorizePath("/evil", "/")).toBe(false);
});
