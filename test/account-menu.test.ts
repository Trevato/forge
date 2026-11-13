/** The account menu, by who opens it: three groups a person reads in two seconds, and one row for appearance. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminCookie } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let app: App, servers: Servers, base = "", admin = "", member = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-menu-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  base = servers.url;
  admin = await adminCookie(app, { username: "grace", email: "grace@f.dev" });
  const signup = await fetch(`${base}/signup`, {
    method: "POST",
    body: new URLSearchParams({ username: "ada", email: "ada@f.dev", password: "account-password" }),
    redirect: "manual",
  });
  member = (signup.headers.get("set-cookie") ?? "").split(";")[0]!;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

/** The last menu of the bar, as its rows in order: a label, "---" for a rule, "[Theme]" for the appearance row. */
async function menuRows(path: string, cookie: string): Promise<{ rows: string[]; html: string }> {
  const page = await (await fetch(`${base}${path}`, { headers: { cookie } })).text();
  const bar = page.slice(page.indexOf('<header class="topbar"'), page.indexOf("</header>"));
  const html = bar.slice(bar.lastIndexOf("<details"));
  const rows = [...html.matchAll(/<hr class="menu-sep"|<form class="theme-form menu-row"|class="menu-item[^"]*"[\s\S]*?<span class="grow"\s*>([^<]+)</g)].map((m) =>
    m[0].startsWith("<hr") ? "---" : m[0].startsWith("<form") ? "[Theme]" : m[1]!.trim(),
  );
  return { rows, html };
}

const SESSION = ["---", "[Theme]", "Keyboard shortcuts", "Sign out"];

test("a member's menu: their own pages, Settings, then this browser", async () => {
  const { rows, html } = await menuRows("/", member);
  expect(rows).toEqual(["Your profile", "Repositories", "Apps", "---", "Settings", ...SESSION]);
  // The first row says whose profile; the button names the account for a screen reader.
  expect(html).toContain('<span class="menu-note">ada</span>');
  expect(html).toContain('aria-label="Account: ada"');
});

test("an admin's menu adds People and Forges beside Settings, and nothing else", async () => {
  const { rows } = await menuRows("/", admin);
  expect(rows).toEqual(["Your profile", "Repositories", "Apps", "---", "Settings", "People", "Forges", ...SESSION]);
});

test("a visitor's menu: no account rows, the same one row for appearance, and the way to every theme", async () => {
  const { rows, html } = await menuRows("/explore", "");
  expect(rows).toEqual(["New issue", "Packs", "---", "[Theme]", "All themes", "Keyboard shortcuts"]);
  expect(html).toContain('href="/settings/appearance"');
});

test("the theme control is one row of three buttons, whoever opens the menu", async () => {
  for (const [path, cookie] of [["/", admin], ["/", member], ["/explore", ""]] as const) {
    const { html } = await menuRows(path, cookie);
    const row = html.slice(html.indexOf('<form class="theme-form menu-row"'), html.indexOf("</form>", html.indexOf('<form class="theme-form menu-row"')));
    expect([...row.matchAll(/<button name="theme"[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual(["Auto", "Light", "Dark"]);
    expect(html.match(/action="\/theme"/g)?.length).toBe(1);
    expect(html).not.toContain('type="radio"');
  }
});

test("what left the menu is still one step away: the palette and the settings nav carry it", async () => {
  const home = await (await fetch(`${base}/`, { headers: { cookie: admin } })).text();
  for (const row of ["Notes", "Explore", "Forge packs", "Displays", "Map", "Boards", "System", "Access codes", "Computer keys", "Connected accounts", "Appearance"])
    expect(home, row).toContain(`"t":"${row}"`);
  const settings = await (await fetch(`${base}/settings`, { headers: { cookie: admin } })).text();
  for (const href of ["/settings/appearance", "/settings/tokens", "/settings/keys", "/settings/origins", "/settings/crew"])
    expect(settings, href).toContain(`href="${href}"`);
});
