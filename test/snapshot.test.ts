/**
 * A forge back from a snapshot. A running forge with a person, a
 * repository with history, an app with production data and a sealed
 * variable is snapshotted while it runs; the snapshot restores into an
 * empty directory; a forge booted there has the person, the history, the
 * data and can still open the variable. Then the store is pruned and the
 * restore refuses what it must.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableApp, setAppEnvVar } from "../src/actions/apps.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { envDataDir } from "../src/apps/data.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { resolveAppEnv } from "../src/core/app_env.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { commitLog } from "../src/git/read.ts";
import { repoDir } from "../src/git/repos.ts";
import { restoreSnapshot } from "../src/snapshot/restore.ts";
import { startSnapshots, untilNightly } from "../src/snapshot/service.ts";
import {
  isRunBundle,
  listSnapshots,
  pruneSnapshots,
  snapshotName,
  packRuns,
  takeSnapshot,
  unpackRuns,
} from "../src/snapshot/snapshot.ts";
import { unwrapKey, wrapKey } from "../src/snapshot/wrap.ts";
import { dirStore, type Store } from "../src/snapshot/store.ts";

const PASS = "correct horse battery staple";

describe("a forge back from a snapshot", () => {
  let root: string;
  let app: App;
  let alice: User;
  const store = () => dirStore(join(root, "store"));

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "forge-snapshot-"));
    app = createApp({ dataDir: join(root, "live"), port: 0 });
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const repo = await createRepo(app, alice, {
      name: "notes",
      visibility: "private",
    });
    if (!repo.ok) throw new Error(String(repo.error));
    for (const n of [1, 2, 3]) {
      const c = await commitToBranch(app, alice, repo.value, {
        message: `commit ${n}`,
        files: [{ path: "README.md", content: `# notes ${n}\n` }],
      });
      if (!c.ok) throw new Error(JSON.stringify(c.error));
    }
    const branched = await commitToBranch(app, alice, repo.value, {
      branch: "feature",
      message: "a branch too",
      files: [{ path: "feature.txt", content: "yes\n" }],
    });
    if (!branched.ok) throw new Error(JSON.stringify(branched.error));
    const enabled = enableApp(app, alice, repo.value);
    if (!enabled.ok) throw new Error(String(enabled.error));
    const set = await setAppEnvVar(
      app,
      alice,
      repo.value,
      "SECRET_WORD",
      "swordfish",
      "all",
    );
    if (!set.ok) throw new Error(String(set.error));
    // Production data the app would have written: a SQLite file in WAL mode
    // with an open writer, and a plain file.
    const data = envDataDir(app.config.dataDir, enabled.value.id, "production");
    mkdirSync(data, { recursive: true });
    const { Database } = await import("bun:sqlite");
    const appDb = new Database(join(data, "app.db"));
    appDb.run("PRAGMA journal_mode = WAL");
    appDb.run("CREATE TABLE note (body TEXT)");
    appDb.run("INSERT INTO note VALUES ('hello'), ('world')");
    writeFileSync(join(data, "uploads.txt"), "kept\n");
    mkdirSync(join(app.config.dataDir, "runs"), { recursive: true });
    writeFileSync(join(app.config.dataDir, "runs", "r1.log"), "a run\n");
    // The empty repository: nothing to bundle, and not an error.
    const empty = await createRepo(app, alice, {
      name: "empty",
      visibility: "private",
    });
    if (!empty.ok) throw new Error(String(empty.error));
  });

  afterAll(async () => {
    app.close();
    await rm(root, { recursive: true, force: true });
  });

  test("the snapshot holds what cannot be rebuilt, consistently, while the forge runs", async () => {
    const manifest = await takeSnapshot(
      {
        db: app.db,
        dataDir: app.config.dataDir,
        reposRoot: app.reposRoot,
        version: "t",
        passphrase: PASS,
      },
      store(),
      new Date("2026-09-22T08:00:00Z"),
    );
    expect(manifest.name).toBe("2026-09-22T08-00-00Z");
    expect(manifest.repos).toBe(1);
    expect(manifest.apps).toBe(1);
    const paths = manifest.files.map((f) => f.path);
    // The database goes up compressed, in parts, and the manifest says what they make.
    expect(paths).toContain("forge.db.zst.0000");
    expect(paths).not.toContain("forge.db");
    expect(manifest.packed?.map((p) => p.path)).toEqual(["forge.db"]);
    // The raw key never reaches the store; only its wrapped form does.
    expect(paths).not.toContain("secret.key");
    expect(paths).toContain("secret.key.wrapped");
    expect(manifest.key).toBe("wrapped");
    const rawKey = readFileSync(join(app.config.dataDir, "secret.key"));
    for (const f of paths)
      if (!f.startsWith("forge.db") && !f.includes("/"))
        expect(
          readFileSync(
            join(root, "store", "snapshots", manifest.name, f),
          ).includes(rawKey),
        ).toBe(false);
    expect(paths).toContain("repos/alice/notes.bundle");
    expect(paths).not.toContain("repos/alice/empty.bundle");
    expect(paths).toContain("runs/r1.log");
    const appId = getAppByRepo(
      app.db,
      getRepo(app.db, "alice", "notes")!.id,
    )!.id;
    expect(paths).toContain(`apps/${appId}/production/data/app.db`);
    expect(paths).toContain(`apps/${appId}/production/data/uploads.txt`);
    // The live WAL side-files are the process's, not the snapshot's.
    expect(
      paths.some((p) => p.endsWith("app.db-wal") || p.endsWith("app.db-shm")),
    ).toBe(false);
    // The copies are real databases with the rows in them.
    const { Database } = await import("bun:sqlite");
    const copy = new Database(
      join(
        root,
        "store",
        "snapshots",
        manifest.name,
        "apps",
        appId,
        "production",
        "data",
        "app.db",
      ),
      { readonly: true },
    );
    expect(copy.query("SELECT count(*) AS n FROM note").get()).toEqual({
      n: 2,
    });
    copy.close();
    expect((await listSnapshots(store())).map((m) => m.name)).toEqual([
      manifest.name,
    ]);
  });

  test("restored into an empty directory, a forge booted there is the same forge", async () => {
    const back = join(root, "back");
    const done = await restoreSnapshot(store(), "2026-09-22T08-00-00Z", back, {
      passphrase: PASS,
    });
    expect(done.repos).toBe(1);
    expect(done.key).toBe("restored");
    expect(done.sealedMissing).toEqual([]);
    const restored = createApp({ dataDir: back, port: 0 });
    try {
      expect(getUserByName(restored.db, "alice")?.id).toBe(alice.id);
      const repo = getRepo(restored.db, "alice", "notes")!;
      const dir = repoDir(restored.reposRoot, "alice", "notes");
      const log = await commitLog(dir, "refs/heads/main", { limit: 10 });
      expect(log.ok && log.value.map((c) => c.subject)).toEqual([
        "commit 3",
        "commit 2",
        "commit 1",
      ]);
      const feature = await commitLog(dir, "refs/heads/feature", { limit: 1 });
      expect(feature.ok && feature.value[0]?.subject).toBe("a branch too");
      // The hooks are back, so a push into the restored repository is seen.
      expect(await Bun.file(join(dir, "hooks", "pre-receive")).exists()).toBe(
        true,
      );
      // The sealed variable opens with the restored key.
      const record = getAppByRepo(restored.db, repo.id)!;
      const env = resolveAppEnv(restored.db, back, record.id, "production");
      expect(env["SECRET_WORD"]).toBe("swordfish");
      // The app's data came back, database rows included.
      const { Database } = await import("bun:sqlite");
      const appDb = new Database(
        join(envDataDir(back, record.id, "production"), "app.db"),
        { readonly: true },
      );
      expect(appDb.query("SELECT count(*) AS n FROM note").get()).toEqual({
        n: 2,
      });
      appDb.close();
      expect(await Bun.file(join(back, "runs", "r1.log")).text()).toBe(
        "a run\n",
      );
    } finally {
      restored.close();
    }
  });

  test("without the passphrase repos restore and sealed values are reported by name", async () => {
    const back = join(root, "back-nokey");
    const done = await restoreSnapshot(store(), "2026-09-22T08-00-00Z", back);
    expect(done.key).toBe("missing");
    expect(done.sealedMissing).toEqual(["SECRET_WORD (app notes)"]);
    expect(existsSync(join(back, "secret.key.wrapped"))).toBe(false);
    const restored = createApp({ dataDir: back, port: 0 });
    try {
      expect(getRepo(restored.db, "alice", "notes")).toBeDefined();
      const record = getAppByRepo(
        restored.db,
        getRepo(restored.db, "alice", "notes")!.id,
      )!;
      const env = resolveAppEnv(restored.db, back, record.id, "production");
      expect(env["SECRET_WORD"]).toBeUndefined();
    } finally {
      restored.close();
    }
  });

  test("a wrong passphrase refuses the restore and writes nothing", async () => {
    const back = join(root, "back-wrong");
    await expect(
      restoreSnapshot(store(), "2026-09-22T08-00-00Z", back, {
        passphrase: "not the one",
      }),
    ).rejects.toThrow("passphrase");
    expect(existsSync(back)).toBe(false);
  });

  test("a snapshot taken without a passphrase carries no key at all", async () => {
    const s = dirStore(join(root, "store-nokey"));
    const m = await takeSnapshot(
      {
        db: app.db,
        dataDir: app.config.dataDir,
        reposRoot: app.reposRoot,
        version: "t",
      },
      s,
      new Date("2026-09-23T08:00:00Z"),
    );
    expect(m.key).toBe("none");
    expect(m.files.some((f) => f.path.startsWith("secret.key"))).toBe(false);
  });

  test("wrapping round-trips and fails closed", () => {
    const key = Buffer.alloc(32, 7);
    const w = wrapKey(key, "pw");
    expect(w.includes(key.toString("base64url"))).toBe(false);
    expect(unwrapKey(w, "pw")?.equals(key)).toBe(true);
    expect(unwrapKey(w, "pW")).toBeUndefined();
    expect(unwrapKey("{}", "pw")).toBeUndefined();
    expect(unwrapKey("not json", "pw")).toBeUndefined();
  });

  test("a restore refuses a full directory and an unknown snapshot", async () => {
    await expect(
      restoreSnapshot(store(), "2026-09-22T08-00-00Z", join(root, "back")),
    ).rejects.toThrow("not empty");
    await expect(
      restoreSnapshot(store(), "2026-01-01T00-00-00Z", join(root, "nowhere")),
    ).rejects.toThrow("no snapshot");
    await expect(
      restoreSnapshot(store(), "../etc", join(root, "nowhere")),
    ).rejects.toThrow("not a snapshot name");
  });

  test("the store keeps the newest fourteen and no more", async () => {
    const s = store();
    for (let d = 1; d <= 16; d++)
      await s.put(
        `snapshots/2026-08-${String(d).padStart(2, "0")}T08-00-00Z/manifest.json`,
        "{}",
      );
    const gone = await pruneSnapshots(s, 14);
    expect(gone.sort()).toEqual([
      "2026-08-01T08-00-00Z",
      "2026-08-02T08-00-00Z",
      "2026-08-03T08-00-00Z",
    ]);
    const left = await s.list("snapshots/");
    expect(new Set(left.map((k) => k.split("/")[1])).size).toBe(14);
    expect(left.some((k) => k.includes("2026-09-22T08-00-00Z"))).toBe(true);
  });

  test("the service takes one on demand and knows when the night is", async () => {
    const svc = startSnapshots(app, dirStore(join(root, "store2")), {
      version: "t",
      nightly: false,
    });
    try {
      const m = await svc.now();
      expect(m.repos).toBe(1);
      expect(svc.last().manifest?.name).toBe(m.name);
      expect((await svc.list()).map((x) => x.name)).toEqual([m.name]);
    } finally {
      await svc.stop();
    }
    expect(untilNightly(Date.UTC(2026, 8, 22, 7, 59, 0))).toBe(60_000);
    expect(snapshotName(new Date("2026-09-22T08:00:00.123Z"))).toBe(
      "2026-09-22T08-00-00Z",
    );
  });

  test("the backups page: nowhere to put them says so; with a store, the list and the button", async () => {
    const servers: Servers = await serve(app);
    try {
      const signedIn = await fetch(`${servers.url}/signin`, {
        method: "POST",
        headers: { origin: servers.url },
        body: new URLSearchParams({
          username: "alice",
          password: "a-good-passphrase",
        }),
        redirect: "manual",
      });
      const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0]!;
      const none = await (
        await fetch(`${servers.url}/settings/backups`, { headers: { cookie } })
      ).text();
      expect(none).toContain("No snapshots are taken");
      const svc = startSnapshots(app, dirStore(join(root, "store")), {
        version: "t",
        nightly: false,
      });
      try {
        const listed = await (
          await fetch(`${servers.url}/settings/backups`, {
            headers: { cookie },
          })
        ).text();
        expect(listed).toContain("2026-09-22T08-00-00Z");
        expect(listed).toContain("Snapshot now");
        // Off by default: the page says no key travels, and what that costs.
        expect(listed).toContain("Snapshots carry no key");
        expect(listed.replace(/\s+/g, " ")).toContain(
          "The last snapshot carried a wrapped key",
        );
        expect(listed).toContain(
          "bun run src/snapshot/restore.ts 2026-09-22T08-00-00Z",
        );
        const now = await fetch(`${servers.url}/settings/backups/now`, {
          method: "POST",
          headers: { cookie, origin: servers.url },
          redirect: "manual",
        });
        expect(now.status).toBe(303);
        expect(
          decodeURIComponent(now.headers.get("set-cookie") ?? ""),
        ).toContain("Snapshot 20");
        expect((await svc.list()).length).toBeGreaterThanOrEqual(2);
      } finally {
        await svc.stop();
      }
      const wrapping = startSnapshots(app, dirStore(join(root, "store")), {
        version: "t",
        nightly: false,
        passphrase: PASS,
      });
      try {
        const on = await (
          await fetch(`${servers.url}/settings/backups`, {
            headers: { cookie },
          })
        ).text();
        expect(on).toContain("FORGE_SNAPSHOT_PASSPHRASE");
        expect(on.replace(/\s+/g, " ")).toContain("every sealed value");
        expect(on).not.toContain("Snapshots carry no key");
      } finally {
        await wrapping.stop();
      }
      // A stranger and a plain user see nothing here.
      expect(
        (await fetch(`${servers.url}/settings/backups`, { redirect: "manual" }))
          .status,
      ).toBe(303);
    } finally {
      servers.stop();
    }
  });
});

describe("a snapshot's uploads", () => {
  let root: string;
  let app: App;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "forge-snapshot-queue-"));
    app = createApp({ dataDir: join(root, "live"), port: 0 });
    mkdirSync(join(app.config.dataDir, "runs"), { recursive: true });
  });
  afterAll(async () => {
    app.close();
    await rm(root, { recursive: true, force: true });
  });
  const forge = (extra: object = {}) => ({
    db: app.db,
    dataDir: app.config.dataDir,
    reposRoot: app.reposRoot,
    version: "t",
    ...extra,
  });
  /** A store that holds nothing but counts, and answers after `ms`. */
  const slowStore = (ms: number, failOn?: string) => {
    const seen = { inFlight: 0, peak: 0, keys: [] as string[], started: [] as string[] };
    const store: Store = {
      ...dirStore(join(root, "unused")),
      where: "fake",
      async put(key) {
        seen.started.push(key);
        seen.inFlight++;
        seen.peak = Math.max(seen.peak, seen.inFlight);
        await Bun.sleep(ms);
        seen.inFlight--;
        if (failOn !== undefined && key.endsWith(failOn))
          throw new Error("refused");
        seen.keys.push(key);
      },
    };
    return { store, seen };
  };
  const logsDir = () => join(app.config.dataDir, "runs");
  const old = (name: string, body: string, day: string) => {
    const file = join(logsDir(), name);
    writeFileSync(file, body);
    const when = new Date(`${day}T12:00:00Z`);
    utimesSync(file, when, when);
  };

  test("at most eight puts are in flight, and the manifest keeps its order", async () => {
    for (let i = 0; i < 40; i++)
      writeFileSync(join(logsDir(), `new-${String(i).padStart(2, "0")}.log`), "x");
    const { store, seen } = slowStore(15);
    const manifest = await takeSnapshot(forge(), store);
    expect(seen.peak).toBeGreaterThan(1);
    expect(seen.peak).toBeLessThanOrEqual(8);
    // Handed over in the manifest's order, whatever order they landed in.
    expect(seen.started.slice(0, -1)).toEqual(
      manifest.files.map((f) => `snapshots/${manifest.name}/${f.path}`),
    );
    expect(manifest.files.filter((f) => f.path.startsWith("runs/new-")).length).toBe(40);
    expect(seen.keys.length).toBe(manifest.files.length + 1);
  });

  test("held bytes are bounded too: big files go through two at a time", async () => {
    const big = "x".repeat(30 * 1024 * 1024);
    for (let i = 0; i < 4; i++) writeFileSync(join(logsDir(), `big-${i}.log`), big);
    const inner = slowStore(30).store;
    let bigIn = 0;
    let bigPeak = 0;
    const counting = {
      ...inner,
      async put(...args: Parameters<typeof inner.put>) {
        const isBig = args[0].includes("/runs/big-");
        if (isBig) bigPeak = Math.max(bigPeak, ++bigIn);
        try {
          await inner.put(...args);
        } finally {
          if (isBig) bigIn--;
        }
      },
    };
    await takeSnapshot(forge(), counting);
    expect(bigPeak).toBeLessThanOrEqual(2);
    expect(bigPeak).toBeGreaterThan(0);
  }, 20_000);

  test("a failed put fails the snapshot and names its key", async () => {
    const { store } = slowStore(1, "runs/new-07.log");
    await expect(takeSnapshot(forge(), store)).rejects.toThrow(
      /could not put snapshots\/.*runs\/new-07\.log/,
    );
  }, 15_000);

  test("a slow store gets a progress line every so many objects", async () => {
    const { store } = slowStore(10);
    const lines: { objects: number; bytes: number }[] = [];
    await takeSnapshot(
      forge({
        onProgress: (p: { objects: number; bytes: number }) => lines.push(p),
        progressEvery: { objects: 10, ms: 60_000 },
      }),
      store,
    );
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines[0]!.objects).toBeGreaterThanOrEqual(10);
    expect(lines.at(-1)!.bytes).toBeGreaterThan(0);
    // And by the clock when objects are slow to land.
    const ticks: number[] = [];
    await takeSnapshot(
      forge({
        onProgress: (p: { objects: number }) => ticks.push(p.objects),
        progressEvery: { objects: 100_000, ms: 20 },
      }),
      slowStore(30).store,
    );
    expect(ticks.length).toBeGreaterThan(0);
  });

  test("older run logs go up as one object a day and restore as the logs they were", async () => {
    old("a.log", "alpha\n", "2026-10-10");
    old("b.log", "beta\n", "2026-10-10");
    old("c.log", "gamma\n", "2026-10-11");
    const store = dirStore(join(root, "bundled"));
    const manifest = await takeSnapshot(forge(), store);
    const paths = manifest.files.map((f) => f.path);
    expect(paths).toContain("runs/2026-10-10.ndjson.zst");
    expect(paths).toContain("runs/2026-10-11.ndjson.zst");
    expect(paths).not.toContain("runs/a.log");
    const target = join(root, "restored");
    await restoreSnapshot(store, manifest.name, target);
    expect(readFileSync(join(target, "runs", "a.log"), "utf8")).toBe("alpha\n");
    expect(readFileSync(join(target, "runs", "b.log"), "utf8")).toBe("beta\n");
    expect(readFileSync(join(target, "runs", "c.log"), "utf8")).toBe("gamma\n");
    expect(readFileSync(join(target, "runs", "new-03.log"), "utf8")).toBe("x");
  });

  test("a bundle that names a path outside runs is refused", () => {
    const bad = packRuns([{ path: "../evil", body: new Uint8Array([1]) }]);
    expect(() => unpackRuns(bad)).toThrow(/names/);
  });

  test("a bundle is cut before it grows past the cap, and every log still restores", async () => {
    const big = "z".repeat(1_500_000);
    for (const n of [1, 2, 3, 4]) old(`big-${n}.log`, big + n, "2026-10-09");
    const store = dirStore(join(root, "capped"));
    const manifest = await takeSnapshot(forge(), store);
    const bundles = manifest.files
      .map((f) => f.path)
      .filter((p) => p.startsWith("runs/2026-10-09"));
    expect(bundles.length).toBeGreaterThan(1);
    expect(bundles.every(isRunBundle)).toBe(true);
    const target = join(root, "capped-restored");
    await restoreSnapshot(store, manifest.name, target);
    for (const n of [1, 2, 3, 4])
      expect(readFileSync(join(target, "runs", `big-${n}.log`), "utf8")).toBe(
        big + n,
      );
  }, 15_000);

  test("the service shows a running snapshot's progress while it runs", async () => {
    const { store } = slowStore(40);
    const svc = startSnapshots(app, store, { version: "t", nightly: false });
    try {
      expect(svc.progress()).toBeUndefined();
      const taking = svc.now();
      let seen: { objects: number; bytes: number } | undefined;
      let done = false;
      void taking.then(() => (done = true));
      while (!done && (seen?.objects ?? 0) === 0) {
        seen = svc.progress();
        await Bun.sleep(10);
      }
      expect(seen).toBeDefined();
      expect(seen!.objects).toBeGreaterThan(0);
      expect(done).toBe(false);
      await taking;
      expect(svc.progress()).toBeUndefined();
    } finally {
      await svc.stop();
    }
  }, 15_000);

  test("the service says how long the snapshot in flight has run, for the release keeper to wait on (#9653)", async () => {
    const { store } = slowStore(40);
    const svc = startSnapshots(app, store, { version: "t", nightly: false });
    try {
      expect(svc.takingMs()).toBeUndefined();
      const taking = svc.now();
      await Bun.sleep(30);
      const ms = svc.takingMs();
      expect(ms).toBeGreaterThanOrEqual(0);
      await taking;
      expect(svc.takingMs()).toBeUndefined();
    } finally {
      await svc.stop();
    }
  }, 15_000);

  test("until the boot's look at the store is done, the service counts as taking, so no release lands in that gap", async () => {
    const { store } = slowStore(0);
    const svc = startSnapshots(app, store, { version: "t", snapshotCatchUpMs: 30, snapshotCheckMs: 60_000 });
    try {
      expect(svc.takingMs()).toBeGreaterThanOrEqual(0);
      await Bun.sleep(400);
      await svc.now().catch(() => {});
      await Bun.sleep(50);
      expect(svc.takingMs()).toBeUndefined();
    } finally {
      await svc.stop();
    }
  }, 15_000);
});
