/**
 * The `whoami_can remove` tool removes the caller's own passkey, and only with an
 * admin-scope token.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addPasskey, listPasskeys } from "../src/core/passkeys.ts";
import { createToken } from "../src/core/tokens.ts";
import { getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

describe("MCP whoami_can remove", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let rpc = 1;
  let n = 0;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-passkey-"));
    app = createApp({ dataDir, port: 0, url: "https://forge.example" });
    servers = await serve(app);
    const owner = await seedAdmin(app, { username: "olive", email: "olive@f.dev", password: "owner-passphrase" });
    if (!owner.ok) throw new Error(owner.error);
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const person = (name: string) => {
    const user = getUserByName(app.db, name)!;
    const key = { kty: "EC", crv: "P-256", x: "x", y: "y" } as const;
    const added = addPasskey(app.db, user.id, "phone", { id: `cred-${n++}`, alg: "ES256", key, signCount: 0 });
    if (!added.ok) throw new Error(added.error);
    return { user, passkey: added.value };
  };

  const call = async (token: string, id: string, extra: Record<string, unknown> = { kind: "passkeys" }) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpc++, method: "tools/call", params: { name: "whoami_can", arguments: { ...extra, remove: id } } }),
    });
    const body: any = await res.json();
    return { isError: body.result.isError === true, text: body.result.content[0].text as string };
  };

  test("an admin-scope token removes the caller's passkey", async () => {
    const { user, passkey } = person("olive");
    const res = await call(createToken(app.db, user.id, "t", "admin").token, passkey);
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.text)).toEqual({ id: passkey, says: "Passkey removed." });
    expect(listPasskeys(app.db, user.id).some((k) => k.id === passkey)).toBe(false);
  });

  test("a read-write token is refused and the passkey stays", async () => {
    const { user, passkey } = person("olive");
    const res = await call(createToken(app.db, user.id, "t", "rw").token, passkey);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("admin-scope");
    expect(listPasskeys(app.db, user.id).some((k) => k.id === passkey)).toBe(true);
  });

  test("another person's passkey is refused and stays", async () => {
    const res0 = await fetch(`${servers.url}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ada", email: "ada@outsider.test", password: "outsider-passphrase" }),
    });
    expect(res0.status).toBe(201);
    const ada = getUserByName(app.db, "ada")!;
    const { user: olive, passkey } = person("olive");
    const res = await call(createToken(app.db, ada.id, "t", "admin").token, passkey);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("No such passkey.");
    expect(listPasskeys(app.db, olive.id).some((k) => k.id === passkey)).toBe(true);
  });

  const signup = async (name: string) => {
    const res = await fetch(`${servers.url}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: name, email: `${name}@outsider.test`, password: "outsider-passphrase" }),
    });
    expect(res.status).toBe(201);
    return getUserByName(app.db, name)!;
  };

  test("an agent is refused as a person's call, and the passkey stays", async () => {
    const bot = await signup("botty");
    app.db.query("UPDATE user SET is_agent = 1 WHERE id = ?1").run(bot.id);
    const { passkey } = person("botty");
    const res = await call(createToken(app.db, bot.id, "t", "admin").token, passkey);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("an agent has no passkeys");
    expect(listPasskeys(app.db, bot.id).some((k) => k.id === passkey)).toBe(true);
  });

  test("an empty or over-long id is bad_args", async () => {
    const user = await signup("cora");
    const token = createToken(app.db, user.id, "t", "admin").token;
    for (const id of ["", "x".repeat(65)]) {
      const res = await call(token, id);
      expect(res.isError).toBe(true);
      expect(res.text).toContain("bad_args");
    }
  });

  test("remove without kind passkeys is refused, and the passkey stays", async () => {
    const { user, passkey } = person("olive");
    const res = await call(createToken(app.db, user.id, "t", "admin").token, passkey, {});
    expect(res.isError).toBe(true);
    expect(listPasskeys(app.db, user.id).some((k) => k.id === passkey)).toBe(true);
  });
});
