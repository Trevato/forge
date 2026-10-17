/**
 * The off-box mirror, against a stand-in S3 on a loopback port: a snapshot
 * lands in both buckets; a mirror that cannot be reached is one line on the
 * board and one push; so is a mirror a day out of date; and a mirror
 * brought back catches up, resumes, and clears the line.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { setNotifyUrl, startNotifier } from "../src/crew/notify.ts";
import { vitals } from "../src/kernel/vitals.ts";
import { listSnapshots, SNAPSHOT_PREFIX } from "../src/snapshot/snapshot.ts";
import {
  lastMirror,
  MIRROR_STALE_MS,
  mirrorNeed,
  mirrorPass,
  recordMirror,
  resolveMirror,
} from "../src/snapshot/mirror.ts";
import { startSnapshots } from "../src/snapshot/service.ts";
import { dirStore, type Store } from "../src/snapshot/store.ts";

/** A directory as a bucket that can be switched off: while `down`, every call fails like an unreachable host. */
function bucket(dir: string): { store: () => Store; down: boolean } {
  const inner = dirStore(dir);
  const me = { down: false, store: (): Store => flaky };
  const guard = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    if (me.down) throw new Error("connection refused");
    return fn(...a);
  };
  const flaky: Store = {
    where: inner.where,
    put: guard(inner.put),
    get: guard(inner.get),
    list: guard(inner.list),
    names: guard(inner.names),
    delete: guard(inner.delete),
  };
  return me;
}

const T0 = Date.parse("2026-10-01T00:00:00Z");

describe("the off-box mirror", () => {
  let root: string;
  let app: App;
  let admin: { id: string };
  let primary: ReturnType<typeof bucket>;
  let offbox: ReturnType<typeof bucket>;
  const src = () => primary.store();
  const dst = () => offbox.store();
  const board = (now: number) =>
    vitals({ db: app.db, dataDir: app.config.dataDir, signals: app.signals, now }).degraded.filter(
      (d) => d.cause === "mirror",
    );

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "forge-mirror-"));
    primary = bucket(join(root, "primary-dir"));
    offbox = bucket(join(root, "offbox-dir"));
    app = createApp({ dataDir: root, port: 0 });
    const u = await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    admin = u.value;
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("a snapshot lands in both buckets, and the page's facts say so", async () => {
    const svc = startSnapshots(app, src(), { version: "t", nightly: false, mirror: dst() });
    const m = await svc.now();
    const state = await svc.mirrorNow();
    expect(state?.reachable).toBe(true);
    expect(state?.failingSince).toBeUndefined();
    const there = await listSnapshots(dst());
    expect(there.map((x) => x.name)).toEqual([m.name]);
    // Every file the manifest names is in the off-box bucket, byte for byte.
    for (const f of m.files) {
      const a = await src().get(`${SNAPSHOT_PREFIX}${m.name}/${f.path}`);
      const b = await dst().get(`${SNAPSHOT_PREFIX}${m.name}/${f.path}`);
      expect(a).toBeDefined();
      expect(Buffer.from(b!).equals(Buffer.from(a!))).toBe(true);
    }
    expect(svc.mirrored()?.newest).toBe(m.name);
    expect(board(Date.now())).toHaveLength(0);
    await svc.stop();
  });

  test("an unreachable mirror is one line on the board and one push", async () => {
    const sent: string[] = [];
    setNotifyUrl(app.db, admin.id, "https://ntfy.example.com/topic");
    let clock = Date.now();
    // The notifier's first look is its baseline: it starts on a healthy mirror.
    recordMirror(root, { where: "x", attemptAt: new Date(clock).toISOString(), reachable: true, syncedAt: new Date(clock).toISOString() });
    const n = startNotifier(app, {
      forgeUrl: "https://forge.example.com",
      now: () => clock,
      send: async (_u, body) => (sent.push(body), true),
      clockMs: 20,
    });
    await n.settled();
    offbox.down = true;
    const svc = startSnapshots(app, src(), { version: "t", nightly: false, mirror: dst() });
    await svc.now();
    const state = await svc.mirrorNow();
    expect(state?.reachable).toBe(false);
    const line = board(Date.now());
    expect(line).toHaveLength(1);
    expect(line[0]!.sentence).toContain("unreachable");
    expect(line[0]!.href).toBe("/settings/backups");
    // A second failing pass is the same cause, not a second line.
    const first = lastMirror(root)!.failingSince;
    await svc.mirrorNow();
    expect(lastMirror(root)!.failingSince).toBe(first);
    expect(board(Date.now())).toHaveLength(1);

    // The clock wakes the notifier a few times: one push, however many ticks.
    for (let i = 0; i < 4; i++) {
      clock += 60_000;
      await Bun.sleep(40);
      await n.settled();
    }
    await n.close();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("off-box mirror");
    expect(sent[0]).toContain("unreachable");
    await svc.stop();
  });

  test("a mirror that comes back catches up and the line goes", async () => {
    offbox.down = false;
    const svc = startSnapshots(app, src(), { version: "t", nightly: false, mirror: dst() });
    const state = await svc.mirrorNow();
    expect(state?.failingSince).toBeUndefined();
    expect((await listSnapshots(dst())).length).toBe((await listSnapshots(src())).length);
    expect(board(Date.now())).toHaveLength(0);
    await svc.stop();
  });

  test("a snapshot that did not land says which, and a half-copied one is never listed", async () => {
    const s = src();
    const m = (await listSnapshots(s))[0]!;
    const broken = dirStore(join(root, "dst-dir"));
    let puts = 0;
    const flaky = {
      ...broken,
      put: async (k: string, b: Uint8Array | string) => {
        if (++puts > 1) throw new Error("quota exceeded");
        await broken.put(k, b);
      },
    };
    const state = await mirrorPass(root, s, flaky, { now: Date.now() });
    expect(state.reachable).toBe(true);
    expect(state.failed).toBeDefined();
    expect(mirrorNeed(state, Date.now())?.sentence).toContain("did not land");
    expect(await listSnapshots(broken)).toEqual([]);
    expect(await broken.get(`${SNAPSHOT_PREFIX}${m.name}/manifest.json`)).toBeUndefined();
    // Reset to the good mirror for what follows.
    await mirrorPass(root, s, dst());
  });

  test("a primary that is down is not blamed on the mirror: no failure recorded, no line", async () => {
    recordMirror(root, undefined);
    primary.down = true;
    const state = await mirrorPass(root, src(), dst());
    primary.down = false;
    expect(state.sourceError).toContain("connection refused");
    expect(state.failingSince).toBeUndefined();
    expect(lastMirror(root)).toBeUndefined();
    expect(board(Date.now())).toHaveLength(0);
    // With a mirror already level, the primary going down leaves its state alone.
    const level = await mirrorPass(root, src(), dst());
    primary.down = true;
    const again = await mirrorPass(root, src(), dst());
    primary.down = false;
    expect(again.sourceError).toBeDefined();
    expect(lastMirror(root)).toEqual(level);
    expect(board(Date.now())).toHaveLength(0);
  });

  test("a mirror not confirmed level for a day is a line, once, until it is level again", () => {
    const synced = new Date(T0).toISOString();
    const state = { where: "b2/offbox", attemptAt: synced, reachable: true, syncedAt: synced, newest: "n" };
    expect(mirrorNeed(state, T0 + MIRROR_STALE_MS)).toBeUndefined();
    const stale = mirrorNeed(state, T0 + MIRROR_STALE_MS + 1);
    expect(stale?.sentence).toContain("over a day");
    expect(stale?.key).toBe(`stale:${synced}`);
    recordMirror(root, state);
    expect(board(T0 + MIRROR_STALE_MS + 1)).toHaveLength(1);
    expect(board(T0 + 1000)).toHaveLength(0);
    recordMirror(root, undefined);
    expect(board(T0 + 5 * MIRROR_STALE_MS)).toHaveLength(0);
  });

  test("the mirror comes from the environment when nothing is sealed, and from nowhere otherwise", () => {
    expect(resolveMirror({ env: {} })).toBeUndefined();
    expect(resolveMirror({ env: { FORGE_MIRROR_S3_ENDPOINT: "http://x", FORGE_MIRROR_S3_BUCKET: "b" } })).toBeUndefined();
    const m = resolveMirror({
      env: {
        FORGE_MIRROR_S3_ENDPOINT: "https://s3.b2.example.com",
        FORGE_MIRROR_S3_BUCKET: "offbox",
        FORGE_MIRROR_S3_ACCESS_KEY: "a",
        FORGE_MIRROR_S3_SECRET_KEY: "s",
      },
    });
    expect(m?.source).toBe("env");
    expect(m?.store.where).toBe("s3.b2.example.com/offbox");
  });
});
