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
  for (const p of card.plugins) {
    expect(p.source).toBe(`${servers.url}/trevato/forge.git`);
    expect(llms).toContain(p.source);
    expect(llms).toContain(p.install);
    expect(llms).toContain(p.path);
    // Nothing outside what the line fetched: no bare plugins/ path, no clone-relative cp.
    const bare = p.install.replace(/forge-plugin\/plugins\//g, "").replace(/sparse-checkout set plugins\//, "").replace(/\/raw\/main\/plugins\//g, "");
    expect(bare).not.toMatch(/(^|\s)plugins\//);
    expect(p.install).not.toMatch(/\bcp /);
  }
  const claude = card.plugins.find((p: any) => p.harness === "claude-code");
  expect(claude.install).toContain("--sparse");
  expect(claude.install).toContain("--plugin-dir forge-plugin/plugins/claude-code");
  const oc = card.plugins.find((p: any) => p.harness === "opencode");
  expect(oc.install).toContain(`curl -fsSL ${servers.url}/trevato/forge/raw/main/plugins/opencode/forge.ts`);
  for (const p of card.plugins) expect(existsSync(join(import.meta.dir, "..", p.path))).toBe(true);
  expect(card.name).toBe("forge");
});
