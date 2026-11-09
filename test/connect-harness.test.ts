/** /settings/tokens: the "Connect your harness" lines carry this forge's address and only a just-minted token. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let base: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "connect-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  base = servers.url;
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const value = (html: string, id: string) =>
  new RegExp(`id="${id}"[^>]*value="([^"]*)"`).exec(html)?.[1]?.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">") ?? "";

test("lines use the forge's address, a placeholder, then the minted token once", async () => {
  const signup = await fetch(`${base}/signup`, {
    method: "POST",
    body: new URLSearchParams({ username: "ada", email: "ada@f.dev", password: "connect-password" }),
    redirect: "manual",
  });
  const cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0]!;
  const url = (app.config.url ?? base).replace(/\/+$/, "");

  const before = await (await fetch(`${base}/settings/tokens`, { headers: { cookie } })).text();
  expect(before).toContain("Connect your harness");
  expect(value(before, "connect-claude")).toBe(`FORGE_URL=${url} FORGE_TOKEN=<token> claude --plugin-dir plugins/claude-code`);
  expect(value(before, "connect-opencode")).toBe(`mkdir -p .opencode/plugin && curl -fsSo .opencode/plugin/forge.ts ${url}/plugins/opencode/forge.ts && FORGE_URL=${url} FORGE_TOKEN=<token> opencode`);

  const made = await fetch(`${base}/settings/tokens`, {
    method: "POST",
    headers: { cookie, origin: base },
    body: new URLSearchParams({ name: "laptop", scope: "rw" }),
    redirect: "manual",
  });
  const flash = made.headers.getSetCookie().find((c) => c.startsWith("forge_flash="))!.split(";")[0]!;
  const after = await (await fetch(`${base}/settings/tokens`, { headers: { cookie: `${cookie}; ${flash}` } })).text();
  const token = JSON.parse(decodeURIComponent(flash.slice("forge_flash=".length))).code as string;
  expect(token.length).toBeGreaterThan(10);
  expect(value(after, "connect-claude")).toBe(`FORGE_URL=${url} FORGE_TOKEN=${token} claude --plugin-dir plugins/claude-code`);
  expect(value(after, "connect-opencode")).toContain(`FORGE_TOKEN=${token} opencode`);

  const later = await (await fetch(`${base}/settings/tokens`, { headers: { cookie } })).text();
  expect(later).not.toContain(token);
});
