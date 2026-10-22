/**
 * The `account_verify` tool is POST …/admin/accounts/:username/verify over
 * MCP: the same action, so the same rules.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import type { User } from "../src/core/users.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("MCP account_verify", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin = "";
  let adminRo = "";
  let bobToken = "";
  let dave: User;
  let id = 1;

  const call = async (token: string, args: unknown) => {
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
        params: { name: "account_verify", arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    const text: string = body.result.content[0].text;
    return { text, error: body.result.isError === true };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-verify-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = (username: string, extra: { adminIfFirst?: boolean; trusted: boolean }) =>
      createUser(app.db, {
        origin: "seed",
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        ...extra,
      });
    const a = await mk("alice", { adminIfFirst: true, trusted: true });
    const b = await mk("bob", { trusted: true });
    const d = await mk("dave", { trusted: false });
    if (!a.ok || !b.ok || !d.ok) throw new Error("users");
    promote(app.db, b.value);
    dave = d.value;
    admin = createToken(app.db, a.value.id, "admin", "admin").token;
    adminRo = createToken(app.db, a.value.id, "ro", "ro").token;
    bobToken = createToken(app.db, b.value.id, "admin", "admin").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin verifies an unverified person, who can then create", async () => {
    expect(await createRepo(app, dave, { name: "d" })).toMatchObject({ ok: false, error: "unverified" });
    const done = await call(admin, { username: "dave" });
    expect(done.error).toBe(false);
    expect(JSON.parse(done.text)).toEqual({ username: "dave", verified: true });
    // Verified, the refusal for a guest is membership, no longer the email.
    expect(await createRepo(app, dave, { name: "d" })).toMatchObject({ ok: false, error: "not_member" });
    promote(app.db, dave);
    expect((await createRepo(app, dave, { name: "d" })).ok).toBe(true);
  });

  test("a non-admin, or a token that cannot admin, is refused", async () => {
    expect((await call(bobToken, { username: "dave" })).error).toBe(true);
    expect((await call(adminRo, { username: "dave" })).error).toBe(true);
  });

  test("an unknown username is not found; a missing one is invalid", async () => {
    const none = await call(admin, { username: "nobody" });
    expect(none.error).toBe(true);
    expect(none.text).toContain("not_found");
    expect((await call(admin, {})).text).toContain("invalid");
  });
});
