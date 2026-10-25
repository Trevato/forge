/**
 * Asking for another verification link reads the same from every door: the
 * API and the MCP `email_verify` tool both answer a refusal with the
 * sentence `actions/verify_words.ts` holds, so a door that retypes the
 * words fails here.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERIFY_WORDS } from "../src/actions/verify_words.ts";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { setLimit } from "../src/settings/limits.ts";
import { seedAdmin } from "./helpers/admin.ts";

describe("email verification's words", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let id = 1;
  let delivers = true;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-verify-words-"));
    app = createApp({
      dataDir,
      port: 0,
      url: "https://forge.example",
      mailer: async () => delivers,
    });
    servers = await serve(app);
    setLimit(app.db, "signup.per_source", 1000, "setup");
    const owner = await seedAdmin(app, { username: "olive", email: "olive@f.dev", password: "owner-passphrase" });
    if (!owner.ok) throw new Error(owner.error);
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const newcomer = async (name: string) => {
    const res = await fetch(`${servers.url}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: name, email: `${name}@outsider.test`, password: "outsider-passphrase" }),
    });
    expect(res.status).toBe(201);
    const user = getUserByName(app.db, name)!;
    return { user, token: createToken(app.db, user.id, "t", "rw").token };
  };
  const forgetLastSend = (userId: string) =>
    app.db.query("UPDATE email_check SET last_sent_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?1").run(userId);

  const viaApi = async (token: string) => {
    const res = await fetch(`${servers.url}/api/v1/user/email/verify`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const body: any = await res.json();
    return { status: res.status, error: body.error as string, message: body.message as string };
  };
  const viaMcp = async (token: string) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "email_verify", arguments: {} } }),
    });
    const body: any = await res.json();
    return { isError: body.result.isError === true, text: body.result.content[0].text as string };
  };

  test("too soon: both doors answer the module's sentence", async () => {
    const { token } = await newcomer("ada");
    const api = await viaApi(token);
    expect(api.status).toBe(429);
    expect(api).toEqual({ status: 429, error: "too_soon", message: VERIFY_WORDS.too_soon });
    const mcp = await viaMcp(token);
    expect(mcp.isError).toBe(true);
    expect(mcp.text).toContain(VERIFY_WORDS.too_soon);
  });

  test("a send that fails: both doors answer the module's sentence", async () => {
    const { user, token } = await newcomer("grace");
    delivers = false;
    try {
      forgetLastSend(user.id);
      const api = await viaApi(token);
      expect(api.status).toBe(502);
      expect(api).toEqual({ status: 502, error: "failed", message: VERIFY_WORDS.failed });
      forgetLastSend(user.id);
      const mcp = await viaMcp(token);
      expect(mcp.isError).toBe(true);
      expect(mcp.text).toContain(VERIFY_WORDS.failed);
    } finally {
      delivers = true;
    }
  });
});
