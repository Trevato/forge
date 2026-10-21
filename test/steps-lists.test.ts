import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs, withoutEnv } from "./helpers/globals.ts";

/** The numbered how-to lists stay ordered lists, drawn without `.steps` (#4302). */
quietLogs();
withoutEnv("FORGE_GITHUB_CLIENT_ID");

let root = "";
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-steps-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  const made = await createRepo(app, u.value, { name: "forge", visibility: "public", description: "x" });
  if (!made.ok) throw new Error(String(made.error));
  proveAll(app);
  servers = await serve(app);
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

async function get(path: string): Promise<string> {
  const res = await fetch(`${servers.url}${path}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return res.text();
}

function expectPlainList(body: string, lists: number, minItems: number): void {
  expect(body).not.toMatch(/class="[^"]*\bsteps\b/);
  expect(body.match(/<ol[ >]/g)?.length).toBe(lists);
  expect(body.match(/<li>/g)?.length ?? 0).toBeGreaterThanOrEqual(minItems);
}

test("settings: the Instagram steps are an ordered list without .steps", async () => {
  const body = await get("/alice/forge/settings/prompts");
  expectPlainList(body, 1, 4);
  expect(body).toContain("Business Login for Instagram");
});

test("origins: the GitHub setup steps are an ordered list without .steps", async () => {
  const body = await get("/settings/origins");
  expectPlainList(body, 1, 3);
  expect(body).toContain("github.com/settings/developers");
});

test("origins: the Forgejo registration steps are an ordered list without .steps", async () => {
  const body = await get("/settings/origins?host=codeberg.org&register=1");
  expect(body).toContain("/user/settings/applications");
  expect(body).not.toMatch(/class="[^"]*\bsteps\b/);
  expect(body).toMatch(/<ol class="muted small">\s*<li>\s*Open/);
});
