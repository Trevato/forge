import { afterEach, expect, test } from "bun:test";
import { Forge } from "../plugins/opencode/forge.ts";

const saved = { url: process.env["FORGE_URL"], token: process.env["FORGE_TOKEN"] };
afterEach(() => {
  for (const [k, v] of [["FORGE_URL", saved.url], ["FORGE_TOKEN", saved.token]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function configure(url?: string, token?: string) {
  if (url) process.env["FORGE_URL"] = url; else delete process.env["FORGE_URL"];
  if (token) process.env["FORGE_TOKEN"] = token; else delete process.env["FORGE_TOKEN"];
  const config: Record<string, any> = {};
  const hooks = await Forge();
  await hooks.config(config);
  return config;
}

test("with a token it sends the bearer header", async () => {
  const c = await configure("https://f.test/", "tok");
  expect(c.mcp.forge).toEqual({ type: "remote", url: "https://f.test/mcp", headers: { Authorization: "Bearer tok" } });
  expect(c.command.forge).toBeDefined();
});

test("with only the url it leaves out Authorization and asks for OAuth", async () => {
  const c = await configure("https://f.test");
  expect(c.mcp.forge).toEqual({ type: "remote", url: "https://f.test/mcp", oauth: {} });
  expect(c.mcp.forge.headers).toBeUndefined();
  expect(c.command.forge).toBeDefined();
});

test("with neither it registers nothing", async () => {
  expect(await configure()).toEqual({});
});
