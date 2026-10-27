/** MCP `snapshot_now`: the Backups page's "take one now", for a forge admin. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { startSnapshots, type SnapshotsHandle } from "../src/snapshot/service.ts";
import { dirStore } from "../src/snapshot/store.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("MCP snapshot_now", () => {
  let root = "";
  let app: App;
  let servers: Servers;
  let svc: SnapshotsHandle | undefined;

  const token = (name: string, scope: "admin" | "rw" = "admin") =>
    createToken(app.db, getUserByName(app.db, name)!.id, "t", scope).token;
  const call = async (tok: string) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "snapshot_now", arguments: {} } }),
    });
    const body = (await res.json()) as any;
    return { error: body.result.isError === true, text: body.result.content[0].text as string };
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "forge-mcp-snap-"));
    app = createApp({ dataDir: root, port: 0 });
    for (const [username, isAdmin] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@x.test`, password: "a-long-snapshot-passphrase", isAdmin });
      if (!made.ok) throw new Error(username);
    }
    servers = await serve(app);
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    await svc?.stop();
    app.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("with no store, it says the page's sentence", async () => {
    const r = await call(token("alice"));
    expect(r.text).toContain("This forge has nowhere to put a snapshot.");
  });

  test("a non-admin is refused and nothing is taken", async () => {
    const r = await call(token("bob"));
    expect(r.error).toBe(true);
    expect(r.text).toContain("no such tool here");
  });

  test("an admin with a local store takes one, and it is listed after", async () => {
    svc = startSnapshots(app, dirStore(join(root, "store")), { version: "t", nightly: false });
    const weak = await call(token("alice", "rw"));
    expect(weak.error).toBe(true);
    expect(weak.text).toContain("admin-scope token");
    expect(await svc.list()).toEqual([]);
    const r = await call(token("alice"));
    expect(r.error).toBe(false);
    const out = JSON.parse(r.text);
    expect(out.says).toContain(`Snapshot ${out.name} taken`);
    expect(typeof out.bytes).toBe("number");
    expect((await svc.list()).map((m) => m.name)).toContain(out.name);
  });
});
