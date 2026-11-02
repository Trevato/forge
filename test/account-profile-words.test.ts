/**
 * Settings › Account refuses a profile in the words the terminal shares
 * (#8001): the web page and `PROFILE_REFUSALS` cannot drift apart.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { PROFILE_REFUSALS } from "../src/actions/profile_words.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminCookie } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-profile-words-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  cookie = await adminCookie(app, { username: "alice", email: "alice@forge.local" });
});
afterAll(async () => {
  await servers.stop?.();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const post = (fields: Record<string, string>) =>
  fetch(`${servers.url}/settings`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, origin: servers.url, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });

const escaped = (s: string) => s.replace(/'/g, "&#39;").replace(/&/g, "&amp;");

test("the account page refuses in the shared words, in the field they belong to", async () => {
  const reserved = await post({ displayName: "forge", email: "alice@forge.local" });
  expect(reserved.status).toBe(422);
  expect(await reserved.text()).toContain(escaped(PROFILE_REFUSALS.display_name_reserved!).replace(/&amp;#39;/g, "&#39;"));
  const bad = await post({ displayName: "Alice", email: "nope" });
  expect(bad.status).toBe(422);
  expect(await bad.text()).toContain(PROFILE_REFUSALS.invalid_email!.replace(/'/g, "&#39;"));
});
