/**
 * A backup moving tells the outbox (`backup.started`, `.progress`,
 * `.finished`), and /backups patches from them: no meta refresh while one
 * moves, a region that names its events and its own address, and events
 * only an admin's stream carries.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { listEvents } from "../src/core/events.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { startSnapshots, type SnapshotsHandle } from "../src/snapshot/service.ts";
import { dirStore } from "../src/snapshot/store.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let svc: SnapshotsHandle;
let servers: Servers;
let release: () => void = () => {};
let gate: Promise<void> | undefined;
let reached: () => void = () => {};
let atPut = new Promise<void>((r) => (reached = r));

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
  root = mkdtempSync(join(tmpdir(), "forge-backups-live-"));
  app = createApp({ dataDir: root, port: 0 });
  for (const [username, password, adminIfFirst] of [
    ["alice", "a-good-passphrase", true],
    ["bob", "another-good-passphrase", false],
  ] as const) {
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password,
      adminIfFirst,
    });
    if (!u.ok) throw new Error(u.error);
  }
  const inner = dirStore(join(root, "store"));
  // Holds the first put until the test lets go, so the snapshot is moving.
  const store = {
    ...inner,
    async put(key: string, body: Uint8Array | string) {
      reached();
      await gate;
      return inner.put(key, body);
    },
  };
  svc = startSnapshots(app, store, { version: "t", nightly: false });
  servers = await serve(app);
});
afterAll(async () => {
  release();
  servers.stop();
  await svc.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const kinds = () =>
  listEvents(app.db, {})
    .map((e) => e.kind)
    .filter((k) => k.startsWith("backup."))
    .reverse();

test("a backup moving emits its events, and /backups does not reload itself meanwhile", async () => {
  gate = new Promise<void>((r) => (release = r));
  atPut = new Promise<void>((r) => (reached = r));
  const done = svc.now();
  await atPut;
  expect(kinds()).toEqual(["backup.started"]);

  const alice = await login("alice", "a-good-passphrase");
  const moving = await fetch(`${servers.url}/settings/backups`, { headers: { cookie: alice } });
  const text = await moving.text();
  expect(text).not.toContain('http-equiv="refresh"');
  expect(text).toContain("A snapshot is being taken");
  expect(text).not.toMatch(/class="[^"]*\bbackups-/);
  expect(text).toContain('id="backups-live"');
  expect(text).toContain('data-live="backup.*"');
  expect(text).toContain('data-live-src="/settings/backups/live"');
  const part = await fetch(`${servers.url}/settings/backups/live`, { headers: { cookie: alice } });
  expect(part.status).toBe(200);
  expect(await part.text()).toContain('id="backups-live"');

  release();
  await done;
  const seen = kinds();
  expect(seen[0]).toBe("backup.started");
  expect(seen.at(-1)).toBe("backup.finished");
  const finished = listEvents(app.db, { kind: "backup.finished" })[0]!;
  expect(finished.payload).toEqual({ ok: true });
  expect(finished.repoId).toBeNull();
});

test("a moving snapshot tells its progress, no oftener than the throttle", async () => {
  const inner = dirStore(join(root, "store-slow"));
  const slow = {
    ...inner,
    async put(key: string, body: Uint8Array | string) {
      await Bun.sleep(200);
      return inner.put(key, body);
    },
  };
  const mine = startSnapshots(app, slow, { version: "t", nightly: false, progressEventMs: 100 });
  const from = listEvents(app.db, {})[0]?.id ?? "";
  await mine.now();
  await mine.stop();
  const progress = listEvents(app.db, { kind: "backup.progress", afterId: from, limit: 500 }).reverse();
  expect(progress.length).toBeGreaterThanOrEqual(1);
  for (const e of progress) {
    expect(typeof e.payload["objects"]).toBe("number");
    expect(typeof e.payload["bytes"]).toBe("number");
    expect(e.repoId).toBeNull();
  }
  for (let i = 1; i < progress.length; i++)
    expect(Date.parse(progress[i]!.createdAt) - Date.parse(progress[i - 1]!.createdAt)).toBeGreaterThanOrEqual(90);
});

test("a failed snapshot ends in backup.finished {ok:false}, and the live part shows it", async () => {
  const inner = dirStore(join(root, "store-bad"));
  const bad = {
    ...inner,
    async put(): Promise<void> {
      throw new Error("the bucket said no");
    },
  };
  const mine = startSnapshots(app, bad, { version: "t", nightly: false });
  await expect(mine.now()).rejects.toThrow();
  const seen = kinds();
  expect(seen.at(-1)).toBe("backup.finished");
  expect(listEvents(app.db, { kind: "backup.finished" })[0]!.payload).toEqual({ ok: false });
  const alice = await login("alice", "a-good-passphrase");
  const part = await fetch(`${servers.url}/settings/backups/live`, { headers: { cookie: alice } });
  const text = await part.text();
  expect(text).toContain("The last snapshot failed");
  expect(text).toContain("the bucket said no");
  await mine.stop();
});

test("the live part and the stream are an admin's alone", async () => {
  const bob = await login("bob", "another-good-passphrase");
  const part = await fetch(`${servers.url}/settings/backups/live`, { headers: { cookie: bob } });
  expect(part.status).toBe(404);
  expect((await fetch(`${servers.url}/settings/backups/live`)).status).toBeGreaterThanOrEqual(300);

  const frames = async (cookie: string, mustArrive: boolean): Promise<string> => {
    const ac = new AbortController();
    const res = await fetch(`${servers.url}/events`, { headers: { cookie }, signal: ac.signal });
    const reader = res.body!.getReader();
    // Let the stream subscribe, then move a backup's worth of events.
    await Bun.sleep(50);
    app.bus.append({ kind: "backup.started" });
    await Bun.sleep(100);
    let got = "";
    const until = Date.now() + 500;
    while (Date.now() < until && !got.includes("backup.")) {
      const { value } = await Promise.race([
        reader.read(),
        Bun.sleep(200).then(() => ({ value: undefined })),
      ]);
      if (value) got += new TextDecoder().decode(value);
    }
    if (mustArrive && !got.includes("backup.")) throw new Error(`never came: still waiting while !got.includes("backup.")`);
    ac.abort();
    return got;
  };
  const alice = await login("alice", "a-good-passphrase");
  expect(await frames(alice, true)).toContain("backup.started");
  expect(await frames(bob, false)).not.toContain("backup.started");
});
