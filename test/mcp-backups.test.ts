/** MCP `backups`: the Backups page's destination, snapshots and mirror, for an admin. */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { scrubReason } from "../src/snapshot/destination.ts";
import { dirStore } from "../src/snapshot/store.ts";
import { takeSnapshot } from "../src/snapshot/snapshot.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASS = "a-long-backups-passphrase";

describe("MCP backups", () => {
  let dataDir = "";
  let snapDir = "";
  let app: App;
  let servers: Servers;
  let admin = "";
  let plain = "";
  const saved = process.env["FORGE_SNAPSHOT_DIR"];

  const call = async (token: string) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "backups", arguments: {} } }),
    });
    const body = (await res.json()) as any;
    if (body.error) return { error: true, text: body.error.message as string };
    return { error: body.result.isError === true, text: body.result.content[0].text as string };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-backups-"));
    snapDir = await mkdtemp(join(tmpdir(), "forge-mcp-backups-snap-"));
    delete process.env["FORGE_SNAPSHOT_DIR"];
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made: Record<string, any> = {};
    for (const [username, isAdmin] of [["alice", true], ["bob", false]] as const) {
      made[username] = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@x.test`, password: PASS, isAdmin });
      if (!made[username].ok) throw new Error(username);
    }
    admin = createToken(app.db, made["alice"].value.id, "t", "ro").token;
    plain = createToken(app.db, made["bob"].value.id, "t", "ro").token;
  }, 30_000);

  afterAll(async () => {
    if (saved === undefined) delete process.env["FORGE_SNAPSHOT_DIR"];
    else process.env["FORGE_SNAPSHOT_DIR"] = saved;
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(snapDir, { recursive: true, force: true });
  });

  test("an admin with no destination gets the page's sentence", async () => {
    const r = await call(admin);
    expect(r.error).toBe(false);
    const out = JSON.parse(r.text);
    expect(out.destination).toBeNull();
    expect(out.says).toBe("nothing — no snapshots are taken");
    expect(out.snapshots).toEqual([]);
  });

  test("an admin with a local destination and one snapshot sees it", async () => {
    process.env["FORGE_SNAPSHOT_DIR"] = snapDir;
    const m = await takeSnapshot({ db: app.db, dataDir: app.config.dataDir, reposRoot: app.reposRoot, version: "t" }, dirStore(snapDir));
    const out = JSON.parse((await call(admin)).text);
    expect(out.destination).toEqual({ kind: "dir", place: snapDir });
    expect(out.snapshots).toHaveLength(1);
    expect(out.snapshots[0].key).toBe(m.name);
    expect(out.snapshots[0].bytes).toBe(m.bytes);
    expect(out.mirror.place).toBeNull();
  });

  test("a listing that fails is a short sentence with no key in it", async () => {
    const secret = "SECRETKEY-do-not-leak";
    // The store's client fails at once and echoes both keys, as a real one may:
    // no socket, no proxy, no clock — the verdict rests on our code alone.
    const failing = spyOn(Bun.S3Client.prototype, "list").mockRejectedValue(new Error(`S3Error: ${secret} ACCESSKEY-do-not-leak`));
    const env = { S3_ENDPOINT: "http://store.invalid", S3_BUCKET: "b", S3_ACCESS_KEY: "ACCESSKEY-do-not-leak", S3_SECRET_KEY: secret };
    delete process.env["FORGE_SNAPSHOT_DIR"];
    Object.assign(process.env, env);
    try {
      const out = JSON.parse((await call(admin)).text);
      expect(out.destination.kind).toBe("env");
      expect(out.snapshots).toEqual([]);
      expect(typeof out.listing).toBe("string");
      expect(out.listing.length).toBeLessThanOrEqual(200);
      // One try, not the store's five with 7.5 s of backoff between them.
      expect(out.listing).toContain("after 1 attempt:");
      expect(failing).toHaveBeenCalledTimes(1);
      expect(out.listing).not.toContain(secret);
      expect(out.listing).not.toContain("ACCESSKEY-do-not-leak");
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
      process.env["FORGE_SNAPSHOT_DIR"] = snapDir;
      failing.mockRestore();
    }
  }, 20_000);

  test("scrubReason strikes both keys and caps the length", () => {
    const t = { endpoint: "e", bucket: "b", accessKeyId: "AKID", secretAccessKey: "SKEY" };
    const out = scrubReason(t, new Error(`bad AKID and SKEY ${"x".repeat(300)}`));
    expect(out).not.toContain("AKID");
    expect(out).not.toContain("SKEY");
    expect(out.length).toBe(200);
  });

  test("a non-admin is refused", async () => {
    const r = await call(plain);
    expect(r.error).toBe(true);
    expect(r.text).not.toContain(snapDir);
    expect(r.text).toContain("no tool named backups");
  });

  test("tools/list shows backups to an admin and hides it from a non-admin", async () => {
    const names = async (token: string) => {
      const res = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      return ((await res.json()) as any).result.tools.map((t: { name: string }) => t.name) as string[];
    };
    expect(await names(admin)).toContain("backups");
    expect(await names(plain)).not.toContain("backups");
  });
});
