/** Settings › Account is rows under headings, not cards, and its tokens and keys are lists (#9706). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { getUserByName } from "../src/core/users.ts";
import { createToken } from "../src/core/tokens.ts";
import { sessionsCard } from "../src/web/pages/account.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let app: App, servers: Servers, base = "", cookie = "";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl laptop";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-acctrows-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  base = servers.url;
  const signup = await fetch(`${base}/signup`, {
    method: "POST",
    body: new URLSearchParams({ username: "ada", email: "ada@f.dev", password: "account-password" }),
    redirect: "manual",
  });
  cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0]!;
  const user = getUserByName(app.db, "ada")!;
  createToken(app.db, user.id, "laptop", "rw");
  await fetch(`${base}/settings/keys`, {
    method: "POST",
    headers: { cookie, origin: base },
    body: new URLSearchParams({ name: "work", key: KEY }),
    redirect: "manual",
  });
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const main = async (path: string): Promise<string> => {
  const res = await fetch(`${base}${path}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = await res.text();
  return body.slice(body.indexOf('class="settings-main"'));
};

test("no account page is a card or holds a table", async () => {
  for (const path of ["/settings", "/settings/password", "/settings/tokens", "/settings/keys"]) {
    const m = await main(path);
    expect(m).not.toMatch(/class="card[\s"]/);
    expect(m).not.toContain("card-head");
    expect(m).not.toContain("<table");
  }
});

test("tokens are rows under a Tokens heading, each with Revoke", async () => {
  const m = await main("/settings/tokens");
  expect(m).toContain('<section class="settings-block">');
  const list = m.slice(m.indexOf("<h2>Tokens</h2>"));
  expect(list).toMatch(/^<h2>Tokens<\/h2>\s*<ul class="list setting-list">/);
  const item = list.slice(0, list.indexOf("</ul>"));
  expect(item).toContain("<strong>laptop</strong>");
  expect(item).toMatch(/settings%2Ftokens%2F[^"]+%2Fdelete/);
  expect(m).toContain('action="/settings/tokens"');
});

test("keys are rows under an SSH keys heading, each with its Remove link", async () => {
  const m = await main("/settings/keys");
  const list = m.slice(m.indexOf("<h2>SSH keys</h2>"));
  expect(list).toMatch(/^<h2>SSH keys<\/h2>\s*<ul class="list setting-list">/);
  const item = list.slice(0, list.indexOf("</ul>"));
  expect(item).toContain("<strong>work</strong>");
  expect(item).toMatch(/settings%2Fkeys%2F[^"]+%2Fdelete/);
  expect(m).toContain('action="/settings/keys"');
});

test("empty lists are one muted sentence, not a panel", async () => {
  const other = await fetch(`${base}/signup`, {
    method: "POST",
    body: new URLSearchParams({ username: "bob", email: "bob@f.dev", password: "account-password" }),
    redirect: "manual",
  });
  const c = (other.headers.get("set-cookie") ?? "").split(";")[0]!;
  const get = async (path: string) => (await (await fetch(`${base}${path}`, { headers: { cookie: c } })).text());
  const tokens = await get("/settings/tokens");
  expect(tokens).toContain('<p class="muted">No tokens yet.');
  expect(tokens).not.toContain("empty-title");
  const keys = await get("/settings/keys");
  expect(keys).toContain('<p class="muted">No keys yet.');
  expect(keys).not.toContain("empty-title");
  const card = String(sessionsCard([], "/settings"));
  expect(card).toContain('<p class="muted">Not signed in on any browser.</p>');
  expect(card).not.toContain("<ul");
});

test("an OAuth-issued token names its client inside its row", async () => {
  const user = getUserByName(app.db, "ada")!;
  const { id } = createToken(app.db, user.id, "claude", "rw");
  app.db.query("INSERT INTO oauth_client (id, name, redirect_uris, created_at) VALUES ('c1', 'Claude Code', '[]', ?1)").run(new Date().toISOString());
  app.db.query("INSERT INTO oauth_token (token_id, client_id) VALUES (?1, 'c1')").run(id);
  const m = await main("/settings/tokens");
  const list = m.slice(m.indexOf('<ul class="list setting-list">'));
  const item = list.slice(0, list.indexOf("</ul>"));
  const li = item.split("<li").find((x) => x.includes("<strong>claude</strong>"))!;
  expect(li).toContain("data-oauth-client");
  expect(li).toContain("Claude Code");
  expect(li).toContain("renews itself");
});
