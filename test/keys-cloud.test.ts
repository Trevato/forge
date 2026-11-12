/**
 * The real /settings/cloud page and the shell's keys. Its j/k rows are the
 * account-settings sections (chrome `settingsLayout`); an account row holds only
 * forms (Verify, Rotate, Rename, Remove) and a read row is a log line, so neither
 * has anywhere to open. Cloud is its own section, so the current row is /settings/cloud.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { listCloudAccounts } from "../src/core/cloud_account.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminCookie } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { mainOf, shellPage } from "./helpers/shell-page.ts";

quietLogs();

let dir = "";
let app: App;
let servers: Servers;
let html = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-keys-cloud-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const cookie = await adminCookie(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  listCloudAccounts(app.db); // creates the table
  app.db.query("INSERT INTO cloud_account (provider, name, summary, verified_at, write_allowed) VALUES ('cloudflare', 'main', 'ok', NULL, 0)").run();
  const res = await fetch(`${servers.url}/settings/cloud`, { headers: { cookie } });
  html = mainOf(await res.text());
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("the page draws the account's forms; the sections are the only rows", () => {
  expect(html).toContain('action="/settings/cloud/verify"');
  const accounts = html.slice(html.indexOf('class="list setting-list"'));
  expect(accounts).not.toContain("data-nav");
  expect(html).toContain("data-nav");
});

test("j/k walk the sections from the current one, Enter opens, Esc leaves nothing behind, fields keep their keys", async () => {
  const p = await shellPage("/settings/cloud", html + "<input id=f>");
  const rows = [...p.doc.querySelectorAll("[data-nav]")] as any[];
  const at = rows.findIndex((r) => r.getAttribute("aria-current") === "page");
  expect(at).toBeGreaterThanOrEqual(0);
  expect(rows[at].getAttribute("href")).toBe("/settings/cloud");

  p.key("j");
  expect(p.doc.activeElement).toBe(rows[Math.min(at + 1, rows.length - 1)]);
  const target = p.doc.activeElement.getAttribute("href");
  p.key("k");
  expect(p.doc.activeElement).toBe(rows[Math.max(at, 0)]);
  p.key("j");
  p.key("Enter");
  expect(p.clicks).toEqual([target]);
  expect(JSON.parse(p.win.sessionStorage.getItem("nav-from")!)).toMatchObject({ list: "/settings/cloud", href: target });

  const f = p.doc.getElementById("f") as any;
  f.focus();
  const before = p.clicks.length;
  p.key("j", f);
  p.key("Enter", f);
  expect(p.doc.activeElement).toBe(f);
  expect(p.clicks.length).toBe(before);

  const same = await shellPage("/settings/cloud", html, { "nav-from": JSON.stringify({ list: "/settings/cloud", to: "/settings/cloud", href: target }) });
  same.key("Escape");
  expect(same.assigned).toEqual([]);
});

test("`?` opens the help from this page", async () => {
  const p = await shellPage("/settings/cloud", html);
  expect(p.key("?").defaultPrevented).toBe(true);
});
