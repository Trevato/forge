/**
 * A forge back from a snapshot. A running forge with a person, a
 * repository with history, an app with production data and a sealed
 * variable is snapshotted while it runs; the snapshot restores into an
 * empty directory; a forge booted there has the person, the history, the
 * data and can still open the variable. Then the store is pruned and the
 * restore refuses what it must.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
  listSnapshots,
  pruneSnapshots,
  snapshotName,
  takeSnapshot,
} from "../src/snapshot/snapshot.ts";
import { dirStore } from "../src/snapshot/store.ts";

describe("a forge back from a snapshot", () => {
  let root: string;
  let app: App;
  let alice: User;
  const store = () => dirStore(join(root, "store"));

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "forge-snapshot-"));
    app = createApp({ dataDir: join(root, "live"), port: 0 });
    const a = await createUser(app.db, {
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
      },
      store(),
      new Date("2026-09-22T08:00:00Z"),
    );
    expect(manifest.name).toBe("2026-09-22T08-00-00Z");
    expect(manifest.repos).toBe(1);
    expect(manifest.apps).toBe(1);
    const paths = manifest.files.map((f) => f.path);
    expect(paths).toContain("forge.db");
    expect(paths).toContain("secret.key");
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
    const done = await restoreSnapshot(store(), "2026-09-22T08-00-00Z", back);
    expect(done.repos).toBe(1);
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
