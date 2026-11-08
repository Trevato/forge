/**
 * The `cloud_account` tool changes a cloud account only for a site admin with
 * an admin-scope token (#7151): attach, rename and remove each answer one
 * line and never show the token, "delete" is `bad_verb`, and a non-admin or an
 * `rw` token is refused for every verb with the account unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { net } from "../src/actions/cloud.ts";
import { listCloudAccounts } from "../src/core/cloud_account.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const TOKEN = "do-live-9Zq4TxLm7Kp2Vb8nWcR5";
const realFetch = net.fetch;
const VERBS = ["attach", "verify", "rotate", "rename", "remove", "allow_writes", "audit"];

describe("MCP cloud_account", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let adminToken = "";
  let adminRw = "";
  let bobAdminScope = "";
  let id = 1;

  const call = async (token: string, args: Record<string, unknown>) => {
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
        params: { name: "cloud_account", arguments: { provider: "digitalocean", name: "main", ...args } },
      }),
    });
    const body = (await res.json()) as any;
    if (body.error) return { text: body.error.message as string, error: true };
    return { text: body.result.content[0].text as string, error: body.result.isError === true };
  };
  const accounts = () => listCloudAccounts(app.db).map((a) => `${a.provider}/${a.name}`);

  beforeAll(async () => {
    net.fetch = async (url) => {
      const u = new URL(url);
      if (u.pathname === "/v2/account")
        return new Response(JSON.stringify({ account: { email: "o@x.test", status: "active" } }));
      if (u.pathname === "/v2/projects") return new Response(JSON.stringify({ projects: [{}] }));
      return new Response("{}", { status: 404 });
    };
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-cloud-account-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    const make = async (username: string, adminIfFirst = false) => {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    const ada = await make("ada", true);
    const bob = await make("bob");
    adminToken = createToken(app.db, ada.id, "admin", "admin").token;
    adminRw = createToken(app.db, ada.id, "rw", "rw").token;
    bobAdminScope = createToken(app.db, bob.id, "admin", "admin").token;
  }, 60_000);

  afterAll(async () => {
    net.fetch = realFetch;
    servers?.stop();
    app?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin with an admin-scope token attaches, renames and removes; no answer shows the token", async () => {
    const attached = await call(adminToken, { verb: "attach", value: TOKEN });
    expect(attached.error).toBe(false);
    expect(JSON.parse(attached.text).says).toStartWith("attach digitalocean/main: ");
    expect(accounts()).toEqual(["digitalocean/main"]);
    const renamed = await call(adminToken, { verb: "rename", to: "ops" });
    expect(renamed.error).toBe(false);
    expect(JSON.parse(renamed.text).says).toBe("rename digitalocean/main: done.");
    expect(accounts()).toEqual(["digitalocean/ops"]);
    const removed = await call(adminToken, { verb: "remove", name: "ops" });
    expect(removed.error).toBe(false);
    expect(JSON.parse(removed.text).says).toBe("remove digitalocean/ops: done.");
    expect(accounts()).toEqual([]);
    for (const r of [attached, renamed, removed]) {
      expect(r.text).not.toContain(TOKEN);
      expect(JSON.parse(r.text).says).not.toContain("\n");
    }
  });

  test("verb delete is bad_verb", async () => {
    const r = await call(adminToken, { verb: "delete" });
    expect(r.error).toBe(true);
    expect(r.text).toContain("bad_verb");
  });

  test("a non-admin and an rw token are refused for every verb, the account unchanged", async () => {
    await call(adminToken, { verb: "attach", value: TOKEN });
    expect(accounts()).toEqual(["digitalocean/main"]);
    for (const token of [bobAdminScope, adminRw]) {
      for (const verb of VERBS) {
        const r = await call(token, { verb, value: TOKEN, to: "other", allowed: true, repo: "ada/x" });
        expect(r.error).toBe(true);
        expect(r.text).not.toContain(TOKEN);
      }
      expect(accounts()).toEqual(["digitalocean/main"]);
    }
    const [row] = listCloudAccounts(app.db);
    expect(row?.writeAllowed).toBe(false);
  });
});
