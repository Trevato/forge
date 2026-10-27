/** MCP `snapshot_now` is the Backups page's button: it says when there is nowhere to keep one, and only an admin-scope admin takes one. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { startSnapshots, type SnapshotsHandle } from "../src/snapshot/service.ts";
import { dirStore } from "../src/snapshot/store.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("MCP snapshot_now", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let svc: SnapshotsHandle | undefined;
  let admin = "";
  let adminRw = "";
  let other = "";
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
        params: { name: "snapshot_now", arguments: {} },
      }),
    });
    const body = (await res.json()) as any;
    if (body.error) return { text: JSON.stringify(body.error), isError: true };
    return { text: body.result.content[0].text as string, isError: body.result.isError === true };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-snapshot-now-"));
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
    admin = createToken(app.db, a.value.id, "admin", "admin").token;
    adminRw = createToken(app.db, a.value.id, "rw", "rw").token;
    other = createToken(app.db, b.value.id, "admin", "admin").token;
  }, 30_000);

  afterAll(async () => {
    await svc?.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a forge with no snapshot store says so", async () => {
    svc = startSnapshots(app, () => undefined, { version: "t", nightly: false });
    const r = await call(admin);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("no_store");
    expect(r.text).toContain("This forge has nowhere to put a snapshot.");
    await svc.stop();
    svc = undefined;
  });

  test("a non-admin, and an admin's rw token, are refused and nothing is taken", async () => {
    const store = dirStore(join(dataDir, "refused"));
    svc = startSnapshots(app, store, { version: "t", nightly: false });
    const plain = await call(other);
    const rw = await call(adminRw);
    expect(plain.isError).toBe(true);
    expect(rw.isError).toBe(true);
    expect(rw.text).toContain("forbidden");
    expect(await svc.list()).toEqual([]);
    expect(svc.last().manifest).toBeUndefined();
    await svc.stop();
    svc = undefined;
  });

  test("an admin-scope admin takes one, and it is in the store", async () => {
    const store = dirStore(join(dataDir, "store"));
    svc = startSnapshots(app, store, { version: "t", nightly: false });
    const r = await call(admin);
    expect(r.isError).toBe(false);
    const out = JSON.parse(r.text);
    expect(Object.keys(out).sort()).toEqual(["apps", "bytes", "name", "repos", "says"]);
    expect(out.says).toStartWith(`Snapshot ${out.name} taken: `);
    const kept = await svc.list();
    expect(kept.map((m) => m.name)).toEqual([out.name]);
    expect((await store.list(`snapshots/${out.name}/`)).length).toBeGreaterThan(0);
  });
});
