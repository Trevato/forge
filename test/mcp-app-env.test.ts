/**
 * The `app_env` tool is the API's /app/env routes over MCP: the same
 * actions, so the same gate and the same errors, and never a value read back.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

describe("MCP app_env", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let aliceAdmin: string;
  let aliceRw: string;
  let bobAdmin: string;
  let id = 1;
  const SECRET = "s3cret-value-xyz";

  const tool = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: id++,
        method: "tools/call",
        params: { name: "app_env", arguments: args },
      }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true
      ? { error: text }
      : { value: JSON.parse(text), text };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-env-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const b = await createUser(app.db, { origin: "seed", trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    promote(app.db, b.value);
    aliceAdmin = createToken(app.db, a.value.id, "admin", "admin").token;
    aliceRw = createToken(app.db, a.value.id, "rw", "rw").token;
    bobAdmin = createToken(app.db, b.value.id, "admin", "admin").token;
    const made = await createRepo(app, a.value, { name: "game", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const rec = createAppRecord(app.db, { repoId: made.value.id, slug: "game", access: "public" });
    if (!rec.ok) throw new Error(rec.error);
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin sets a variable per scope, lists the names and unsets them", async () => {
    for (const scope of ["all", "production", "preview"]) {
      const set = await tool(aliceAdmin, { repo: "alice/game", action: "set", name: "GREETING", value: SECRET, scope });
      expect(set.value.scope).toBe(scope);
      expect(set.text).not.toContain(SECRET);
    }
    const listed = await tool(aliceAdmin, { repo: "alice/game", action: "list" });
    expect(listed.text).not.toContain(SECRET);
    expect(listed.value.next_cursor).toBeNull();
    expect(listed.value.items.map((i: any) => i.scope).sort()).toEqual(["all", "preview", "production"]);
    for (const scope of ["all", "production", "preview"])
      expect((await tool(aliceAdmin, { repo: "alice/game", action: "unset", name: "GREETING", scope })).value).toEqual({});
    expect((await tool(aliceAdmin, { repo: "alice/game", action: "list" })).value.items).toEqual([]);
  });

  test("a writer who is not admin is refused, by token scope and by role", async () => {
    const rw = await tool(aliceRw, { repo: "alice/game", action: "list" });
    expect(rw.error).toContain("admin-scope");
    const bob = await tool(bobAdmin, { repo: "alice/game", action: "set", name: "A", value: SECRET });
    expect(bob.error).toBeDefined();
    expect(bob.error).not.toContain(SECRET);
    expect((await tool(aliceAdmin, { repo: "alice/game", action: "list" })).value.items).toEqual([]);
  });

  test("a bad name, scope or action is refused with the API's error, never the value", async () => {
    const name = await tool(aliceAdmin, { repo: "alice/game", action: "set", name: "no good", value: SECRET });
    expect(name.error).toContain("invalid_name");
    expect(name.error).not.toContain(SECRET);
    const reserved = await tool(aliceAdmin, { repo: "alice/game", action: "set", name: "FORGE_X", value: SECRET });
    expect(reserved.error).toContain("reserved_name");
    const scope = await tool(aliceAdmin, { repo: "alice/game", action: "set", name: "A", value: SECRET, scope: "x" });
    expect(scope.error).toContain("invalid_scope");
    const gone = await tool(aliceAdmin, { repo: "alice/game", action: "unset", name: "NOPE" });
    expect(gone.error).toContain("no_such_var");
    expect((await tool(aliceAdmin, { repo: "alice/game", action: "burn" })).error).toContain("list, set or unset");
  });
});
