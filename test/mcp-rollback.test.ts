/** `rollback` over MCP: planned first, an admin's with an admin-scope token; applying stops where the forge does not swap itself. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { releaseDir } from "../src/release/checkout.ts";
import { recordRelease } from "../src/release/record.ts";

const LIVE = "a".repeat(40);
const KEPT = "b".repeat(40);
const OLD = "c".repeat(40);
const GONE = "d".repeat(40);
const TWIN1 = "1234567" + "0".repeat(33);
const TWIN2 = "1234567" + "f".repeat(33);

describe("MCP rollback", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin: string;
  let rw: string;
  let bob: string;
  let robot: string;
  let n = 1;
  const saved = process.env["FORGE_COMMIT"];

  const call = async (token: string, args: Record<string, unknown>) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: n++, method: "tools/call", params: { name: "rollback", arguments: args } }),
    });
    const body: any = await res.json();
    if (body.error !== undefined) return { error: String(body.error.message) };
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  const keep = (sha: string, migrations: number) => {
    const dir = releaseDir(dataDir, sha);
    mkdirSync(join(dir, "src", "core"), { recursive: true });
    writeFileSync(join(dir, "src", "core", "schema.ts"), `export const migrations = ${JSON.stringify(Array.from({ length: migrations }, () => "SELECT 1"))};\n`);
  };

  beforeAll(async () => {
    process.env["FORGE_COMMIT"] = LIVE;
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-rollback-"));
    app = createApp({ dataDir, port: 0, forgeRepo: "alice/forge" });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    const alice = await mk("alice", true);
    const b = await mk("bob");
    admin = createToken(app.db, alice.id, "a", "admin").token;
    rw = createToken(app.db, alice.id, "w", "rw").token;
    bob = createToken(app.db, b.id, "b", "admin").token;
    const r = await mk("robot");
    app.db.query("UPDATE user SET is_agent = 1, is_admin = 1 WHERE id = ?").run(r.id);
    robot = createToken(app.db, r.id, "r", "admin").token;
    const made = await createRepo(app, alice, { name: "forge", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    for (const sha of [OLD, KEPT, LIVE]) recordRelease(app.db, { sha, repoId: made.value.id, pullNumber: null, ok: true, line: "ok" });
    recordRelease(app.db, { sha: GONE, repoId: made.value.id, pullNumber: null, ok: true, line: "ok" });
    for (const sha of [TWIN1, TWIN2]) {
      recordRelease(app.db, { sha, repoId: made.value.id, pullNumber: null, ok: true, line: "ok" });
      keep(sha, 10_000);
    }
    keep(KEPT, 10_000);
    keep(OLD, 1);
    keep(LIVE, 10_000);
  }, 30_000);

  afterAll(async () => {
    if (saved === undefined) delete process.env["FORGE_COMMIT"];
    else process.env["FORGE_COMMIT"] = saved;
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the plan says from which to which and changes nothing", async () => {
    const r = await call(admin, { sha: KEPT.slice(0, 12) });
    expect(r.value).toMatchObject({ dryRun: true, from: "a".repeat(12), to: "b".repeat(12), allowed: true });
    expect((await call(admin, { sha: KEPT, dryRun: true })).value.dryRun).toBe(true);
  });

  test("a non-admin and an rw token are refused", async () => {
    expect((await call(bob, { sha: KEPT })).error).toContain("rollback");
    expect((await call(rw, { sha: KEPT })).error).toBeDefined();
  });

  test("an unknown or not-kept sha is not_found", async () => {
    expect((await call(admin, { sha: "e".repeat(40) })).error).toContain("no kept release");
    expect((await call(admin, { sha: GONE })).error).toContain("no kept release");
  });

  test("an agent holding an admin-scope token is refused", async () => {
    expect((await call(robot, { sha: KEPT })).error).toContain("not an agent");
    expect((await call(robot, { sha: KEPT, dryRun: false })).error).toContain("not an agent");
    // The robot is a site admin, so it can write alice/forge: only its kind refuses it.
    app.db.query("UPDATE user SET is_agent = 0 WHERE username = 'robot'").run();
    try {
      expect((await call(robot, { sha: KEPT })).value).toMatchObject({ dryRun: true, to: "b".repeat(12) });
    } finally {
      app.db.query("UPDATE user SET is_agent = 1 WHERE username = 'robot'").run();
    }
  });

  test("the running release is refused", async () => {
    expect((await call(admin, { sha: LIVE })).error).toContain("the one running");
  });

  test("a prefix two releases share is invalid, and nothing is applied", async () => {
    expect((await call(admin, { sha: "1234567", dryRun: false })).error).toContain("more than one release");
    expect((await call(admin, { sha: "12345670" })).value.to).toBe(TWIN1.slice(0, 12));
  });

  test("a malformed sha is invalid, a schema-behind release is refused", async () => {
    expect((await call(admin, { sha: "xyz" })).error).toContain("hex");
    expect((await call(admin, { sha: OLD })).error).toContain("down-migration");
  });

  test("applying on a forge that does not swap itself says so", async () => {
    const r = await call(admin, { sha: KEPT, dryRun: false });
    expect(r.error).toContain("FORGE_SELF_SWAP");
  });
});
