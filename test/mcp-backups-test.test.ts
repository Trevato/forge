/** MCP `backups_test`: the Backups page's Test button, from a harness. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASS = "a-long-backups-passphrase";
const SECRET = "sekrit-key-1234";

describe("MCP backups_test", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  const realS3 = Bun.S3Client;
  let admin = "";
  let plain = "";
  let rw = "";

  const rpc = async (token: string, method: string, params?: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return (await res.json()) as any;
  };
  const test_ = async (token: string, args: unknown) => {
    const body = await rpc(token, "tools/call", { name: "backups_test", arguments: args });
    if (body.error) return { error: true, text: body.error.message as string };
    return { error: body.result.isError === true, text: body.result.content[0].text as string };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-backups-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made: Record<string, any> = {};
    for (const [username, isAdmin] of [["alice", true], ["bob", false]] as const) {
      made[username] = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@x.test`, password: PASS, isAdmin });
      if (!made[username].ok) throw new Error(username);
    }
    admin = createToken(app.db, made["alice"].value.id, "t", "admin").token;
    rw = createToken(app.db, made["alice"].value.id, "t", "rw").token;
    plain = createToken(app.db, made["bob"].value.id, "t", "admin").token;
  }, 30_000);

  afterAll(async () => {
    (Bun as any).S3Client = realS3;
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const fields = (endpoint: string) => ({ endpoint, bucket: "my-bucket", accessKey: "AKIAEXAMPLE", secretKey: SECRET });

  test("a reachable destination is reached, and says so", async () => {
    // A bucket that lists one object; Bun's own S3 wire is not what this pins.
    (Bun as any).S3Client = class {
      async list() {
        return { contents: [{ key: "a.tar" }], isTruncated: false };
      }
    };
    const r = await test_(admin, fields("http://127.0.0.1:9"));
    (Bun as any).S3Client = realS3;
    expect(r.error).toBe(false);
    const out = JSON.parse(r.text);
    expect(out.says).toStartWith("Reached ");
    expect(out.reached).toBe(true);
  }, 20_000);

  test("an unreachable one says why, and never echoes a secret", async () => {
    // A client that fails at once, carrying the secrets in its message: the verdict
    // must not depend on how long the real S3 client retries a closed port.
    (Bun as any).S3Client = class {
      async list() {
        throw new Error(`connect ECONNREFUSED ${SECRET} AKIAEXAMPLE`);
      }
    };
    const r = await test_(admin, fields("http://127.0.0.1:1"));
    (Bun as any).S3Client = realS3;
    const out = JSON.parse(r.text);
    expect(out.reached).toBe(false);
    expect(out.says).toStartWith("Could not list ");
    expect(r.text).not.toContain(SECRET);
    expect(r.text).not.toContain("AKIAEXAMPLE");
  }, 20_000);

  test("an unreachable one is tried once, not retried with backoff", async () => {
    let calls = 0;
    (Bun as any).S3Client = class {
      async list() {
        calls++;
        throw new Error(`connect ECONNREFUSED ${SECRET}`);
      }
    };
    const r = await test_(admin, fields("http://127.0.0.1:1"));
    (Bun as any).S3Client = realS3;
    expect(calls).toBe(1);
    expect(JSON.parse(r.text).says).toStartWith("Could not list ");
    expect(r.text).not.toContain(SECRET);
  }, 20_000);

  test("a field the page would refuse is refused in the same words", async () => {
    const r = await test_(admin, { ...fields("ftp://x") });
    const out = JSON.parse(r.text);
    expect(out.reached).toBe(false);
    expect(out.says).toContain("The endpoint must be an http(s) URL");
    expect(r.text).not.toContain(SECRET);
  });

  test("a non-admin is refused and does not see the tool", async () => {
    const r = await test_(plain, fields("http://127.0.0.1:1"));
    expect(r.error).toBe(true);
    const listed = await rpc(plain, "tools/list");
    expect(listed.result.tools.map((t: any) => t.name)).not.toContain("backups_test");
  });

  test("an admin's rw token neither sees nor can call it; an admin-scope token can", async () => {
    const listed = await rpc(rw, "tools/list");
    expect(listed.result.tools.map((t: any) => t.name)).not.toContain("backups_test");
    const r = await test_(rw, fields("ftp://x"));
    expect(r.error).toBe(true);
    const seen = await rpc(admin, "tools/list");
    expect(seen.result.tools.map((t: any) => t.name)).toContain("backups_test");
  });

  test("listed to an admin, not as a read", async () => {
    const listed = await rpc(admin, "tools/list");
    const tool = listed.result.tools.find((t: any) => t.name === "backups_test");
    expect(tool.annotations?.readOnlyHint).not.toBe(true);
  });
});
