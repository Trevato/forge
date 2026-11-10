/**
 * The real /settings/features page and the shell's keys. Each declared feature
 * is a j/k row whose link opens its own settings page; its Absorb / Settings /
 * Accept forms sit beside the link (the row's `after`), not inside it, so they
 * are not rows and Enter never submits one. The settings sections share the
 * same walk, as on every settings page.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { mainOf, shellPage } from "./helpers/shell-page.ts";

quietLogs();

let dir = "";
let app: App;
let servers: Servers;
let html = "";
let detail = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-keys-features-"));
  app = createApp({ dataDir: dir, port: 0, host: "forge.test" });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "ada", email: "ada@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  const repo = await createRepo(app, made.value, { name: "radar", visibility: "private", description: "" });
  if (!repo.ok) throw new Error(String(repo.error));
  const forgeJson = JSON.stringify({ app: { run: "bun run x.ts" }, feature: { name: "Radar", page: "/", settings: {} } });
  await commitToBranch(app, made.value, repo.value, { message: "feature", files: [{ path: "forge.json", content: forgeJson }] });
  insertApp(app.db, { repoId: repo.value.id, slug: "radar", access: "private" });
  const signed = await fetch(`${servers.url}/signin`, {
    method: "POST",
    body: new URLSearchParams({ username: "ada", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  const cookie = (signed.headers.get("set-cookie") ?? "").split(";")[0]!;
  html = mainOf(await (await fetch(`${servers.url}/settings/features`, { headers: { cookie } })).text());
  detail = mainOf(await (await fetch(`${servers.url}/settings/features/radar`, { headers: { cookie } })).text());
}, 60_000);
afterAll(async () => {
  servers?.stop();
  app?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("a feature is one row linking its page; its forms are beside the link, not rows", () => {
  expect(html).toContain("Radar");
  const row = html.slice(html.indexOf('href="/settings/features/radar"') - 3);
  expect(row.slice(0, 2)).toBe("<a");
  expect(row.slice(0, row.indexOf("</a>"))).toContain("data-nav");
  expect(row.slice(0, row.indexOf("</a>"))).not.toContain("<form");
  expect(row).toContain('action="/settings/features/radar/absorb"');
});

test("j/k reach the feature row with the focus marker, Enter opens it, fields keep their keys, `?` helps", async () => {
  const p = await shellPage("/settings/features", html + "<input id=f>");
  const rows = [...p.doc.querySelectorAll("[data-nav]")] as any[];
  const at = rows.findIndex((r) => r.getAttribute("href") === "/settings/features/radar");
  expect(at).toBeGreaterThan(0);
  expect(rows[at].getAttribute("tabindex")).toBe("-1");

  for (let i = 0; i < rows.length && p.doc.activeElement !== rows[at]; i++) p.key("j");
  expect(p.doc.activeElement).toBe(rows[at]);
  p.key("k");
  expect(p.doc.activeElement).toBe(rows[at - 1]);
  p.key("j");
  p.key("Enter");
  expect(p.clicks).toEqual(["/settings/features/radar"]);
  const stored = JSON.parse(p.win.sessionStorage.getItem("nav-from")!);
  expect(stored).toMatchObject({ list: "/settings/features", href: "/settings/features/radar" });

  const f = p.doc.getElementById("f") as any;
  f.focus();
  const before = p.clicks.length;
  p.key("j", f);
  p.key("Enter", f);
  expect(p.doc.activeElement).toBe(f);
  expect(p.clicks.length).toBe(before);

  expect(p.key("?").defaultPrevented).toBe(true);
});

test("Esc on the feature's page: it carries the settings sections, which are rows, so it stays put", async () => {
  const stored = JSON.stringify({ list: "/settings/features", to: "/settings/features/radar", href: "/settings/features/radar" });
  const back = await shellPage("/settings/features/radar", detail, { "nav-from": stored });
  back.key("Escape");
  expect(back.assigned).toEqual([]);
});
