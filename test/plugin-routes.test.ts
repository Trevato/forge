/** /plugins/opencode/forge.ts serves the repository's plugin file (#10198). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { mcpCard } from "../src/core/mcp_card.ts";
import { opencodeInstall } from "../src/core/plugin_install.ts";
import { reservedName } from "../src/core/reserved.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const ROOT = join(import.meta.dir, "..");
let dir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "plugin-routes-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("200: the file's bytes, as text/plain, with an ETag and the security floor", async () => {
  const res = await fetch(`${servers.url}/plugins/opencode/forge.ts`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(res.headers.get("etag")).toBeTruthy();
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("referrer-policy")).toBeTruthy();
  expect(res.headers.get("content-security-policy")).toBeTruthy();
  expect(await res.text()).toBe(readFileSync(join(ROOT, "plugins/opencode/forge.ts"), "utf8"));
});

test("304: a matching If-None-Match has no body", async () => {
  const first = await fetch(`${servers.url}/plugins/opencode/forge.ts`);
  const etag = first.headers.get("etag")!;
  const again = await fetch(`${servers.url}/plugins/opencode/forge.ts`, { headers: { "if-none-match": etag } });
  expect(again.status).toBe(304);
  expect(await again.text()).toBe("");
  const other = await fetch(`${servers.url}/plugins/opencode/forge.ts`, { headers: { "if-none-match": 'W/"nope"' } });
  expect(other.status).toBe(200);
});

test("`plugins` is a reserved name", () => {
  expect(reservedName(app.db, "plugins")).toBeDefined();
});

test("the Dockerfile copies plugins/opencode", () => {
  const copies = readFileSync(join(ROOT, "Dockerfile"), "utf8")
    .split("\n")
    .filter((l) => l.startsWith("COPY ") && !l.includes("--from"))
    .flatMap((l) => l.trim().split(/\s+/).slice(1, -1).map((p) => p.replace(/\/$/, "")));
  expect(copies).toContain("plugins/opencode");
});

test("the printed install command, run, fetches the plugin's bytes from this forge", async () => {
  const work = await mkdtemp(join(tmpdir(), "plugin-install-"));
  try {
    const run = Bun.spawn(["sh", "-c", opencodeInstall(servers.url)], { cwd: work });
    expect(await run.exited).toBe(0);
    expect(readFileSync(join(work, ".opencode/plugin/forge.ts"), "utf8")).toBe(readFileSync(join(ROOT, "plugins/opencode/forge.ts"), "utf8"));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("llms.txt and the card print opencodeInstall, never the code host", async () => {
  const cmd = opencodeInstall(servers.url);
  const llms = await (await fetch(`${servers.url}/llms.txt`)).text();
  expect(llms).toContain(cmd);
  expect(llms).not.toMatch(/OpenCode[^\n]*forge\.open-platform\.sh/);
  expect(llms).not.toMatch(/raw\/main\/plugins\/opencode/);
  const card = mcpCard(servers.url, "trevato/forge");
  expect(card.plugins.find((p: any) => p.harness === "opencode")?.install).toBe(cmd);
});

test("the Claude Code marketplace manifest names the plugin, its source and each command file", async () => {
  const res = await fetch(`${servers.url}/plugins/claude-code/marketplace.json`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  const m = (await res.json()) as any;
  expect(m.name).toBe("forge");
  const plugin = m.plugins.find((p: any) => p.name === "forge");
  expect(plugin.source).toMatchObject({ source: "git-subdir", path: "plugins/claude-code" });
  expect(plugin.source.url).toEndWith(".git");
  const files = readdirSync(join(ROOT, "plugins/claude-code/commands")).filter((f) => f.endsWith(".md"));
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) expect(plugin.commands).toContain(`./commands/${f}`);
  expect(plugin.commands.length).toBe(files.length);
});

const fakeCtx = (config: object, host = "x.test") =>
  ({ app: { ...app, config: { ...app.config, ...config } }, request: new Request(`http://${host}/m`), url: new URL(`http://${host}/m`) }) as any;

test("the manifest names the configured address, not the Host header", async () => {
  const { marketplaceManifest } = await import("../src/http/plugin_routes.ts");
  const text = await (await marketplaceManifest()(fakeCtx({ url: "https://forge.example", forgeRepo: "a/b" }, "evil.test"))).text();
  expect(text).toContain("https://forge.example");
  expect(text).not.toContain("evil.test");
});

test("the manifest is 404 when no source repository is offered, or the tree has no commands", async () => {
  const { marketplaceManifest } = await import("../src/http/plugin_routes.ts");
  const commands = join(ROOT, "plugins/claude-code/commands");
  expect((await marketplaceManifest(commands, { repo: undefined })(fakeCtx({}))).status).toBe(404);
  expect((await marketplaceManifest(join(dir, "none"))(fakeCtx({}))).status).toBe(404);
  expect((await marketplaceManifest(commands)(fakeCtx({}))).status).toBe(200);
});
