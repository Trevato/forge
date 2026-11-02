import { expect, test } from "bun:test";

const dir = `${import.meta.dir}/../plugins/claude-code`;
const plugin = await Bun.file(`${dir}/.claude-plugin/plugin.json`).json();

test("the forge server sends no Authorization header, so Claude Code signs in with OAuth", () => {
  const forge = plugin.mcpServers.forge;
  expect(forge.url).toBe("${FORGE_URL}/mcp");
  expect(Object.keys(forge.headers ?? {}).map((h) => h.toLowerCase())).not.toContain("authorization");
});

test("forge-token sends FORGE_TOKEN as a bearer", () => {
  expect(plugin.mcpServers["forge-token"].headers.Authorization).toBe("Bearer ${FORGE_TOKEN:-}");
});

test("the description names every verb the command handles", async () => {
  const md = await Bun.file(`${dir}/commands/forge.md`).text();
  const list = md.match(/^description: Talk to your forge: (.*)$/m)![1] as string;
  const verbs = list.split(",").map((v) => v.trim());
  expect(verbs.length).toBe(10);
  for (const v of verbs) expect(plugin.description).toContain(v);
});

test("the forge's own surfaces agree with plugin.json", async () => {
  const root = `${import.meta.dir}/..`;
  const names = Object.keys(plugin.mcpServers);
  expect(names).toEqual(["forge", "forge-token"]);
  for (const file of ["src/core/mcp_card.ts", "src/web/pages/account.ts", "docs/MCP.md", "plugins/claude-code/README.md"]) {
    const text = await Bun.file(`${root}/${file}`).text();
    for (const n of names) expect(text).toContain(n);
    expect(text).toContain("/mcp");
  }
});
