/** Settings › Flags speaks the home page's language (#9872): a settings block and a plain list; no card. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { makeFlags } from "../src/core/flags.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { useFlagRegistry } from "../src/web/pages/flags.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;

const page = async (): Promise<string> => {
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
  });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const got = await fetch(`${servers.url}/settings/flags`, { headers: { cookie } });
  expect(got.status).toBe(200);
  return got.text();
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-flags-lang-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.test",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
});

afterAll(async () => {
  useFlagRegistry(undefined);
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("declared flags are a settings block with a plain list, no card", async () => {
  useFlagRegistry(makeFlags({ alpha: { why: "shows the new board", default: false, issue: 9872 } }));
  const body = await page();
  expect(body).not.toContain('class="card');
  expect(body).toContain('<section class="settings-block">');
  expect(body).toContain("<h2>Flags</h2>");
  expect(body).toContain("setting-list");
  expect(body).toContain("Save alpha");
});

test("no flag declared is one plain sentence, no card", async () => {
  useFlagRegistry(makeFlags({}));
  const body = await page();
  expect(body).not.toContain('class="card');
  expect(body).toContain("No flag is declared yet.");
});
