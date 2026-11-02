/** /llms.txt's `## MCP tools` section is the generated tool index and `report`, line for line, each by its `doc`. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { REPORT_TOOL } from "../src/http/mcp.ts";
import { TOOLS } from "../src/http/mcp/tools.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import type { Listed } from "../src/web/llms_tools.ts";

describe("/llms.txt MCP tools", () => {
  let dataDir: string;
  let servers: Servers;
  let token: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-llms-tools-"));
    const app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    token = createToken(app.db, made.value.id, "rw", "rw").token;
  });
  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("lists, for a signed-in reader, exactly the tools in the index and `report`, by their `doc`, with (admin) and (writes)", async () => {
    const res = await fetch(`${servers.url}/llms.txt`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-cache");
    const lines = (await res.text()).split("\n");
    const start = lines.indexOf("## MCP tools");
    expect(start).toBeGreaterThan(-1);
    const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
    const listed = lines.slice(start + 1, end).filter((l) => l.startsWith("- "));
    const expected = [...TOOLS, REPORT_TOOL].map((t: Listed) => {
      const admin = t.adminOnly === true || t.needsAdminScope === true ? " (admin)" : "";
      return `- ${t.name}: ${(t.doc ?? t.description).replace(/\s+/g, " ").trim()}${admin}${t.writes ? " (writes)" : ""}`;
    });
    expect(listed).toEqual(expected);
    expect(TOOLS.some((t) => t.writes)).toBe(true);
    expect(TOOLS.some((t) => t.adminOnly === true)).toBe(true);
  });
});
