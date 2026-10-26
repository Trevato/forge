/** `drills` is the lower half of Settings → Backups over MCP: an admin's, and no one else's. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { DOMAINS } from "../src/kernel/domains.ts";

describe("MCP drills", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin: string;
  let bob: string;
  let n = 1;

  const call = async (token: string) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: n++,
        method: "tools/call",
        params: { name: "drills", arguments: {} },
      }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-drills-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const u = await createUser(app.db, {
        origin: "seed", trusted: true, username,
        email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first,
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    const alice = await mk("alice", true);
    const b = await mk("bob");
    admin = createToken(app.db, alice.id, "a", "admin").token;
    bob = createToken(app.db, b.id, "b", "admin").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin sees every domain, with a command for each drillable one", async () => {
    const r = await call(admin);
    const rows: any[] = r.value;
    expect(rows.map((x) => x.key)).toEqual(DOMAINS.map((d) => d.key));
    for (const row of rows) {
      if (row.drilled) expect(row.command).toStartWith(`bun scripts/drills/run.ts ${row.key}`);
      else {
        expect(row.command).toBeUndefined();
        expect(row.why.length).toBeGreaterThan(0);
      }
    }
    expect(rows.some((x) => x.drilled)).toBe(true);
  });

  test("a non-admin is refused", async () => {
    const r = await call(bob);
    expect(r.error).toContain("forge admin");
  });
});
