/** One rule decides `Secure` on every cookie (#6095): https request, https forge, or https app. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { secureFor } from "../src/http/cookie_secure.ts";
import { clearFlashCookie, flashCookie } from "../src/web/flash.ts";
import { cookieHeader } from "../src/http/rp.ts";
import { sessionCookie } from "../src/web/pages/site.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const http = new URL("http://forge.test/x");
const https = new URL("https://forge.test/x");

describe("secureFor", () => {
  test("true for an https request, forge or app; false for none", () => {
    expect(secureFor(https)).toBe(true);
    expect(secureFor(http, "https://forge.test")).toBe(true);
    expect(secureFor(http, "http://forge.test")).toBe(false);
    expect(secureFor(undefined)).toBe(false);
  });

  test("session and flash cookies follow the forge's address, not just the request", () => {
    const at = (forge: string) => [
      sessionCookie("t", new Date(0), http, forge),
      flashCookie({ message: "hi" }, http, forge),
      clearFlashCookie(http, forge),
    ];
    for (const c of at("https://forge.test")) expect(c).toContain("; Secure");
    for (const c of at("http://forge.test")) expect(c).not.toContain("Secure");
  });
});

describe("the visitor cookie on an app host", () => {
  let dir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-secure-"));
    app = createApp({ dataDir: dir, port: 0, host: "forge.test" });
    servers = await serve(app);
    runtime = new AppsRuntime(app, { domain: "apps.test", scheme: "http", publicPort: servers.port, forgeUrl: servers.url, concurrency: 1 });
    await runtime.start();
    const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error(a.error);
    const made = await newApp(app, a.value, { name: "notes", description: "Words", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
  }, 120_000);
  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const visitor = async (forgeUrl: string) => {
    (runtime.options as { forgeUrl: string }).forgeUrl = forgeUrl;
    const host = `notes.apps.test:${servers.port}`;
    const res = await fetch(`${servers.url}/__forge/notes`, { headers: { host } });
    return res.headers.get("set-cookie") ?? "";
  };

  test("Secure when the forge is https, though the request was http", async () => {
    expect(await visitor("https://forge.test")).toContain("; Secure");
  });
  test("not Secure on a plain-http forge", async () => {
    const cookie = await visitor(servers.url);
    expect(cookie).toContain("forge_visitor=");
    expect(cookie).not.toContain("Secure");
  });
});

describe("the parent, theme and mode cookies follow the same rule", () => {
  let dir: string;
  let app: App;
  let servers: Servers;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-secure-rule-"));
    app = createApp({ dataDir: dir, port: 0, host: "forge.test", url: "https://forge.test" });
    servers = await serve(app);
  }, 120_000);
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("the parent sign-in state cookie is Secure on an https forge, though the request was http", () => {
    expect(cookieHeader("s", 600, http, "https://forge.test")).toContain("; Secure");
    expect(cookieHeader("s", 600, http, "http://forge.test")).not.toContain("Secure");
  });
  test("forge_theme is Secure on an https forge, though the request was http", async () => {
    const res = await fetch(`${servers.url}/theme`, {
      method: "POST",
      headers: { origin: "https://forge.test", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ theme: "dark" }),
      redirect: "manual",
    });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("forge_theme=dark");
    expect(cookie).toContain("; Secure");
  });
  test("forge_mode is Secure on an https forge, though the request was http", async () => {
    const res = await fetch(`${servers.url}/?mode=dev`, { redirect: "manual" });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("forge_mode=");
    expect(cookie).toContain("; Secure");
  });
});
