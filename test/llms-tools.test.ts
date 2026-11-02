/** /llms.txt's `## MCP tools` section is the generated tool index, line for line. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { TOOLS } from "../src/http/mcp/tools.ts";

describe("/llms.txt MCP tools", () => {
  let dataDir: string;
  let servers: Servers;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-llms-tools-"));
    servers = await serve(createApp({ dataDir, port: 0 }));
  });
  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("lists exactly the tools in the index, with (admin) and (writes)", async () => {
    const res = await fetch(`${servers.url}/llms.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age");
    const lines = (await res.text()).split("\n");
    const start = lines.indexOf("## MCP tools");
    expect(start).toBeGreaterThan(-1);
    const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
    const listed = lines.slice(start + 1, end).filter((l) => l.startsWith("- "));
    const expected = TOOLS.map((t) => {
      const admin = t.adminOnly === true || t.needsAdminScope === true ? " (admin)" : "";
      return `- ${t.name}: ${t.description.replace(/\s+/g, " ").trim()}${admin}${t.writes ? " (writes)" : ""}`;
    });
    expect(listed).toEqual(expected);
    expect(TOOLS.some((t) => t.writes)).toBe(true);
    expect(TOOLS.some((t) => t.adminOnly === true)).toBe(true);
  });
});
