/** The `mirror_now` tool is the Backups page's "bring level" button over MCP: admins only, and it words each case as the page does. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { startSnapshots, type SnapshotsHandle } from "../src/snapshot/service.ts";
import { dirStore, type Store } from "../src/snapshot/store.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("MCP mirror_now", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let svc: SnapshotsHandle | undefined;
  let admin: string;
  let adminRw: string;
  let other: string;
  let id = 1;

  const call = async (token: string) => {
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
        params: { name: "mirror_now", arguments: {} },
      }),
    });
    const body = (await res.json()) as any;
    if (body.error) return { text: JSON.stringify(body.error), isError: true };
    return { text: body.result.content[0].text as string, isError: body.result.isError === true };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-mirror-now-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
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
  }, 30_000);

  afterAll(async () => {
    await svc?.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("with no mirror it answers the page's sentence", async () => {
    const r = await call(admin);
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toEqual({ level: false, says: "This forge has no mirror to bring level." });
  });

  test("a non-admin and an admin's rw token are refused", async () => {
    expect((await call(other)).isError).toBe(true);
    expect((await call(adminRw)).isError).toBe(true);
  });

  test("with a local destination and mirror it reports level", async () => {
    svc = startSnapshots(app, dirStore(join(dataDir, "store")), {
      version: "t",
      nightly: false,
      mirror: () => dirStore(join(dataDir, "mirror")),
    });
    await svc.now();
    const r = await call(admin);
    expect(r.isError).toBe(false);
    const said = JSON.parse(r.text);
    expect(said.level).toBe(true);
    expect(said.says).toStartWith("The mirror is level");
  });

  /** A store that behaves as `base` does, except that `method` throws. */
  const breaking = (base: Store, method: "list" | "put" | "names"): Store =>
    new Proxy(base, {
      get: (t, k, r) =>
        k === method
          ? async () => {
              throw new Error(`${method} refused`);
            }
          : Reflect.get(t, k, r),
    });

  const restart = async (primary: Store, mirror: Store) => {
    await svc?.stop();
    svc = startSnapshots(app, primary, { version: "t", nightly: false, mirror: () => mirror });
    await svc.now();
  };

  test("a mirror that cannot be written is not level, and says why", async () => {
    await restart(dirStore(join(dataDir, "store2")), breaking(dirStore(join(dataDir, "mirror2")), "list"));
    const said = JSON.parse((await call(admin)).text);
    expect(said.level).toBe(false);
    expect(said.error).toContain("refused");
    expect(said.says).toStartWith("The mirror is not level:");
    expect(said.says).toContain(said.error);
  });

  test("an unreadable primary leaves the mirror untouched and says so", async () => {
    const primary = dirStore(join(dataDir, "store3"));
    await restart(primary, dirStore(join(dataDir, "mirror3")));
    await svc!.stop();
    svc = startSnapshots(app, breaking(primary, "names"), {
      version: "t",
      nightly: false,
      mirror: () => dirStore(join(dataDir, "mirror3")),
    });
    const said = JSON.parse((await call(admin)).text);
    expect(said.level).toBe(false);
    expect(said.error).toContain("refused");
    expect(said.says).toStartWith("The snapshots could not be read from the destination");
  });
});
