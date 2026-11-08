/**
 * Settings › Capacity works with JavaScript off (#9725): no script carries
 * its function, and every change on it is a plain POST form that the server
 * holds to a same-origin check.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App, servers: Servers, bearer = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-capnojs-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "alice", password: "correct-horse-battery", name: "cli", scope: "admin" }),
  });
  bearer = ((await minted.json()) as { token: string }).token;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const page = async () => {
  const res = await fetch(`${servers.url}/settings/capacity`, { headers: { authorization: `Bearer ${bearer}` } });
  expect(res.status).toBe(200);
  return res.text();
};

/**
 * The page's own content: from `.settings-main` to the end of <main>. The
 * shared settings nav before it (its `js-only` filter) is chrome, held by
 * its own tests; this page must not lean on it.
 */
const main = (html: string) => /<div class="settings-main"[\s\S]*<\/main>/.exec(html)?.[0] ?? "";

test("the page's content carries no script and no inline handler", async () => {
  const body = main(await page());
  expect(body).not.toBe("");
  expect(body).not.toMatch(/<script\b/i);
  expect(body).not.toMatch(/\son[a-z]+\s*=/i);
  expect(body).not.toMatch(/javascript:/i);
});

test("every change is a plain POST form to /settings/capacity, crew size and CPUs among them; self-swap is read, not changed", async () => {
  const body = main(await page());
  const forms = [...body.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)];
  expect(forms.length).toBeGreaterThan(0);
  for (const [, attrs] of forms) {
    expect(attrs).toMatch(/method="post"/);
    expect(attrs).toMatch(/action="\/settings\/capacity"/);
  }
  const keys = forms.map(([, , inner]) => /name="key" value="([^"]+)"/.exec(inner!)?.[1]);
  // Crew size, and the two settings sized from the pod's CPUs.
  expect(keys).toEqual(expect.arrayContaining(["crew.concurrency", "checks.concurrency", "checks.shards"]));
  // Nothing outside a form asks to be pressed: a button out of a form needs a script.
  const outside = body.replace(/<form\b[\s\S]*?<\/form>/g, "");
  expect(outside).not.toMatch(/<(button|input|select|textarea)\b/);
  expect(outside).toContain('id="self-swap"');
});

test("a change from another origin is refused and changes nothing", async () => {
  const before = await page();
  const form = /<form\b[^>]*>([\s\S]*?)<\/form>/.exec(main(before))![1]!;
  const key = /name="key" value="([^"]+)"/.exec(form)![1]!;
  const res = await fetch(`${servers.url}/settings/capacity`, {
    method: "POST",
    redirect: "manual",
    headers: { authorization: `Bearer ${bearer}`, origin: "https://elsewhere.example", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ key, reset: "1" }),
  });
  expect(res.status).toBe(403);
  expect(main(await page())).not.toContain("→");
});

test("the same change from this origin lands, with no script involved", async () => {
  const form = /<form\b[^>]*>([\s\S]*?)<\/form>/.exec(main(await page()))![1]!;
  const key = /name="key" value="([^"]+)"/.exec(form)![1]!;
  const value = /<input[^>]*type="number"[^>]*min="(\d+)"/.exec(form)?.[1];
  const res = await fetch(`${servers.url}/settings/capacity`, {
    method: "POST",
    redirect: "manual",
    headers: { authorization: `Bearer ${bearer}`, origin: servers.url, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ key, value: value ?? "" }),
  });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toContain("/settings/capacity");
});
