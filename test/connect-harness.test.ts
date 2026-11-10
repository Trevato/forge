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
  app = createApp({ dataDir: dir, port: 0, forgeRepo: "trevato/forge" });
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

test("the marketplace lines show only while the forge's plugin repository is public, and are escaped", async () => {
  const { createRepo: initRepo } = await import("../src/core/repos.ts");
  const { createUser } = await import("../src/core/users.ts");
  const cookie = ((await fetch(`${base}/signin`, { method: "POST", body: new URLSearchParams({ username: "ada", password: "connect-password" }), redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0]!;
  const get = async () => (await fetch(`${base}/settings/tokens`, { headers: { cookie } })).text();
  const url = (app.config.url ?? base).replace(/\/+$/, "");
  expect(value(await get(), "connect-claude-add")).toBe("/plugin marketplace add https://forge.open-platform.sh/trevato/forge.git"); // no own source: the upstream's
  expect(await get()).toContain('id="connect-claude"');

  const owner = await createUser(app.db, { origin: "seed", trusted: true, username: "trevato", email: "t@f.dev", password: "connect-password" });
  if (!owner.ok) throw new Error(owner.error);
  const made = await initRepo(app.db, app.reposRoot, { ownerId: owner.value.id, name: "forge", visibility: "private", description: "" });
  expect(made).toMatchObject({ ok: true });
  expect(value(await get(), "connect-claude-add")).toBe("/plugin marketplace add https://forge.open-platform.sh/trevato/forge.git"); // private: the upstream's, which a stranger can run
  app.db.query("UPDATE repo SET visibility = 'public' WHERE name = 'forge'").run();

  const page = await get();
  expect(value(page, "connect-claude-add")).toBe(`/plugin marketplace add ${url}/trevato/forge.git`);
  expect(value(page, "connect-claude-install")).toBe("/plugin install forge@forge");
  expect(value(page, "connect-claude")).toContain("--plugin-dir plugins/claude-code");
  expect(value(page, "connect-opencode")).toContain(`FORGE_URL=${url}`);

  // A hostile public address is escaped in every attribute and never lands raw.
  const was = app.config.url;
  Object.assign(app.config, { url: 'http://h.test/"><script>x</script>' });
  try {
    const hostile = await get();
    expect(hostile).not.toContain("<script>x</script>");
    expect(hostile).toContain("marketplace add http://h.test/&quot;&gt;&lt;script&gt;x&lt;/script&gt;/trevato/forge.git");
  } finally {
    Object.assign(app.config, { url: was });
  }
});
