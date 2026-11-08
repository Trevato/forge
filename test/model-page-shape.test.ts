/** /settings/model is a heading over rows: a settings block, no `.card`. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { setAccountGrant } from "../src/actions/model_grant.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASS = "a-good-passphrase";
let root = "";
let app: App;
let servers: Servers;

const signIn = async (username: string) => {
  const r = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username, password: PASS }),
    redirect: "manual",
  });
  return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
};
const get = async (cookie: string) =>
  (await fetch(`${servers.url}/settings/model`, { headers: { cookie } })).text();
const noCard = (body: string) => expect(body).not.toMatch(/class="(?:[^"]*\s)?card(?:\s[^"]*)?"/);
const heading = /<section class="settings-block"[^>]*>\s*<h2>Your model budget<\/h2>/;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-model-shape-"));
  app = createApp({ dataDir: root, port: 0 });
  for (const [username, isAdmin] of [["alice", true], ["bob", false], ["carol", false]] as const) {
    const u = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@x.test`, password: PASS, isAdmin,
    });
    if (!u.ok) throw new Error(u.error);
  }
  servers = await serve(app);
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("a new account sees a heading, one sentence and the token form, no card", async () => {
  const body = await get(await signIn("bob"));
  expect(body).toMatch(heading);
  noCard(body);
  expect(body).toContain("Model budget: $0. Add your own subscription, or ask an admin for a grant.");
  expect(body).not.toContain('class="row');
  expect(body).toContain('name="token"');
});

test("an account with a grant sees it as one row, no card", async () => {
  const admin = getUserByName(app.db, "alice")!;
  expect(setAccountGrant(app, admin, "carol", 20).ok).toBe(true);
  const body = await get(await signIn("carol"));
  expect(body).toMatch(heading);
  noCard(body);
  expect(body.match(/class="row"/g)?.length).toBe(1);
  expect(body).toContain("a grant of $20.00 a month, $20.00 left");
});
