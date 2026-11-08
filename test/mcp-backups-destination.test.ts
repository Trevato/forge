/**
 * The `backups_destination` tool is the Backups page's form over MCP: the
 * same validation, the same sealing, and no key ever in the answer.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { sealedSet } from "../src/snapshot/destination.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { listAt } from "./mcp-list.ts";

quietLogs();

describe("MCP backups_destination", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin = "";
  let bob = "";
  let aliceRw = "";
  let cookie = "";
  let id = 1;
  const SECRET = "s3cr3t-key-ZZZ-0123456789";
  const LOCAL = {
    endpoint: "http://127.0.0.1:9000",
    bucket: "forge-snaps",
    accessKey: "AKIALOCAL",
    secretKey: SECRET,
  };

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
        params: { name: "backups_destination", arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    // A tool the caller may not see is no tool at all: a JSON-RPC error.
    if (body.error) return { text: body.error.message as string, error: true };
    return { text: body.result.content[0].text as string, error: body.result.isError === true };
  };

  const page = async () =>
    (await fetch(`${servers.url}/settings/backups`, { headers: { cookie } })).text();

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-backups-"));
    delete process.env["FORGE_SNAPSHOT_DIR"];
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await seedAdmin(app, { username: "alice", email: "alice@forge.local" });
    const b = await createUser(app.db, {
      origin: "seed",
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
      trusted: true,
    });
    if (!a.ok || !b.ok) throw new Error("users");
    admin = createToken(app.db, a.value.id, "admin", "admin").token;
    aliceRw = createToken(app.db, a.value.id, "rw", "rw").token;
    bob = createToken(app.db, b.value.id, "admin", "admin").token;
    cookie = `forge_session=${createSession(app.db, a.value.id).token}`;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin sets a destination, the page shows it, and no key comes back", async () => {
    const done = await call(admin, { action: "set", ...LOCAL });
    expect(done.error).toBe(false);
    expect(done.text).not.toContain(SECRET);
    expect(done.text).not.toContain(LOCAL.accessKey);
    const answer = JSON.parse(done.text);
    expect(Object.keys(answer).sort()).toEqual(["kind", "place", "says"]);
    expect(answer.kind).toBe("sealed");
    expect(answer.place).toBe("127.0.0.1:9000/forge-snaps");
    expect(await page()).toContain("sealed");
    expect(sealedSet(app.db)).toContain("SNAPSHOT_S3_SECRET_KEY");
  });

  test("a bad field is the page's refusal", async () => {
    const r = await call(admin, { action: "set", bucket: "NOT A BUCKET" });
    expect(r.error).toBe(true);
    expect(r.text).toContain("The bucket name is 3–63 lowercase letters");
    const k = await call(admin, { action: "set", secretKey: "has space" });
    expect(k.error).toBe(true);
    expect(k.text).not.toContain("has space");
    expect((await call(admin, { action: "set", bucket: 5 })).error).toBe(true);
    expect((await call(admin, { action: "nope" })).error).toBe(true);
  });

  test("forget clears it", async () => {
    const done = await call(admin, { action: "forget" });
    expect(done.error).toBe(false);
    expect(JSON.parse(done.text).kind).toBe("none");
    expect(sealedSet(app.db)).toEqual([]);
    expect(await page()).toContain("nothing");
  });

  test("a non-admin is refused", async () => {
    expect((await call(bob, { action: "set", ...LOCAL })).error).toBe(true);
    expect((await call(bob, { action: "forget" })).error).toBe(true);
    expect(sealedSet(app.db)).toEqual([]);
  });

  test("an admin's rw token neither sees nor calls it", async () => {
    expect((await call(aliceRw, { action: "set", ...LOCAL })).error).toBe(true);
    expect((await call(aliceRw, { action: "forget" })).error).toBe(true);
    expect(sealedSet(app.db)).toEqual([]);
  });

  test("tools/list names the action and the fields an agent sends", async () => {
    const tools = (await listAt(servers.url, admin)).result.tools as { name: string; inputSchema: any }[];
    const schema = tools.find((t) => t.name === "backups_destination")!.inputSchema;
    expect(schema.required).toEqual(["action"]);
    expect(schema.properties.action.enum).toEqual(["set", "forget"]);
    expect(Object.keys(schema.properties)).toContain("secretKey");
  });
});
