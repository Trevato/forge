/**
 * The real /settings/telemetry page and the shell's keys. Its j/k rows are the
 * settings sections (chrome `settingsLayout`); an agent's grant row holds only a
 * form (Grant/Revoke) and a read row is a log line, so neither has anywhere to open.
 * Telemetry is a tab of the Usage section, so the current row is Usage (/settings/spend).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
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
  dir = await mkdtemp(join(tmpdir(), "forge-keys-telemetry-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const cookie = await adminCookie(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  app.db.query("INSERT INTO user (id, username, email, is_agent, password_hash) VALUES ('ag1', 'scout', 'scout@agents.invalid', 1, '')").run();
  const res = await fetch(`${servers.url}/settings/telemetry`, { headers: { cookie } });
  html = mainOf(await res.text());
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("the page draws the agent's grant form; the sections are the only rows", () => {
  expect(html).toContain("scout");
  expect(html).toContain('action="/settings/telemetry"');
  const grants = html.slice(html.indexOf('class="list setting-list"'));
  expect(grants).not.toContain("data-nav");
  expect(html).toContain("data-nav");
});

test("j/k walk the sections from the current one, Enter opens, Esc leaves nothing behind, fields keep their keys", async () => {
  const p = await shellPage("/settings/telemetry", html + "<input id=f>");
  const rows = [...p.doc.querySelectorAll("[data-nav]")] as any[];
  const at = rows.findIndex((r) => r.getAttribute("aria-current") === "page");
  expect(at).toBeGreaterThanOrEqual(0);
  expect(rows[at].getAttribute("href")).toBe("/settings/spend"); // the Usage section holds the Telemetry tab

  p.key("j");
  expect(p.doc.activeElement).toBe(rows[Math.min(at + 1, rows.length - 1)]);
  const target = p.doc.activeElement.getAttribute("href");
  p.key("k");
  expect(p.doc.activeElement).toBe(rows[Math.max(at, 0)]);
  p.key("j");
  p.key("Enter");
  expect(p.clicks).toEqual([target]);
  expect(JSON.parse(p.win.sessionStorage.getItem("nav-from")!)).toMatchObject({ list: "/settings/telemetry", href: target });

  const f = p.doc.getElementById("f") as any;
  f.focus();
  const before = p.clicks.length;
  p.key("j", f);
  p.key("Enter", f);
  expect(p.doc.activeElement).toBe(f);
  expect(p.clicks.length).toBe(before);

  const same = await shellPage("/settings/telemetry", html, { "nav-from": JSON.stringify({ list: "/settings/telemetry", to: "/settings/telemetry", href: target }) });
  same.key("Escape");
  expect(same.assigned).toEqual([]);
});

test("`?` opens the help from this page", async () => {
  const p = await shellPage("/settings/telemetry", html);
  expect(p.key("?").defaultPrevented).toBe(true);
});
