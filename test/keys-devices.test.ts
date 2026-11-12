/**
 * The real /settings/devices page and the shell's keys. Its j/k rows are the
 * settings sections (chrome `settingsLayout`); a declared printer's card holds
 * only forms (Remove, Grant, Set limit), has nowhere to open, so it is not a row.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { declareDevice } from "../src/core/devices.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminCookie } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { mainOf, shellPage } from "./helpers/shell-page.ts";

quietLogs();

let dir = "";
let app: App;
let servers: Servers;
let html = "";
const priorLoopback = process.env.FORGE_DEVICES_ALLOW_LOOPBACK;

beforeAll(async () => {
  process.env.FORGE_DEVICES_ALLOW_LOOPBACK = "1";
  dir = await mkdtemp(join(tmpdir(), "forge-keys-devices-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const cookie = await adminCookie(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
  const url = `ipp://127.0.0.1:${dead.port}/ipp/print`;
  dead.stop(true);
  const made = declareDevice(app.db, { name: "Hall printer", kind: "printer", url });
  if (!made.ok) throw new Error(made.error);
  const res = await fetch(`${servers.url}/settings/devices`, { headers: { cookie } });
  html = mainOf(await res.text());
});
afterAll(async () => {
  if (priorLoopback === undefined) delete process.env.FORGE_DEVICES_ALLOW_LOOPBACK;
  else process.env.FORGE_DEVICES_ALLOW_LOOPBACK = priorLoopback;
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("the page draws its device and the sections are the only rows; the card is not a row", () => {
  expect(html).toContain("Hall printer");
  const card = html.slice(html.indexOf('class="list setting-list"'));
  expect(card).not.toContain("data-nav");
  expect(html).toContain("data-nav");
});

test("j/k walk the sections from the current one, Enter opens, Esc leaves nothing behind, fields keep their keys", async () => {
  const p = await shellPage("/settings/devices", html + "<input id=f>");
  const rows = [...p.doc.querySelectorAll("[data-nav]")] as any[];
  const at = rows.findIndex((r) => r.getAttribute("aria-current") === "page");
  expect(at).toBeGreaterThanOrEqual(0);
  expect(rows[at].getAttribute("href")).toBe("/settings/devices");

  // Nothing focused: j steps away from the row the page is on.
  p.key("j");
  expect(p.doc.activeElement).toBe(rows[Math.min(at + 1, rows.length - 1)]);
  const target = p.doc.activeElement.getAttribute("href");
  p.key("k");
  expect(p.doc.activeElement).toBe(rows[Math.max(at, 0)]);
  p.key("j");
  p.key("Enter");
  expect(p.clicks).toEqual([target]);
  expect(JSON.parse(p.win.sessionStorage.getItem("nav-from")!)).toMatchObject({ list: "/settings/devices", href: target });

  // In a field no key moves or opens.
  const f = p.doc.getElementById("f") as any;
  f.focus();
  const before = p.clicks.length;
  p.key("j", f);
  p.key("Enter", f);
  expect(p.doc.activeElement).toBe(f);
  expect(p.clicks.length).toBe(before);

  // The page that carries the sections is itself a list: Esc has nowhere to return to.
  const same = await shellPage("/settings/devices", html, { "nav-from": JSON.stringify({ list: "/settings/devices", to: "/settings/devices", href: target }) });
  same.key("Escape");
  expect(same.assigned).toEqual([]);
});

test("`?` opens the help from this page", async () => {
  const p = await shellPage("/settings/devices", html);
  const e = p.key("?");
  expect(e.defaultPrevented).toBe(true);
});
