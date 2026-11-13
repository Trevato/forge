/** An agent reading llms.txt, /.well-known/mcp.json or the MCP's own tools/list sees the same tools; a drift names the tool and the door that lacks it. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";

type Door = { name: string; tools: Set<string> };

/** One message per tool missing from a door, or none when the doors agree. */
export function drift(doors: Door[]): string[] {
  const all = new Set(doors.flatMap((d) => [...d.tools]));
  return [...all].sort().flatMap((tool) => doors.filter((d) => !d.tools.has(tool)).map((d) => `${tool}: missing from ${d.name}`));
}

describe("the doors onto the MCP tools", () => {
  let dataDir: string;
  let servers: Servers;
  let admin: string;
  let member: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-doors-"));
    const app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const make = async (username: string, adminIfFirst: boolean) => {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst });
      if (!made.ok) throw new Error(made.error);
      return createToken(app.db, made.value.id, "doors", adminIfFirst ? "admin" : "rw").token;
    };
    admin = await make("alice", true);
    member = await make("bob", false);
  });
  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const listed = async (token: string | undefined) => {
    const res = await fetch(`${servers.url}/llms.txt`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    const lines = (await res.text()).split("\n");
    const start = lines.indexOf("## MCP tools");
    expect(start).toBeGreaterThan(-1);
    const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
    return lines
      .slice(start + 1, end)
      .map((l) => /^- ([a-z][\w-]*): (.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ name: m[1]!, admin: m[2]!.includes("(admin)") }));
  };
  const served = async (token: string) => {
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: cursor ? { all: true, cursor } : { all: true } }),
      });
      const r = ((await res.json()) as any).result;
      names.push(...r.tools.map((t: any) => t.name));
      cursor = r.nextCursor;
    } while (cursor !== undefined);
    return names;
  };
  const card = async () => ((await (await fetch(`${servers.url}/.well-known/mcp.json`)).json()) as any).tokenFreeTools as string[];

  test("an admin sees every tool at tools/list and in llms.txt", async () => {
    const llms = new Set((await listed(admin)).map((t) => t.name));
    const mcp = new Set(await served(admin));
    expect(drift([{ name: "llms.txt", tools: llms }, { name: "tools/list", tools: mcp }])).toEqual([]);
  });

  test("a member's tools/list is llms.txt without the tools it marks (admin)", async () => {
    const llms = await listed(member);
    const open = new Set(llms.filter((t) => !t.admin).map((t) => t.name));
    const mcp = new Set(await served(member));
    expect(drift([{ name: "llms.txt (not admin)", tools: open }, { name: "tools/list", tools: mcp }])).toEqual([]);
  });

  test("a stranger sees the same token-free tools in llms.txt and mcp.json, and a member's tools/list carries them", async () => {
    const llms = new Set((await listed(undefined)).map((t) => t.name));
    const free = new Set(await card());
    expect(drift([{ name: "llms.txt", tools: llms }, { name: "mcp.json", tools: free }])).toEqual([]);
    const mcp = new Set(await served(member));
    expect(drift([{ name: "tools/list", tools: mcp }, { name: "mcp.json", tools: free }].map((d) => (d.name === "tools/list" ? { ...d, tools: new Set([...d.tools].filter((n) => free.has(n))) } : d)))).toEqual([]);
  });

  test("a tool missing from one door is named with that door", () => {
    expect(drift([{ name: "llms.txt", tools: new Set(["a", "b"]) }, { name: "mcp.json", tools: new Set(["a"]) }])).toEqual(["b: missing from mcp.json"]);
  });
});
