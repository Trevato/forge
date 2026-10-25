/** The `mirror_set` tool is the Backups page's mirror form over MCP: admins only, and no answer carries a key. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { resolveMirror } from "../src/snapshot/mirror.ts";
import { startSnapshots, type SnapshotsHandle } from "../src/snapshot/service.ts";
import { dirStore } from "../src/snapshot/store.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("MCP mirror_set", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let svc: SnapshotsHandle;
  let admin: string;
  let other: string;
  let adminRw: string;
  let cookie = "";
  let id = 1;
  const SECRET = "s3cr3t-key-that-must-not-leak";
  // The forge's own listener stands in for the bucket: it answers at once, and says no.
  let FIELDS: Record<string, string>;

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
        params: { name: "mirror_set", arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    if (body.error) return { text: JSON.stringify(body.error), isError: true };
    return { text: body.result.content[0].text as string, isError: body.result.isError === true };
  };
  const page = async () =>
    (await fetch(`${servers.url}/settings/backups`, { headers: { cookie } })).text();

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-mirror-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    FIELDS = { endpoint: servers.url, bucket: "offbox-copy", accessKey: "AKIAEXAMPLE", secretKey: SECRET };
    svc = startSnapshots(app, dirStore(join(dataDir, "store")), {
      version: "t",
      nightly: false,
      mirror: () => resolveMirror({ db: app.db, dataDir, bus: app.bus, env: {} })?.store,
    });
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
    admin = createToken(app.db, a.value.id, "admin", "admin").token;
    adminRw = createToken(app.db, a.value.id, "rw", "rw").token;
    other = createToken(app.db, b.value.id, "rw", "rw").token;
    const login = await fetch(`${servers.url}/signin`, {
      method: "POST",
      headers: { origin: servers.url },
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
      redirect: "manual",
    });
    cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  }, 30_000);

  afterAll(async () => {
    void svc.stop(); // a pass against the stand-in may still be in flight; the process ends it
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin sets a mirror and the page shows it; forget clears it", async () => {
    const set = await tool(admin, { action: "set", ...FIELDS });
    expect(set.isError).toBe(false);
    const said = JSON.parse(set.text);
    const place = `${servers.url.replace(/^https?:\/\//, "")}/offbox-copy`;
    expect(said.place).toBe(place);
    expect(said.says).toContain("sealed");
    expect(set.text).not.toContain(SECRET);
    const shown = await page();
    expect(shown).toContain(place);
    expect(shown).not.toContain(SECRET);

    const gone = await tool(admin, { action: "forget" });
    expect(gone.isError).toBe(false);
    expect(JSON.parse(gone.text).place).toBeNull();
    expect(await page()).toContain("No off-box mirror");
  });

  test("a bad field is refused with the action's own sentence, never echoing the key", async () => {
    const bad = await tool(admin, { action: "set", ...FIELDS, bucket: "X" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("bucket name");
    expect(bad.text).not.toContain(SECRET);
    expect((await tool(admin, { action: "peek" })).isError).toBe(true);
  });

  test("an admin's rw token is refused: sealing the mirror needs an admin-scope token", async () => {
    const set = await tool(adminRw, { action: "set", ...FIELDS });
    expect(set.isError).toBe(true);
    expect(set.text).not.toContain(SECRET);
    expect(svc.mirror).toBeUndefined();
    expect((await tool(adminRw, { action: "forget" })).isError).toBe(true);
  });

  test("a non-admin is refused", async () => {
    const set = await tool(other, { action: "set", ...FIELDS });
    expect(set.isError).toBe(true);
    expect(set.text).not.toContain(SECRET);
    expect(svc.mirror).toBeUndefined();
  });
});
