/**
 * Restore around the packed database (#2536). A snapshot from before the
 * database was packed — a plain `forge.db`, no `packed` — still restores
 * byte for byte; a manifest whose `packed` entry does not read whole, or a
 * snapshot missing one of its parts, is refused before any database is
 * written; and a snapshot hands its parts to the upload queue, several in
 * flight at once, not one after another.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createIssue } from "../src/core/issues.ts";
import { createUser } from "../src/core/users.ts";
import { createRepo } from "../src/actions/repos.ts";
import { pack, partPath } from "../src/snapshot/parts.ts";
import { restoreSnapshot } from "../src/snapshot/restore.ts";
import { takeSnapshot } from "../src/snapshot/snapshot.ts";
import { dirStore, type Store } from "../src/snapshot/store.ts";

const NAME = "2026-10-16T08-00-00Z";
const prefix = `snapshots/${NAME}/`;

/** A small real database, as the bytes of its file. */
function databaseBytes(dir: string): Uint8Array {
  const file = join(dir, "made.db");
  const db = new Database(file);
  db.run("create table notes (body text)");
  for (let n = 0; n < 200; n++) db.run("insert into notes values (?)", [`note ${n} `.repeat(20)]);
  db.close();
  return new Uint8Array(readFileSync(file));
}

const manifestOf = (files: { path: string; bytes: number }[], extra: object = {}): string =>
  JSON.stringify({
    name: NAME,
    startedAt: "2026-10-16T08:00:00.000Z",
    finishedAt: "2026-10-16T08:01:00.000Z",
    version: "t",
    repos: 0,
    apps: 0,
    files,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    key: "none",
    ...extra,
  });

describe("restoring around the packed database", () => {
  let root: string;
  let db: Uint8Array;
  let n = 0;
  const fresh = (): { store: Store; dataDir: string } => {
    n++;
    return { store: dirStore(join(root, `store-${n}`)), dataDir: join(root, `data-${n}`) };
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "forge-restore-packed-"));
    db = databaseBytes(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("a snapshot from before packing — a plain forge.db, no packed — restores byte for byte", async () => {
    const { store, dataDir } = fresh();
    await store.put(`${prefix}forge.db`, db);
    await store.put(`${prefix}manifest.json`, manifestOf([{ path: "forge.db", bytes: db.byteLength }]));
    const restored = await restoreSnapshot(store, NAME, dataDir);
    expect(restored.files).toBe(1);
    expect(new Uint8Array(await Bun.file(join(dataDir, "forge.db")).arrayBuffer())).toEqual(new Uint8Array(db));
  });

  test("a packed one, in several parts, restores byte for byte", async () => {
    const { store, dataDir } = fresh();
    const { packed, parts } = await pack("forge.db", db, 1024);
    expect(parts.length).toBeGreaterThan(1);
    for (const [i, part] of parts.entries()) await store.put(prefix + partPath("forge.db", i), part);
    const files = parts.map((part, i) => ({ path: partPath("forge.db", i), bytes: part.byteLength }));
    await store.put(`${prefix}manifest.json`, manifestOf(files, { packed: [packed] }));
    await restoreSnapshot(store, NAME, dataDir);
    expect(new Uint8Array(await Bun.file(join(dataDir, "forge.db")).arrayBuffer())).toEqual(new Uint8Array(db));
  });

  test("a packed entry that does not read whole is refused, and no database is written", async () => {
    const { packed, parts } = await pack("forge.db", db, 1024);
    const files = parts.map((part, i) => ({ path: partPath("forge.db", i), bytes: part.byteLength }));
    for (const bad of [
      { ...packed, parts: 0 },
      { ...packed, bytes: -1 },
      { ...packed, path: "../forge.db" },
      { ...packed, packedBytes: "12" },
      null,
    ]) {
      const { store, dataDir } = fresh();
      for (const [i, part] of parts.entries()) await store.put(prefix + partPath("forge.db", i), part);
      await store.put(`${prefix}manifest.json`, manifestOf(files, { packed: [bad] }));
      await expect(restoreSnapshot(store, NAME, dataDir)).rejects.toThrow(/does not read whole/);
      expect(existsSync(join(dataDir, "forge.db"))).toBe(false);
    }
  });

  test("a part missing from the store, or from the manifest's files, is refused by name", async () => {
    const { packed, parts } = await pack("forge.db", db, 1024);
    const files = parts.map((part, i) => ({ path: partPath("forge.db", i), bytes: part.byteLength }));
    const last = partPath("forge.db", parts.length - 1);

    // Listed, but not in the store.
    const a = fresh();
    for (const [i, part] of parts.slice(0, -1).entries()) await a.store.put(prefix + partPath("forge.db", i), part);
    await a.store.put(`${prefix}manifest.json`, manifestOf(files, { packed: [packed] }));
    await expect(restoreSnapshot(a.store, NAME, a.dataDir)).rejects.toThrow(`is missing ${last}`);
    expect(existsSync(join(a.dataDir, "forge.db"))).toBe(false);

    // In the store, but left out of the files: the parts that came back are not the whole.
    const b = fresh();
    for (const [i, part] of parts.entries()) await b.store.put(prefix + partPath("forge.db", i), part);
    await b.store.put(`${prefix}manifest.json`, manifestOf(files.slice(0, -1), { packed: [packed] }));
    await expect(restoreSnapshot(b.store, NAME, b.dataDir)).rejects.toThrow(`is missing ${last}`);
    expect(existsSync(join(b.dataDir, "forge.db"))).toBe(false);
  });
});

describe("a snapshot's parts go up through the queue", () => {
  let root: string;
  let app: App;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "forge-parts-queue-"));
    app = createApp({ dataDir: join(root, "live"), port: 0 });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const repo = await createRepo(app, a.value, { name: "notes", visibility: "private" });
    if (!repo.ok) throw new Error(String(repo.error));
    for (let i = 0; i < 50; i++)
      createIssue(app.db, { repoId: repo.value.id, authorId: a.value.id, title: `issue ${i} ${crypto.randomUUID()}` });
  });

  afterAll(async () => {
    app.close();
    await rm(root, { recursive: true, force: true });
  });

  test("several parts are in flight at once, never more than eight, and they restore", async () => {
    const inner = dirStore(join(root, "store"));
    let flying = 0;
    let most = 0;
    const store: Store = {
      ...inner,
      put: async (key, body) => {
        if (!key.includes("forge.db.zst.")) return inner.put(key, body);
        most = Math.max(most, ++flying);
        try {
          await Bun.sleep(20);
          await inner.put(key, body);
        } finally {
          flying--;
        }
      },
    };
    const m = await takeSnapshot(
      { db: app.db, dataDir: app.config.dataDir, reposRoot: app.reposRoot, version: "t", partBytes: 2048 },
      store,
      new Date("2026-10-18T08:00:00Z"),
    );
    expect(m.packed?.[0]?.parts).toBeGreaterThan(8);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(8);
    const dataDir = join(root, "restored");
    await restoreSnapshot(inner, m.name, dataDir);
    const back = new Database(join(dataDir, "forge.db"), { readonly: true });
    try {
      expect((back.query("select count(*) as n from issue").get() as { n: number }).n).toBe(50);
    } finally {
      back.close();
    }
  });
});
