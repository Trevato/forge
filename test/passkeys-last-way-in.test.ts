/**
 * An account with no password cannot remove its last passkey (#8043), on
 * Settings → Passkeys and through MCP `whoami_can` alike; a second passkey
 * or a password lets the removal through.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAST_WAY_IN } from "../src/actions/passkeys.ts";
import { createApp, type App } from "../src/app.ts";
import { addPasskey, listPasskeys } from "../src/core/passkeys.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("the last way in", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let n = 0;
  let rpc = 1;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-last-way-in-"));
    app = createApp({ dataDir, port: 0, url: "https://forge.example" });
    servers = await serve(app);
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const person = async (password?: string): Promise<User> => {
    const name = `p${n++}`;
    const made = await createUser(app.db, { username: name, email: `${name}@f.dev`, origin: "seed", trusted: true, ...(password ? { password } : {}) });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const key = (user: User) => {
    const added = addPasskey(app.db, user.id, "phone", { id: `cred-${n++}`, alg: "ES256", key: { kty: "EC", crv: "P-256", x: "x", y: "y" }, signCount: 0 });
    if (!added.ok) throw new Error(added.error);
    return added.value;
  };
  const listed = (user: User, id: string) => listPasskeys(app.db, user.id).some((k) => k.id === id);

  const viaPage = async (user: User, id: string) => {
    const cookie = `forge_session=${createSession(app.db, user.id).token}`;
    const res = await fetch(`${servers.url}/settings/passkeys/${id}/delete`, { method: "POST", headers: { cookie }, redirect: "manual" });
    expect(res.status).toBe(303);
    const carried = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    return (await fetch(`${servers.url}/settings/passkeys`, { headers: { cookie: `${cookie}; ${carried}` } })).text();
  };
  const viaMcp = async (user: User, id: string) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${createToken(app.db, user.id, "t", "admin").token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpc++, method: "tools/call", params: { name: "whoami_can", arguments: { kind: "passkeys", remove: id } } }),
    });
    const body: any = await res.json();
    return { isError: body.result.isError === true, text: body.result.content[0].text as string };
  };

  test("the page refuses a passkey-only account's single passkey", async () => {
    const user = await person();
    const id = key(user);
    const page = await viaPage(user, id);
    expect(page).toContain(LAST_WAY_IN);
    expect(page).not.toContain("Passkey removed.");
    expect(listed(user, id)).toBe(true);
  });

  test("MCP refuses a passkey-only account's single passkey", async () => {
    const user = await person();
    const id = key(user);
    const res = await viaMcp(user, id);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("refused");
    expect(res.text).toContain(LAST_WAY_IN);
    expect(listed(user, id)).toBe(true);
  });

  test("with a second passkey the removal goes through, page and MCP", async () => {
    const user = await person();
    const a = key(user);
    const b = key(user);
    const c = key(user);
    expect(await viaPage(user, a)).toContain("Passkey removed.");
    expect(listed(user, a)).toBe(false);
    expect((await viaMcp(user, b)).isError).toBe(false);
    expect(listed(user, b)).toBe(false);
    // Now c is the last one, and it stays.
    expect((await viaMcp(user, c)).text).toContain(LAST_WAY_IN);
    expect(listed(user, c)).toBe(true);
  });

  test("with a password the last passkey can go, page and MCP", async () => {
    const one = await person("a-long-passphrase");
    const a = key(one);
    expect(await viaPage(one, a)).toContain("Passkey removed.");
    expect(listed(one, a)).toBe(false);
    const two = await person("a-long-passphrase");
    const b = key(two);
    expect((await viaMcp(two, b)).isError).toBe(false);
    expect(listed(two, b)).toBe(false);
  });

  test("an unknown passkey is still not found", async () => {
    const user = await person();
    expect(await viaPage(user, "nope")).toContain("No such passkey.");
    expect((await viaMcp(user, "nope")).text).toContain("not_found");
  });
});
