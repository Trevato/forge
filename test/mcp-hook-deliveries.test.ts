/** `hooks` action `deliveries`: a hook's last deliveries, behind the same gate as `list`. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

describe("MCP hook deliveries", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let aliceAdmin: string;
  let bobAdmin: string;
  let hookId: string;
  let otherHookId: string;
  let id = 1;

  const tool = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "hooks", arguments: args } }),
    });
    const body = (await res.json()) as any;
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  const deliver = (hook: string, n: number, state: string, status: number | null, error: string | null) => {
    app.db.run("INSERT INTO event (id, kind, payload) VALUES (?1, 'push', '{\"secretpayload\":1}')", [`ev${n}`]);
    app.db.run(
      "INSERT INTO webhook_delivery (id, webhook_id, event_id, state, attempts, last_status, last_error) VALUES (?1, ?2, ?3, ?4, 2, ?5, ?6)",
      [`d${String(n).padStart(3, "0")}`, hook, `ev${n}`, state, status, error],
    );
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-hookdel-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error(a.error);
    const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
    if (!b.ok) throw new Error(b.error);
    promote(app.db, b.value);
    aliceAdmin = createToken(app.db, a.value.id, "a", "admin").token;
    bobAdmin = createToken(app.db, b.value.id, "b", "admin").token;
    for (const [owner, name] of [[a.value, "game"], [b.value, "other"]] as const) {
      const made = await createRepo(app, owner, { name, visibility: "public" });
      if (!made.ok) throw new Error(String(made.error));
    }
    const h = await tool(aliceAdmin, { repo: "alice/game", action: "add", url: "https://example.com/h", secret: "s3cret-value-long-enough" });
    hookId = h.value.id;
    app.db.run("DELETE FROM webhook_delivery");
    const o = await tool(bobAdmin, { repo: "bob/other", action: "add", url: "https://example.com/o", secret: "s3cret-value-long-enough" });
    otherHookId = o.value.id;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an ok and a failed delivery come back newest first with status and reason", async () => {
    deliver(hookId, 1, "ok", 200, null);
    deliver(hookId, 2, "failed", null, "refused: private address");
    const got = await tool(aliceAdmin, { repo: "alice/game", action: "deliveries", id: hookId });
    expect(got.value.items).toEqual([
      { id: "d002", state: "failed", attempts: 2, lastStatus: null, lastError: "refused: private address", kind: "push" },
      { id: "d001", state: "ok", attempts: 2, lastStatus: 200, lastError: null, kind: "push" },
    ]);
    const text = JSON.stringify(got);
    expect(text).not.toContain("s3cret-value-long-enough");
    expect(text).not.toContain("secretpayload");
    expect(text).not.toContain("signature");
  });

  test("at most 20 are answered", async () => {
    for (let n = 3; n < 30; n++) deliver(hookId, n, "ok", 200, null);
    const got = await tool(aliceAdmin, { repo: "alice/game", action: "deliveries", id: hookId });
    expect(got.value.items.length).toBe(20);
  });

  test("a non-admin and another repository's hook are refused", async () => {
    deliver(otherHookId, 100, "ok", 200, null);
    expect((await tool(bobAdmin, { repo: "alice/game", action: "deliveries", id: hookId })).error).toContain("not_found");
    expect((await tool(aliceAdmin, { repo: "alice/game", action: "deliveries", id: otherHookId })).error).toContain("not_found");
    expect((await tool(aliceAdmin, { repo: "alice/game", action: "deliveries", id: "nope" })).error).toContain("not_found");
    expect((await tool(aliceAdmin, { repo: "alice/game", action: "deliveries", id: "i".repeat(65) })).error).toContain("id is text");
  });
});
