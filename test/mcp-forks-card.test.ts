/** MCP `fork_tree` draws the `ui://forge/forks` card: a row per node, indented by depth, with how it follows; unreadable forks absent. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo, forkRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { CARD_OF_TOOL, SHELL_JS, cardFor } from "../src/web/studio/cards.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe("MCP fork_tree card", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let token = "";
  let bobToken = "";

  const call = async (args: unknown, as = token) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${as}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fork_tree", arguments: args } }),
    });
    return ((await res.json()) as any).result;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-forks-card-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const users: Record<string, User> = {};
    for (const name of ["alice", "bob", "dan", "fay"])
      users[name] = must(await createUser(app.db, { origin: "seed", trusted: true, username: name, email: `${name}@f.dev`, password: "a-good-passphrase", adminIfFirst: name === "alice" }));
    for (const u of Object.values(users)) promote(app.db, u);
    token = createToken(app.db, users["alice"]!.id, "admin", "admin").token;
    bobToken = createToken(app.db, users["bob"]!.id, "bob", "ro").token;
    const upstream = must(await createRepo(app, users["alice"]!, { name: "app", visibility: "public" }));
    const bob = must(await forkRepo(app, users["bob"]!, upstream));
    must(await forkRepo(app, users["dan"]!, bob));
    // A private fork alice cannot read (only its owner reads it).
    must(await forkRepo(app, users["fay"]!, upstream, "secret", { visibility: "private" }));
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the fork_tree tool draws the forks card", () => {
    expect(CARD_OF_TOOL["fork_tree"]).toBe("forks");
  });

  test("a three-level tree is rows indented by depth, linked, with the follow words", async () => {
    const result = await call({ repo: "alice/app" });
    const json = JSON.parse(result.content[0].text);
    const card = result.structuredContent.card;
    expect(card.kind).toBe("forks");
    const rows = card.rows.filter((r: any) => r.label.trim().endsWith("/app"));
    expect(rows.map((r: any) => r.label)).toEqual(["alice/app", "bob/app", "dan/app"]);
    // Depth is data, and the shell draws it as padding (leading spaces would collapse).
    expect(rows.map((r: any) => r.depth ?? 0)).toEqual([0, 1, 2]);
    expect(SHELL_JS).toContain("paddingInlineStart");
    expect(rows[0].value).toBe("follows on its own");
    expect(rows[1].value).toBe("offers updates");
    expect(rows[2].link).toMatch(/\/dan\/app$/);
    expect(json.nodes.map((n: any) => n.repo)).toContain("dan/app");
  });

  test("a repository the caller cannot read is absent", async () => {
    // The admin reads the private fork: the card names it. Bob cannot read it: neither the card nor the JSON does.
    expect(JSON.stringify((await call({ repo: "alice/app" })).structuredContent.card)).toContain("fay/secret");
    const result = await call({ repo: "alice/app" }, bobToken);
    expect(result.content[0].text).not.toContain("fay/");
    expect(JSON.stringify(result.structuredContent.card)).not.toContain("fay/");
    expect(result.structuredContent.card.rows.length).toBeGreaterThan(0);
  });

  test("truncated and over-long trees say what was left out; an empty answer has no card", () => {
    const nodes = Array.from({ length: 33 }, (_, i) => ({ repo: `u${i}/app`, parent: null, depth: 1, follow: "dont-follow" }));
    const card = cardFor("fork_tree", { root: "u/app", nodes, truncated: true })!;
    expect(card.rows.find((r) => r.label === "More")!.value).toBe("3 more not shown");
    expect(card.rows.some((r) => r.label === "Truncated")).toBe(true);
    expect(card.rows[0]!.value).toBe("off");
    expect(cardFor("fork_tree", { root: null, nodes: [], truncated: false })).toBeUndefined();
  });
});
