/** The owner's tell on an app's page is a plain field and button, not a boxed card (#10052). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-app-tell-line-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  const r = await newApp(app, made.value, { name: "open", description: "x", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}, 120_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const tellForm = (body: string) => /<form[^>]*action="[^"]*\/tell"[^>]*>/.exec(body)?.[0];

test("a stranger sees no tell form; the owner sees a plain one", async () => {
  const out = await (await fetch(`${servers.url}/alice/open/app`)).text();
  expect(tellForm(out)).toBeUndefined();
  const mine = await (await fetch(`${servers.url}/alice/open/app`, { headers: { cookie } })).text();
  const form = tellForm(mine);
  expect(form).toBeDefined();
  expect(form).not.toMatch(/class="[^"]*\bcard\b/);
  expect(form).toContain("/alice/open/tell");
  const whole = /<form[^>]*action="[^"]*\/tell"[^>]*>[\s\S]*?<\/form>/.exec(mine)![0];
  expect(whole).toMatch(/<input[^>]*name="text"/);
  expect(whole).toMatch(/<button[^>]*>\s*Tell\s*<\/button>|<button[\s\S]*?Tell[\s\S]*?<\/button>/);
  expect(whole).not.toContain("<textarea");
  // No crew: the hint is a muted line with a link, not a long placeholder.
  expect(whole).toContain('placeholder="Tell the crew…"');
  expect(mine).toContain('href="/alice/open/settings#crew"');
});
