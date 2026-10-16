/**
 * The drill on the Backups page: an admin's POST runs a (stubbed) drill and
 * keeps it as a row, and the page shows the last one in a line; a non-admin
 * gets 403 and nothing runs; a cross-origin POST is refused.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import type { DrillResult } from "../src/snapshot/drill.ts";
import { startSnapshots, type SnapshotsHandle } from "../src/snapshot/service.ts";
import { dirStore } from "../src/snapshot/store.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("the drill on the Backups page", () => {
  let root = "";
  let app: App;
  let svc: SnapshotsHandle;
  let servers: Servers;
  let ran = 0;
  let gate: Promise<void> | undefined;
  let verdict: "green" | "red" = "green";

  const login = async (username: string, password: string) => {
    const r = await fetch(`${servers.url}/signin`, {
      method: "POST",
      headers: { origin: servers.url },
      body: new URLSearchParams({ username, password }),
      redirect: "manual",
    });
    return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "forge-drillpage-"));
    app = createApp({ dataDir: root, port: 0 });
    for (const [username, password, adminIfFirst] of [
      ["alice", "a-good-passphrase", true],
      ["bob", "another-good-passphrase", false],
    ] as const) {
      const u = await createUser(app.db, {
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password,
        adminIfFirst,
      });
      if (!u.ok) throw new Error(u.error);
    }
    svc = startSnapshots(app, dirStore(join(root, "store")), {
      version: "t",
      nightly: false,
      drill: async (): Promise<DrillResult> => {
        ran++;
        await gate;
        return {
          at: new Date().toISOString(),
          snapshotId: "snap-stub-1",
          ms: 1234,
          counts: { repositories: 7, issues: 42, users: 0, pulls: 0, apps: 0 },
          health: verdict === "green" ? "ok" : "unreached",
          verdict,
          failedStep: verdict === "green" ? null : "unseal",
          reason: verdict === "green" ? null : "a sealed value does not open",
        };
      },
    });
    servers = await serve(app);
  });
  afterAll(async () => {
    servers.stop();
    await svc.stop();
    app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const post = (cookie: string, origin = servers.url) =>
    fetch(`${servers.url}/settings/backups/drill`, {
      method: "POST",
      headers: { cookie, origin },
      redirect: "manual",
    });
  const page = async (cookie: string) =>
    (await fetch(`${servers.url}/settings/backups`, { headers: { cookie } })).text();

  test("an admin runs a drill and the line shows it", async () => {
    const cookie = await login("alice", "a-good-passphrase");
    const before = await page(cookie);
    expect(before).toContain("No restore drill has run yet");
    expect(before).toContain("Run a drill");
    expect((await post(cookie)).status).toBe(303);
    expect(ran).toBe(1);
    const html = await page(cookie);
    expect(html).toContain("snap-stub-1");
    expect(html).toContain("0 users, 7 repositories, 42 issues, 0 pulls, 0 apps");
    expect(html).toContain("1234 ms");
    expect(app.db.query("SELECT count(*) AS n FROM drill").get()).toEqual({ n: 1 });
  });

  test("a red drill names the failing step", async () => {
    const cookie = await login("alice", "a-good-passphrase");
    verdict = "red";
    await post(cookie);
    const html = await page(cookie);
    expect(html).toContain("failed at");
    expect(html).toContain("unseal");
    expect(app.db.query("SELECT count(*) AS n FROM drill").get()).toEqual({ n: 2 });
  });

  test("a non-admin is refused, and so is a cross-origin post", async () => {
    const before = ran;
    const bob = await login("bob", "another-good-passphrase");
    expect((await post(bob)).status).toBe(403);
    const alice = await login("alice", "a-good-passphrase");
    expect((await post(alice, "https://evil.example")).status).toBeGreaterThanOrEqual(400);
    expect(ran).toBe(before);
  });

  test("two drills at once are one restore", async () => {
    const alice = await login("alice", "a-good-passphrase");
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    const before = ran;
    const rows = () =>
      (app.db.query("SELECT count(*) AS n FROM drill").get() as { n: number }).n;
    const rowsBefore = rows();
    const both = Promise.all([post(alice), post(alice)]);
    await Bun.sleep(200);
    release();
    const [a, b] = await both;
    gate = undefined;
    expect([a.status, b.status]).toEqual([303, 303]);
    expect(ran - before).toBe(1);
    expect(rows() - rowsBefore).toBe(1);
  });
});

import { recoverySentence, type Recovery } from "../src/web/pages/backups.ts";

describe("the recovery line", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const good: Recovery = {
    reachable: true,
    newest: { finishedAt: hoursAgo(5), key: "wrapped" },
    drill: { at: hoursAgo(24), verdict: "green" },
    now,
  };
  const say = (over: Partial<Recovery>) => recoverySentence({ ...good, ...over });

  test("all four facts hold", () => {
    expect(say({})).toBe("Recoverable now");
  });
  test("the store is unreachable", () => {
    expect(say({ reachable: false })).toBe(
      "Not recoverable now: the snapshot store cannot be reached",
    );
  });
  test("the newest snapshot is old", () => {
    expect(say({ newest: { finishedAt: hoursAgo(72), key: "wrapped" } })).toBe(
      "Not recoverable now: the newest snapshot is 3 days old",
    );
    expect(say({ newest: undefined })).toBe("Not recoverable now: there is no snapshot yet");
  });
  test("the key is not carried", () => {
    expect(say({ newest: { finishedAt: hoursAgo(5), key: "none" } })).toBe(
      "Not recoverable now: the newest snapshot does not carry a wrapped key",
    );
  });
  test("the drill is missing, red or old", () => {
    expect(say({ drill: undefined })).toBe("Not recoverable now: no restore drill has run yet");
    expect(say({ drill: { at: hoursAgo(1), verdict: "red" } })).toBe(
      "Not recoverable now: the last restore drill failed",
    );
    expect(say({ drill: { at: hoursAgo(24 * 9), verdict: "green" } })).toBe(
      "Not recoverable now: the last restore drill is 9 days old",
    );
  });
  test("the first failing fact wins", () => {
    expect(say({ reachable: false, drill: undefined })).toContain("cannot be reached");
  });
});

describe("the recovery line on the page", () => {
  test("is the first thing on the page, escaped", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-recov-"));
    const app = createApp({ dataDir: root, port: 0 });
    const u = await createUser(app.db, {
      trusted: true, username: "alice", email: "a@forge.local",
      password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    const servers = await serve(app);
    try {
      const r = await fetch(`${servers.url}/signin`, {
        method: "POST", headers: { origin: servers.url },
        body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
        redirect: "manual",
      });
      const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
      const html = await (await fetch(`${servers.url}/settings/backups`, { headers: { cookie } })).text();
      expect(html).toContain("Not recoverable now: no snapshot store is set");
    } finally {
      servers.stop();
      app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
