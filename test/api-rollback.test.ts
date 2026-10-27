/**
 * Rolling back over the API (#7217): a plan by default that moves nothing,
 * an apply that goes through `rollBackTo` and its refusals, and the doors:
 * a person who may not administer is `not_admin`, a token without admin
 * scope, an agent, or anyone at all when FORGE_REPO names no repository is
 * `forbidden`, an unknown or not-kept sha is `not_found`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { migrations } from "../src/core/schema.ts";
import { createToken } from "../src/core/tokens.ts";
import { markVerified } from "../src/core/verify.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { releaseDir } from "../src/release/checkout.ts";
import { recordRelease } from "../src/release/record.ts";
import { handover } from "../src/release/swap.ts";
import { ALREADY_LIVE, NOT_ROLLABLE } from "../src/release/words.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();
// The plan imports a kept release's schema module: room on a loaded machine.
setDefaultTimeout(30_000);

const LIVE = "a".repeat(40);
const KEPT = "b".repeat(40);
const PRUNED = "c".repeat(40);
const BEHIND = "d".repeat(40);

describe("POST /api/v1/admin/releases/:sha/rollback", () => {
  let root = "";
  let app: App;
  let servers: Servers;
  let admin = "";
  const was = process.env["FORGE_COMMIT"];

  const addUser = (username: string, isAdmin: boolean): string => {
    const id = `u-${username}`;
    app.db
      .query("INSERT INTO user (id, username, email, password_hash, is_admin) VALUES (?1, ?2, ?3, 'x', ?4)")
      .run(id, username, `${username}@forge.local`, isAdmin ? 1 : 0);
    markVerified(app.db, id, new Date().toISOString());
    return id;
  };
  const keep = (sha: string, schemaLength: number): void => {
    const dir = releaseDir(root, sha);
    mkdirSync(join(dir, "src", "core"), { recursive: true });
    writeFileSync(
      join(dir, "src", "core", "schema.ts"),
      "export const migrations = " + JSON.stringify(Array(schemaLength).fill("SELECT 1")) + ";\n",
    );
  };
  const roll = (sha: string, token: string, input?: unknown) =>
    fetch(`${servers.url}/api/v1/admin/releases/${sha}/rollback`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
  // Nothing moves: this process is never told to drain.
  let drained = 0;
  const hadDrain = handover.drain;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "forge-api-rollback-"));
    app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
    addUser("alice", true);
    addUser("bob", false);
    const made = await createRepo(app, { id: "u-alice", username: "alice" } as never, { name: "forge" });
    if (!made.ok) throw new Error(made.error);
    const repoId = app.db.query<{ id: string }, []>("SELECT id FROM repo WHERE name='forge'").get()!.id;
    for (const sha of [PRUNED, BEHIND, KEPT, LIVE])
      recordRelease(app.db, { sha, repoId, pullNumber: null, ok: true, line: "ok" });
    keep(LIVE, migrations.length);
    keep(KEPT, migrations.length + 1);
    keep(BEHIND, 1);
    servers = await serve(app);
    admin = createToken(app.db, "u-alice", "t", "admin").token;
    handover.drain = () => drained++;
  }, 60_000);
  beforeEach(() => {
    process.env["FORGE_COMMIT"] = LIVE;
  });
  afterAll(() => {
    if (hadDrain === undefined) delete handover.drain;
    else handover.drain = hadDrain;
    if (was === undefined) delete process.env["FORGE_COMMIT"];
    else process.env["FORGE_COMMIT"] = was;
    servers.stop();
    app.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the plan is the default: from the live release to the kept one, allowed, and nothing moves", async () => {
    const before = app.db.query("SELECT COUNT(*) AS n FROM release").get();
    for (const input of [undefined, {}, { dryRun: true }]) {
      const res = await roll(KEPT, admin, input);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ dryRun: true, from: LIVE, to: KEPT, allowed: true });
    }
    expect(app.db.query("SELECT COUNT(*) AS n FROM release").get()).toEqual(before);
    expect(drained).toBe(0);
  });

  test("the plan says why the page offers no rollback: the live one, a schema behind", async () => {
    expect(await (await roll(LIVE, admin)).json()).toEqual({
      dryRun: true, from: LIVE, to: LIVE, allowed: false, message: ALREADY_LIVE,
    });
    expect(await (await roll(BEHIND, admin)).json()).toEqual({
      dryRun: true, from: LIVE, to: BEHIND, allowed: false, message: NOT_ROLLABLE,
    });
  });

  test("applying a release the live schema forbids is 409 with the page's words", async () => {
    const res = await roll(BEHIND, admin, { dryRun: false });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_rollable", message: NOT_ROLLABLE });
  });

  test("applying goes through rollBackTo: with self-swap off it refuses and nothing moves", async () => {
    const res = await roll(KEPT, admin, { dryRun: false });
    expect(res.status).toBe(409);
    const out = (await res.json()) as { error: string; message: string };
    expect(out.error).toBe("not_rolled_back");
    expect(out.message).toContain("FORGE_SELF_SWAP");
    expect(drained).toBe(0);
  });

  test("a member is not_admin and an rw token of an admin is forbidden", async () => {
    const member = createToken(app.db, "u-bob", "t", "admin").token;
    const asMember = await roll(KEPT, member);
    expect(asMember.status).toBe(403);
    expect(((await asMember.json()) as { error: string }).error).toBe("not_admin");
    for (const scope of ["rw", "ro"] as const) {
      const res = await roll(KEPT, createToken(app.db, "u-alice", "t", scope).token, { dryRun: false });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("forbidden");
    }
  });

  // `mayRollBack` is this route's own door past the admin gate and the scope:
  // an agent never rolls back, and nobody does when FORGE_REPO names no
  // repository here. (A person past the gate is a site admin, who writes
  // every repository, so there is no admin who does not write FORGE_REPO.)
  test("an admin-scope agent is forbidden on the plan and the apply, and nothing drains", async () => {
    const agent = addUser("crew1", true);
    app.db.query("UPDATE user SET is_agent = 1 WHERE id = ?").run(agent);
    const token = createToken(app.db, agent, "t", "admin").token;
    for (const input of [undefined, { dryRun: false }]) {
      const res = await roll(KEPT, token, input);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("forbidden");
    }
    expect(drained).toBe(0);
  });

  test("an admin is forbidden when FORGE_REPO names no repository here, and nothing drains", async () => {
    const config = app.config as { forgeRepo: string | undefined };
    const named = config.forgeRepo;
    config.forgeRepo = "nobody/missing";
    try {
      for (const input of [undefined, { dryRun: false }]) {
        const res = await roll(KEPT, admin, input);
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: string }).error).toBe("forbidden");
      }
    } finally {
      config.forgeRepo = named;
    }
    expect(drained).toBe(0);
  });

  test("the plan leaves out from when nothing says which commit is live", async () => {
    const app = process.env["FORGE_APP_COMMIT"];
    delete process.env["FORGE_COMMIT"];
    delete process.env["FORGE_APP_COMMIT"];
    try {
      const res = await roll(KEPT, admin);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ dryRun: true, to: KEPT, allowed: true });
    } finally {
      if (app !== undefined) process.env["FORGE_APP_COMMIT"] = app;
    }
  });

  test("no token at all is unauthorized", async () => {
    const res = await fetch(`${servers.url}/api/v1/admin/releases/${KEPT}/rollback`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("an unknown, malformed or no-longer-kept sha is not_found", async () => {
    for (const sha of ["e".repeat(40), "not-a-sha", PRUNED]) {
      const res = await roll(sha, admin);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe("not_found");
    }
  });

  test("a dryRun that is not a boolean is refused", async () => {
    const res = await roll(KEPT, admin, { dryRun: "no" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("invalid");
  });
});
