/** The anonymous header's "Sign up" on the top forge, and /agents pointing people home. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { setCapacity } from "../src/core/capacity.ts";
import { setSignup } from "../src/settings/signup.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-header-signup-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});
afterAll(async () => {
  await servers.stop?.();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const header = async (path: string): Promise<string> => {
  const page = await (await fetch(`${servers.url}${path}`)).text();
  return page.slice(page.indexOf('<header class="topbar"'), page.indexOf("</header>"));
};
const signUpLink = (head: string) => head.match(/<a\s[^>]*href="([^"]*)"[^>]*>Sign up<\/a/)?.[1];

test("signup open: the header's Sign up leads to /signup", async () => {
  setSignup(app.db, "open", "test");
  expect(signUpLink(await header("/explore"))).toBe("/signup");
});

test("signup closed: the header's Sign up leads to the home page's form", async () => {
  setSignup(app.db, "closed", "test");
  expect(signUpLink(await header("/explore"))).toBe("/");
});

test("request opens /signup, invite and closed lead home", async () => {
  for (const [mode, href] of [["request", "/signup"], ["invite", "/"], ["closed", "/"], ["open", "/signup"]] as const) {
    setSignup(app.db, mode, "test");
    expect(signUpLink(await header("/explore"))).toBe(href);
  }
});

test("a forge with a parent offers no Sign up", async () => {
  setSignup(app.db, "open", "test");
  const dir = await mkdtemp(join(tmpdir(), "forge-header-parent-"));
  const child = createApp({ dataDir: dir, port: 0, parentUrl: "https://parent.example" });
  const s = await serve(child);
  try {
    const page = await (await fetch(`${s.url}/explore`)).text();
    const head = page.slice(page.indexOf('<header class="topbar"'), page.indexOf("</header>"));
    expect(signUpLink(head)).toBeUndefined();
    expect(head).toContain(">Sign in<");
  } finally {
    await s.stop?.();
    child.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("behind a platform edge there is no Sign up, and with the edge switched off there is", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-header-edge-"));
  const edge = createApp({ dataDir: dir, port: 0, edgeToken: "edge-secret" });
  const s = await serve(edge);
  const headOf = async () => {
    const page = await (await fetch(`${s.url}/explore`)).text();
    return page.slice(page.indexOf('<header class="topbar"'), page.indexOf("</header>"));
  };
  try {
    setSignup(edge.db, "open", "test");
    expect(signUpLink(await headOf())).toBeUndefined();
    setCapacity(edge.db, "signin.edge", "off", "test");
    expect(signUpLink(await headOf())).toBe("/signup");
  } finally {
    await s.stop?.();
    edge.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("/agents keeps its form and says people start on the home page", async () => {
  const page = await (await fetch(`${servers.url}/agents`)).text();
  expect(page).toContain('id="agent-forge"');
  expect(page).toMatch(/People start at <a href="\/">home<\/a>/);
});
