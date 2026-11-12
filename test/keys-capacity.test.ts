/**
 * The real /settings/capacity page and the shell's keys. Its j/k rows are the
 * settings sections (chrome `settingsLayout`); the setting rows are forms
 * (Save, Dry run, Put back) with nowhere to open, so they are not rows.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { forgeHttp, type ForgeHttp } from "../src/http/server.ts";
import { createSession } from "../src/core/sessions.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { mainOf, shellPage } from "./helpers/shell-page.ts";

quietLogs();

let dir = "";
let app: App;
let http: ForgeHttp;
let html = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-keys-capacity-"));
  app = createApp({ dataDir: dir, port: 0 });
  http = forgeHttp(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const cookie = `forge_session=${createSession(app.db, admin.value.id).token}`;
  const res = await http.handle(new Request("http://forge.test/settings/capacity", { headers: { cookie } }));
  expect(res.status).toBe(200);
  html = mainOf(await res.text());
});
afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("the sections are the only rows; the setting forms are not", () => {
  expect(html).toContain('class="row-fields"');
  const settings = html.slice(html.indexOf('class="list setting-list"'));
  expect(settings).not.toContain("data-nav");
  expect(html).toContain("data-nav");
});

test("j/k walk the sections from the current one, Enter opens, Esc has nowhere to go, fields keep their keys", async () => {
  const p = await shellPage("/settings/capacity", html + "<input id=f>");
  const rows = [...p.doc.querySelectorAll("[data-nav]")] as any[];
  const at = rows.findIndex((r) => r.getAttribute("aria-current") === "page");
  expect(at).toBeGreaterThanOrEqual(0);

  p.key("j");
  expect(p.doc.activeElement).toBe(rows[Math.min(at + 1, rows.length - 1)]);
  const target = p.doc.activeElement.getAttribute("href");
  p.key("k");
  expect(p.doc.activeElement).toBe(rows[at]);
  p.key("j");
  p.key("Enter");
  expect(p.clicks).toEqual([target]);
  expect(JSON.parse(p.win.sessionStorage.getItem("nav-from")!)).toMatchObject({ list: "/settings/capacity", href: target });

  const f = p.doc.getElementById("f") as any;
  f.focus();
  const before = p.clicks.length;
  p.key("j", f);
  p.key("Enter", f);
  expect(p.doc.activeElement).toBe(f);
  expect(p.clicks.length).toBe(before);

  const same = await shellPage("/settings/capacity", html, { "nav-from": JSON.stringify({ list: "/settings/capacity", to: "/settings/capacity", href: target }) });
  same.key("Escape");
  expect(same.assigned).toEqual([]);
});

test("`?` opens the help from this page", async () => {
  const p = await shellPage("/settings/capacity", html);
  expect(p.key("?").defaultPrevented).toBe(true);
});
