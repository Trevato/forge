/** MCP `restore_drill`: the Backups page's drill button, from a harness. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import type { DrillResult } from "../src/snapshot/drill.ts";
import { lastDrill } from "../src/snapshot/drills.ts";
import { startSnapshots, type SnapshotsHandle } from "../src/snapshot/service.ts";
import { dirStore } from "../src/snapshot/store.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("MCP restore_drill", () => {
  let root = "";
  let app: App;
  let servers: Servers;
  let svc: SnapshotsHandle | undefined;

  let mode: "green" | "red" | "throw" = "green";
  const call = async (token: string) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "restore_drill", arguments: {} } }),
    });
    const body = (await res.json()) as any;
    return { error: body.result?.isError === true, rpc: body.error?.message as string | undefined, text: (body.result?.content?.[0]?.text ?? "") as string };
  };
  const token = (name: string, scope: "ro" | "admin" = "admin") => createToken(app.db, getUserByName(app.db, name)!.id, "t", scope).token;

  const boot = async (withStore: boolean) => {
    mode = "green";
    root = mkdtempSync(join(tmpdir(), "forge-mcp-drill-"));
    app = createApp({ dataDir: root, port: 0 });
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
      const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@x.test`, password: "a-good-passphrase", adminIfFirst });
      if (!u.ok) throw new Error(username);
    }
    if (withStore)
      svc = startSnapshots(app, dirStore(join(root, "store")), {
        version: "t",
        nightly: false,
        drill: async (): Promise<DrillResult> => {
          if (mode === "throw") throw new Error("store went away");
          const green = mode === "green";
          return {
            at: new Date().toISOString(),
            snapshotId: "snap-1",
            ms: 5,
            counts: { repositories: 1, issues: 0, users: 2, pulls: 0, apps: 0 },
            health: green ? "ok" : "unreached",
            verdict: green ? "green" : "red",
            failedStep: green ? null : "unseal",
            phases: [],
            budgetMs: 0,
            reason: green ? null : "a sealed value does not open",
          };
        },
      });
    servers = await serve(app);
  };

  afterEach(async () => {
    servers.stop();
    await svc?.stop();
    svc = undefined;
    app.close();
    rmSync(root, { recursive: true, force: true });
  });

  describe("without a store", () => {
    beforeEach(() => boot(false));
    test("says there is nothing to drill", async () => {
      const r = await call(token("alice"));
      expect(r.error).toBe(false);
      expect(JSON.parse(r.text)).toEqual({ verdict: "none", says: "This forge has no snapshots to drill." });
    });
    test("a non-admin is refused", async () => {
      const r = await call(token("bob"));
      expect(r.rpc).toBe("no tool named restore_drill");
      expect(r.text).toBe("");
    });
  });

  describe("with a local store", () => {
    beforeEach(() => boot(true));
    test("an admin gets a verdict, and the page reads the kept drill", async () => {
      const r = await call(token("alice"));
      expect(JSON.parse(r.text)).toEqual({ verdict: "green", says: "The drill restored green." });
      expect(lastDrill(app.db)?.snapshotId).toBe("snap-1");
    });
    test("a red drill names its failed step", async () => {
      mode = "red";
      const r = await call(token("alice"));
      expect(r.error).toBe(false);
      expect(JSON.parse(r.text)).toEqual({ verdict: "red", failedStep: "unseal", says: "The drill failed at unseal." });
    });
    test("a drill that throws is kept as a red drill, not as nothing (#8742)", async () => {
      mode = "throw";
      const r = await call(token("alice"));
      expect(r.error).toBe(false);
      expect(JSON.parse(r.text)).toEqual({ verdict: "red", failedStep: "restore", says: "The drill failed at restore." });
      expect(lastDrill(app.db)?.reason).toContain("store went away");
    });
    test("an admin's read-only token is refused and nothing runs", async () => {
      const r = await call(token("alice", "ro"));
      expect(r.error).toBe(true);
      expect(r.text).toContain("this token may read, not act");
      expect(lastDrill(app.db)).toBeUndefined();
    });
  });
});
