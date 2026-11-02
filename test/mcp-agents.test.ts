/** The `agents` tool answers what GET /api/v1/agents answers, and refuses the same callers. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("MCP agents", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let bobToken: string;

  const call = (token?: string) =>
    fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "agents", arguments: {} },
      }),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-agents-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    const b = await createUser(app.db, { origin: "seed", trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!a.ok || !b.ok) throw new Error("users");
    for (const name of ["scout", "quill"]) {
      const made = await createAgent(app, a.value, { username: name, brief: "SECRET-BRIEF", model: "m" });
      if (!made.ok) throw new Error(String(made.error));
    }
    bobToken = createToken(app.db, b.value.id, "r", "ro").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a signed-in person lists two agents, as the API does, without their briefs", async () => {
    const res = await call(bobToken);
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    const mine = JSON.parse(text);
    expect(mine.items.map((i: any) => i.username).sort()).toEqual(["quill", "scout"]);
    expect(text).not.toContain("SECRET-BRIEF");
    const api: any = await (
      await fetch(`${servers.url}/api/v1/agents`, { headers: { authorization: `Bearer ${bobToken}` } })
    ).json();
    expect(mine).toEqual(api);
  });

  test("an anonymous caller is refused", async () => {
    expect((await call()).status).toBe(401);
    expect((await fetch(`${servers.url}/api/v1/agents`)).status).toBe(401);
  });
});
