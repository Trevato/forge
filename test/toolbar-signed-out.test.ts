/** A signed-out reader of the toolbar page is offered sign-in that returns to it (#4090). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { safeNext } from "../src/web/pages/site.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let owner: never;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-toolbar-out-"));
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
  proveAll(app);
  owner = { id: u.value.id, username: "alice" } as never;
  const made = await newApp(app, owner, { name: "forge", description: "x", visibility: "public" });
  if (!made.ok) throw new Error(made.error);
  servers = await serve(app);
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("signed out, the page offers sign-in that returns to it", async () => {
  const res = await fetch(`${servers.url}/alice/forge/toolbar?env=production&page=${encodeURIComponent("https://x.test/a")}`);
  expect(res.status).toBe(200);
  const body = await res.text();
  const next = encodeURIComponent(`/alice/forge/toolbar?env=production&page=${encodeURIComponent("https://x.test/a")}`);
  expect(body).toContain("Sign in to comment");
  expect(body).toContain(`href="/signin?next=${next}"`);
  expect(body).toContain(">Home<");
  expect(safeNext(decodeURIComponent(next))).toBe(decodeURIComponent(next));
});

test("signed out, a public app's toolbar offers the anonymous report, carrying the page", async () => {
  const addr = "https://x.test/a";
  const res = await fetch(`${servers.url}/alice/forge/toolbar?env=production&page=${encodeURIComponent(addr + "?t=secret")}`);
  const body = await res.text();
  const href = `/alice/forge/report?from=${encodeURIComponent(addr)}`;
  expect(body).toContain(`href="${href}"`);
  expect(body).toContain("no account needed");
  expect(body).not.toContain("secret");
  const form = await (await fetch(servers.url + href)).text();
  expect(form).toContain("About this page: https://x.test/a");
  const evil = await (await fetch(`${servers.url}/alice/forge/report?from=${encodeURIComponent("javascript:alert(1)")}`)).text();
  expect(evil).not.toContain("About this page");
});

test("a private app's toolbar offers no report link to a guest", async () => {
  const made = await newApp(app, owner, { name: "hush", description: "x", visibility: "private" });
  if (!made.ok) throw new Error(made.error);
  const res = await fetch(`${servers.url}/alice/hush/toolbar?env=production`);
  expect(res.status).toBe(404);
  expect(await res.text()).not.toContain("/alice/hush/report");
});

test("a crafted next to another host is refused", () => {
  expect(safeNext("//evil.example/x")).toBeUndefined();
  expect(safeNext("https://evil.example/")).toBeUndefined();
  expect(safeNext("/\\evil.example")).toBeUndefined();
});
