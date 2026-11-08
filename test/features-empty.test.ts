/** Settings › Features with no declaring app: the empty state links the guide. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir = "";
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-features-empty-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "ada",
    email: "ada@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
}, 60_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test("with no feature declared, the empty state carries the guide's link", async () => {
  const signed = await fetch(`${servers.url}/signin`, {
    method: "POST",
    body: new URLSearchParams({ username: "ada", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  const cookie = `${(signed.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=dev`;
  const page = await (await fetch(`${servers.url}/settings/features`, { headers: { cookie } })).text();
  expect(page).toContain("No app declares a feature yet");
  const empty = page.slice(page.indexOf("No app declares a feature yet"));
  expect(empty.slice(0, empty.indexOf("</div>"))).toContain('href="/trevato/forge/blob/main/docs/features/absorb.md"');
});
