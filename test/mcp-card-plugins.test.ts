/** The card and /llms.txt name each shipped plugin with its install line, from one constant. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let owner: User;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-card-plugins-"));
  app = createApp({ dataDir, port: 0, forgeRepo: "trevato/forge" });
  servers = await serve(app);
  const made0 = await createUser(app.db, { origin: "seed", trusted: true, username: "trevato", email: "t@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made0.ok) throw new Error(made0.error);
  owner = made0.value;
  const made = await createRepo(app, owner, { name: "forge", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
}, 60_000);
afterAll(async () => {
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

const setVisibility = async (visibility: "public" | "private") => {
  const r = await updateRepoSettings(app, owner, getRepo(app.db, "trevato", "forge")!, { visibility });
  if (!r.ok) throw new Error(String(r.error));
};

test("a private own repository offers the upstream's plugins, in the card and llms.txt alike", async () => {
  const card = (await fetch(`${servers.url}/.well-known/mcp.json`).then((r) => r.json())) as any;
  const llms = await fetch(`${servers.url}/llms.txt`).then((r) => r.text());
  expect(card.plugins.map((p: any) => p.harness).sort()).toEqual(["claude-code", "opencode"]);
  for (const p of card.plugins) {
    expect(p.source).toBe("https://forge.open-platform.sh/trevato/forge.git");
    expect(llms).toContain(p.install);
  }
  expect(llms).not.toContain("not offered here");
  expect(llms).not.toContain(`${servers.url}/trevato/forge.git`);
  expect(llms).not.toContain("needs that repository to be public");
});

test("card and llms.txt name both plugins, their install lines, and paths that exist", async () => {
  await setVisibility("public");
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
  expect(claude.install).toBe(`claude plugin marketplace add ${servers.url}/plugins/claude-code/marketplace.json && claude plugin install forge@forge`);
  const oc = card.plugins.find((p: any) => p.harness === "opencode");
  expect(oc.install).toContain(`${servers.url}/plugins/opencode/forge.ts`);
  for (const p of card.plugins) expect(existsSync(join(import.meta.dir, "..", p.path))).toBe(true);
  expect(card.name).toBe("forge");
});

test("llms.txt follows the source going private again, not its cached body", async () => {
  await setVisibility("public");
  expect(await fetch(`${servers.url}/llms.txt`).then((r) => r.text())).toContain("OpenCode plugin");
  await setVisibility("private");
  const text = await fetch(`${servers.url}/llms.txt`).then((r) => r.text());
  expect(text).toContain("OpenCode plugin");
  expect(text).not.toContain(`${servers.url}/trevato/forge.git`);
  expect(((await fetch(`${servers.url}/.well-known/mcp.json`).then((r) => r.json())) as any).plugins[0].source).toBe("https://forge.open-platform.sh/trevato/forge.git");
});

test("the plugin repository is the configured source: an admin's setting outranks FORGE_REPO, in the card and llms.txt alike", async () => {
  const { setForgeSource } = await import("../src/settings/forge_source.ts");
  await setVisibility("public");
  const made = await createRepo(app, owner, { name: "kit", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  setForgeSource(app.db, "trevato/kit", owner.id);
  try {
    const card = (await fetch(`${servers.url}/.well-known/mcp.json`).then((r) => r.json())) as any;
    const llms = await fetch(`${servers.url}/llms.txt`).then((r) => r.text());
    for (const p of card.plugins) {
      expect(p.source).toBe(`${servers.url}/trevato/kit.git`);
      expect(llms).toContain(p.install);
    }
    expect(llms).not.toContain(`${servers.url}/trevato/forge.git`);
  } finally {
    setForgeSource(app.db, null, owner.id);
  }
  expect(((await fetch(`${servers.url}/.well-known/mcp.json`).then((r) => r.json())) as any).plugins[0].source).toBe(`${servers.url}/trevato/forge.git`);
});

test("the upstream stands in while the own repository is private or unset, and with neither nothing is offered", async () => {
  const bare = createApp({ dataDir: join(dataDir, "bare"), port: 0 });
  const { offeredPluginRepo } = await import("../src/core/mcp_card.ts");
  const { UPSTREAM_REPO } = await import("../src/core/upstream.ts");
  await setVisibility("private");
  expect(offeredPluginRepo(bare.db, bare.config.forgeRepo, UPSTREAM_REPO)).toBe(UPSTREAM_REPO);
  expect(offeredPluginRepo(app.db, "trevato/forge", UPSTREAM_REPO)).toBe(UPSTREAM_REPO); // private here
  expect(offeredPluginRepo(app.db, "trevato/nothing", UPSTREAM_REPO)).toBe(UPSTREAM_REPO);
  await setVisibility("public");
  expect(offeredPluginRepo(app.db, "trevato/forge", UPSTREAM_REPO)).toBe("trevato/forge");
  await setVisibility("private");
  // Neither source: the cloned plugin is not offered; the one this forge serves still is.
  expect(offeredPluginRepo(bare.db, undefined, undefined)).toBeUndefined();
  expect(offeredPluginRepo(app.db, "trevato/forge", undefined)).toBeUndefined();
  const { mcpCard } = await import("../src/core/mcp_card.ts");
  expect(mcpCard("http://x.test", undefined).plugins.map((p: any) => p.harness)).toEqual(["opencode"]);
  bare.close();
});
