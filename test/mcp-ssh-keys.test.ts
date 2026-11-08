/**
 * The `ssh_keys` tool is `/api/v1/user/keys` over MCP: the same actions, the
 * same scope, and only the caller's own keys.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { listKeys } from "../src/core/keys.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const KEY_A =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl a@laptop";
const KEY_B =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJd2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA b@box";

describe("MCP ssh_keys", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let aliceRw: string;
  let aliceRo: string;
  let bobRw: string;
  let id = 1;

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
        params: { name: "ssh_keys", arguments: args },
      }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true
      ? { error: text }
      : { value: JSON.parse(text) };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-keys-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string) => {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    const alice = await mk("alice");
    const bob = await mk("bob");
    aliceRw = createToken(app.db, alice.id, "rw", "rw").token;
    aliceRo = createToken(app.db, alice.id, "ro", "ro").token;
    bobRw = createToken(app.db, bob.id, "rw", "rw").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a person adds, lists and removes a key; bad and duplicate keys are refused", async () => {
    const added = await tool(aliceRw, { action: "add", title: "laptop", key: KEY_A });
    expect(added.value.name).toBe("laptop");
    expect(added.value.fingerprint).toStartWith("SHA256:");
    const listed = await tool(aliceRw, { action: "list" });
    expect(listed.value.map((k: any) => k.id)).toEqual([added.value.id]);
    expect((await tool(aliceRw, { action: "add", key: KEY_A })).error).toStartWith("key_exists");
    expect((await tool(aliceRw, { action: "add", key: "nonsense" })).error).toStartWith("invalid_key");
    expect((await tool(aliceRw, { action: "remove", id: added.value.id })).value).toEqual({
      removed: added.value.id,
    });
    expect((await tool(aliceRw, {})).value).toEqual([]);
  });

  test("a read-only token lists but is refused add and remove", async () => {
    const added = await tool(aliceRw, { action: "add", title: "x", key: KEY_B });
    expect(added.value.id).toBeDefined();
    expect(Array.isArray((await tool(aliceRo, { action: "list" })).value)).toBe(true);
    expect((await tool(aliceRo, { action: "add", key: KEY_A })).error).toStartWith("forbidden");
    expect((await tool(aliceRo, { action: "remove", id: added.value.id })).error).toStartWith("forbidden");
    expect((await tool(aliceRw, { action: "list" })).value).toHaveLength(1);
  });

  test("one person cannot remove another's key", async () => {
    const [mine] = (await tool(aliceRw, { action: "list" })).value;
    expect((await tool(bobRw, { action: "remove", id: mine.id })).error).toStartWith("not_found");
    expect((await tool(bobRw, { action: "list" })).value).toEqual([]);
    expect((await tool(aliceRw, { action: "list" })).value).toHaveLength(1);
  });

  test("a read-only token's refusal stores nothing and names forbidden", async () => {
    const before = (await tool(aliceRw, { action: "list" })).value;
    const refused = await tool(aliceRo, { action: "add", key: KEY_A });
    expect(refused.error).toStartWith("forbidden");
    expect((await tool(aliceRw, { action: "list" })).value).toEqual(before);
    expect((await tool(bobRw, { action: "list" })).value).toEqual([]);
  });

  test("another account's key id is not_found and the key stays in the database", async () => {
    const [mine] = (await tool(aliceRw, { action: "list" })).value;
    expect((await tool(bobRw, { action: "remove", id: mine.id })).error).toStartWith("not_found");
    const alice = getUserByName(app.db, "alice")!;
    expect(listKeys(app.db, alice.id).map((k) => k.id)).toContain(mine.id);
  });

  test("an unknown action is invalid_action", async () => {
    expect((await tool(aliceRw, { action: "rotate" })).error).toStartWith("invalid_action");
  });

  test("malformed key lines are invalid_key and store nothing", async () => {
    const before = (await tool(bobRw, { action: "list" })).value;
    for (const key of ["not a key", "ssh-ed25519 !!!notbase64", ""]) {
      expect((await tool(bobRw, { action: "add", key })).error).toStartWith("invalid_key");
    }
    expect((await tool(bobRw, { action: "list" })).value).toEqual(before);
  });
});
