/**
 * The toolbar every app and preview carries costs almost nothing (#11378):
 * its script stays under a byte budget, its host is fixed so nothing is
 * inserted above the page's content, and the script and its tag carry nothing
 * a strict CSP would block.
 */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { TOOLBAR_ASSET_PATH, TOOLBAR_PATH, toolbarJs, toolbarTag } from "../src/apps/toolbar.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

/** The one budget (it loads on every app page): 24 KB, the script keeping the filed number and links of #10560. Raising it is a decision, not a fix. */
export const TOOLBAR_BYTE_BUDGET = 24 * 1024;

test("the toolbar script stays under its byte budget", () => {
  expect(Buffer.byteLength(toolbarJs)).toBeLessThan(TOOLBAR_BYTE_BUDGET);
});

test("the toolbar tag is one small deferred script", () => {
  const tag = toolbarTag("https://forge.test", { app: "notes", repo: "a/b", env: "preview", pull: 7 }, "proof", "n0nce");
  expect(Buffer.byteLength(tag)).toBeLessThan(600);
  expect(tag).toContain(`src="${TOOLBAR_ASSET_PATH}"`);
  expect(tag).toContain(" defer");
});

test("source check: the toolbar host is fixed, so it has no in-flow size, and nothing is inserted above content", () => {
  expect(toolbarJs).toContain('host.style.cssText = "all:initial;position:fixed;z-index:2147483647"');
  // It is appended to the end of the page, never placed before existing content.
  expect(toolbarJs).not.toMatch(/insertBefore|prepend\(|\.before\(|insertAdjacentElement\(\s*["']before/i);
  expect(toolbarJs).not.toMatch(/firstChild|firstElementChild/);
  expect(toolbarJs).toMatch(/\.append(Child)?\(host\)/);
});

test("nothing in the script or its tag is blocked by a strict CSP", () => {
  const tag = toolbarTag("https://forge.test", { app: "notes", repo: "a/b", env: "preview", title: `"><img onerror=x>` }, undefined, "n");
  const names = [...tag.matchAll(/\s([a-z-]+)(?==")/g)].map((m) => m[1]!);
  for (const n of names) expect(n === "src" || n === "nonce" || n.startsWith("data-")).toBe(true);
  expect(tag).not.toContain("<img");
  for (const banned of [/\beval\(/, /new Function/, /\.onclick\s*=\s*["']/, /setAttribute\(\s*["']on/i, /<style/i, /\sstyle="/i, /javascript:/i])
    expect(toolbarJs).not.toMatch(banned);
});

const DOMAIN = "apps.test";
let dataDir: string;
let app: App;
let servers: Servers;
let runtime: AppsRuntime;
let backend: ReturnType<typeof Bun.serve>;
let status: ReturnType<typeof spyOn>;

beforeAll(async () => {
  backend = Bun.serve({ port: 0, fetch: () => new Response("the app") });
  dataDir = await mkdtemp(join(tmpdir(), "forge-toolbar-budget-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  servers = await serve(app);
  runtime = new AppsRuntime(app, { domain: DOMAIN, scheme: "http", publicPort: servers.port, forgeUrl: servers.url, concurrency: 1 });
  await runtime.start();
  status = spyOn(AppsRuntime.prototype, "envStatus").mockImplementation(
    () => ({ env: "production", state: "running", port: backend.port, commitOid: "a".repeat(40) }) as EnvStatus,
  );
  const a = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  const made = await newApp(app, a.value, { name: "notes", description: "A place for words", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
}, 120_000);

afterAll(async () => {
  status.mockRestore();
  await runtime.stop();
  servers.stop();
  backend.stop(true);
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the forge's route and the app host's route both serve the script immutable with the security floor", async () => {
  const forge = await fetch(`${servers.url}${TOOLBAR_PATH}`, { redirect: "manual" });
  const own = await fetch(`${servers.url}${TOOLBAR_ASSET_PATH}`, { headers: { host: `notes.${DOMAIN}` }, redirect: "manual" });
  for (const res of [forge, own]) {
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(toolbarJs);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBeTruthy();
    expect(res.headers.get("content-security-policy")).toBeTruthy();
  }
});
