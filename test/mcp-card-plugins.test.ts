/** The card and /llms.txt name each shipped plugin with its install line, from one constant. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-card-plugins-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});
afterAll(async () => {
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test("card and llms.txt name both plugins, their install lines, and paths that exist", async () => {
  const card = (await fetch(`${servers.url}/.well-known/mcp.json`).then((r) => r.json())) as any;
  const llms = await fetch(`${servers.url}/llms.txt`).then((r) => r.text());
  expect(card.plugins.map((p: any) => p.harness).sort()).toEqual(["claude-code", "opencode"]);
  const claude = card.plugins.find((p: any) => p.harness === "claude-code");
  expect(claude.install).toBe("claude --plugin-dir plugins/claude-code");
  for (const p of card.plugins) {
    expect(existsSync(join(import.meta.dir, "..", p.path))).toBe(true);
    expect(llms).toContain(p.install);
    expect(llms).toContain(p.path);
  }
  expect(card.name).toBe("forge");
});
