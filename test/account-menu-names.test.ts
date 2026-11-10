/** A person who taps an account-menu label meets the same words on the page it opens: label, title, heading, empty line, palette. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir = "";
let app: App, servers: Servers, base = "", cookie = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-menunames-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  base = servers.url;
  const signup = await fetch(`${base}/signup`, {
    method: "POST",
    body: new URLSearchParams({ username: "ada", email: "ada@f.dev", password: "account-password" }),
    redirect: "manual",
  });
  cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0]!;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const PAGES: { name: string; path: string; empty: string }[] = [
  { name: "SSH keys", path: "/settings/keys", empty: "No SSH keys yet" },
  { name: "Access tokens", path: "/settings/tokens", empty: "No access tokens yet" },
  { name: "Origins", path: "/settings/origins", empty: "No origins yet" },
];

for (const { name, path, empty } of PAGES) {
  test(`${name}: menu, nav, palette, title, heading and empty line use one name`, async () => {
    const res = await fetch(`${base}${path}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`<title>${name}`);
    expect(body).toContain(`<h1>${name}</h1>`);
    expect(body).toContain(empty);
    // The user menu and the settings nav link to this page under this label.
    expect(body).toMatch(new RegExp(`href="${path}"[^>]*>(?:<[^>]+>)*\\s*${name}\\s*<`));
    // The palette entry carries the same words.
    expect(body).toContain(`"t":"${name}"`);
  });
}

test("access tokens: help term, field label and button say access token", async () => {
  const body = await (await fetch(`${base}/settings/tokens`, { headers: { cookie } })).text();
  expect(body).toContain("Access token name");
  expect(body).not.toContain("Token name");
  expect(body).toContain("Generate access token");
});

test("origins: the section heading reads Origins, not Connected origins", async () => {
  const body = await (await fetch(`${base}/settings/origins`, { headers: { cookie } })).text();
  expect(body).toContain("<h2>Origins</h2>");
  expect(body).not.toContain("Connected origins");
});

// The terminal is the other door: drive the real screens and read what they draw.
function boot() {
  const terminal = headlessTerminal(140, 32);
  const identity = { sshUsername: "t", remoteAddress: "127.0.0.1", user: getUserByName(app.db, "ada")! } as TuiIdentity;
  const { app: tui } = createForgeApp(app, identity, { terminal, exitHooks: false });
  tui.start();
  const key = (k: string, ctrl = false) => tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
  return {
    text: () => tui.screen.toText(),
    keys: async (...ks: string[]) => {
      ks.forEach((k) => key(k));
      await settleApp(tui);
    },
    palette: async (words: string) => {
      key("k", true);
      for (const ch of words) key(ch);
      key("enter");
      await settleApp(tui);
    },
    stop: () => tui.stop(),
  };
}

test("terminal: Signed in makes an access token on screens titled access token", async () => {
  const h = boot();
  try {
    await h.palette("Signed in");
    expect(h.text()).toContain("m makes an access token");
    await h.keys("m");
    expect(h.text()).toContain(" Make an access token ");
    await h.keys("enter"); // the name: "token"
    expect(h.text()).toContain(" Make an access token ");
    await h.keys("enter"); // the scope: ro
    expect(h.text()).toMatch(/^ada › Signed in › New access token$/m);
    expect(h.text()).not.toMatch(/ (New|Make a) token /);
  } finally {
    h.stop();
  }
});

test("terminal: the origins screen is titled Origins, as the page is", async () => {
  const h = boot();
  try {
    await h.palette("Origins");
    expect(h.text()).toMatch(/^ada › Origins$/m);
    expect(h.text()).not.toContain("Connected origins");
  } finally {
    h.stop();
  }
});
