/**
 * The `email_verify` tool is POST /api/v1/user/email/verify over MCP: the
 * same action, the same limit, and never the link in the answer.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { setLimit } from "../src/settings/limits.ts";
import { createToken } from "../src/core/tokens.ts";
import { getUserByName } from "../src/core/users.ts";
import { emailVerified } from "../src/core/verify.ts";
import type { Mail } from "../src/kernel/mail.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

describe("MCP email_verify", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let id = 1;
  const sent: Mail[] = [];

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-verify-"));
    app = createApp({
      dataDir,
      port: 0,
      url: "https://forge.example",
      mailer: async (mail) => {
        sent.push(mail);
        return true;
      },
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

  const join_ = async (name: string) => {
    const res = await fetch(`${servers.url}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: name, email: `${name}@outsider.test`, password: "outsider-passphrase" }),
    });
    expect(res.status).toBe(201);
    const user = getUserByName(app.db, name)!;
    return { user, token: createToken(app.db, user.id, "t", "rw").token };
  };

  const ask = async (token: string) => {
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
    const text: string = body.result.content[0].text;
    return { isError: body.result.isError === true, text };
  };

  test("an unverified person asks once; asking again inside the limit is refused", async () => {
    const { user, token } = await join_("ada");
    app.db.query("UPDATE email_check SET last_sent_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?1").run(user.id);
    const before = sent.length;
    const first = await ask(token);
    expect(first.isError).toBe(false);
    expect(JSON.parse(first.text).outcome).toBe("sent");
    expect(sent.length).toBe(before + 1);
    expect(sent[before]!.to).toBe("ada@outsider.test");
    expect(first.text).not.toContain("/verify");
    expect(first.text).not.toContain("token");
    const again = await ask(token);
    expect(again.isError).toBe(true);
    expect(again.text).toContain("too_soon");
    expect(sent.length).toBe(before + 1);
  });

  test("a verified person is told so, and nothing is sent", async () => {
    const { user, token } = await join_("grace");
    app.db.query("UPDATE email_check SET verified_at = '2020-01-01T00:00:00.000Z' WHERE user_id = ?1").run(user.id);
    if (!emailVerified(app.db, user.id)) throw new Error("fixture: not verified");
    const before = sent.length;
    const res = await ask(token);
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.text).outcome).toBe("already");
    expect(sent.length).toBe(before);
  });
});
