/** A release path outside the forge leaves the release tick's heartbeat (#11674) through POST /api/v1/release/heartbeat. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { KEPT, lastBeat, recordBeat, stepWithBeat } from "../src/keeper/beat.ts";
import { keeperAnswer } from "../src/keeper/landed.ts";

describe("release heartbeat", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin: string;
  let bob: string;
  let aliceRw: string;
  const post = (token: string, data: unknown) =>
    fetch(`${servers.url}/api/v1/release/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(data),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-heartbeat-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const u = await createUser(app.db, {
        origin: "seed", trusted: true, username,
        email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first,
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    const alice = await mk("alice", true);
    admin = createToken(app.db, alice.id, "a", "admin").token;
    aliceRw = createToken(app.db, alice.id, "a-rw", "rw").token;
    bob = createToken(app.db, (await mk("bob")).id, "b", "admin").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("no tick yet reads null", () => {
    expect(keeperAnswer(app.db).heartbeat).toBeNull();
  });

  test("a posted heartbeat replaces the keeper's own and is what GET /api/v1/keeper answers", async () => {
    recordBeat(app.db, "skipped", "main has not moved", new Date());
    const res = await post(admin, { outcome: "failed", reason: "  the workflow lost its runner  " });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ outcome: "failed", reason: "the workflow lost its runner" });
    const last = keeperAnswer(app.db).heartbeat!;
    expect(last).toMatchObject({ outcome: "failed", reason: "the workflow lost its runner", silent: false });
    const got: any = await (await fetch(`${servers.url}/api/v1/keeper`, { headers: { authorization: `Bearer ${admin}` } })).json();
    expect(got.heartbeat).toMatchObject({ at: last.at, outcome: "failed", reason: last.reason });
  });

  test("a non-admin is refused as /releases refuses them, and nothing is written", async () => {
    const before = lastBeat(app.db);
    expect((await post(bob, { outcome: "cut", reason: "sneaky" })).status).toBe(403);
    expect(lastBeat(app.db)).toEqual(before);
  });

  test("no token is a 401, and an admin's token without the admin scope is a 403; nothing is written", async () => {
    const before = lastBeat(app.db);
    const anon = await fetch(`${servers.url}/api/v1/release/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "cut", reason: "anon" }),
    });
    expect(anon.status).toBe(401);
    expect((await post(aliceRw, { outcome: "cut", reason: "rw" })).status).toBe(403);
    expect(lastBeat(app.db)).toEqual(before);
  });

  test("a reason carrying a control character is a 422", async () => {
    expect((await post(admin, { outcome: "failed", reason: "red\u001b[2Jwiped" })).status).toBe(422);
    expect((await post(admin, { outcome: "failed", reason: "two\nlines" })).status).toBe(422);
  });

  test("a bad outcome or reason is a 422", async () => {
    expect((await post(admin, { outcome: "maybe", reason: "x" })).status).toBe(422);
    expect((await post(admin, { outcome: "cut", reason: "x".repeat(301) })).status).toBe(422);
    expect((await post(admin, { outcome: "cut" })).status).toBe(422);
  });

  test("each tick leaves a row: two ticks leave two, the 51st drops the oldest (#11794)", async () => {
    app.db.query("DELETE FROM keeper_beat_tick").run();
    const rows = () => app.db.query<{ at: string; outcome: string; reason: string }, []>(
      "SELECT at, outcome, reason FROM keeper_beat_tick ORDER BY id",
    ).all();
    const tick = (n: number) =>
      stepWithBeat(app.db, async () => ({ line: `tick ${n}`, outcome: "skipped" }), () => new Date(Date.UTC(2026, 10, 12, 0, n)));
    await tick(1);
    await tick(2);
    expect(rows()).toEqual([
      { at: "2026-11-12T00:01:00.000Z", outcome: "skipped", reason: "tick 1" },
      { at: "2026-11-12T00:02:00.000Z", outcome: "skipped", reason: "tick 2" },
    ]);
    for (let n = 3; n <= KEPT + 1; n++) await tick(n);
    const kept = rows();
    expect(KEPT).toBe(50);
    expect(kept).toHaveLength(50);
    expect(kept[0]!.reason).toBe("tick 2");
    expect(kept[49]!.reason).toBe("tick 51");
    expect(lastBeat(app.db)?.reason).toBe("tick 51");
  });
});
