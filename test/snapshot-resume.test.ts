/**
 * A release mid-snapshot (#8828): the snapshot a restart finds without a
 * manifest is carried on under its own name, and the repository bundles
 * that already landed are not put again.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { startSnapshots } from "../src/snapshot/service.ts";
import {
  JOURNAL,
  JOURNAL_EVERY,
  listSnapshots,
  pruneSnapshots,
  RESUME_WINDOW_MS,
  snapshotName,
  snapshotStart,
  takeSnapshot,
} from "../src/snapshot/snapshot.ts";
import { dirStore, type Store } from "../src/snapshot/store.ts";

let root: string;
let app: App;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-resume-"));
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
  for (const name of ["one", "two"]) {
    const repo = await createRepo(app, a.value, { name, visibility: "private" });
    if (!repo.ok) throw new Error(String(repo.error));
    const c = await commitToBranch(app, a.value, repo.value, {
      message: "first",
      files: [{ path: "README.md", content: `# ${name}\n` }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
  }
});

afterAll(async () => {
  app.close();
  await rm(root, { recursive: true, force: true });
});

const forge = (resume?: boolean, journalEveryMs?: number) => ({
  db: app.db,
  dataDir: app.config.dataDir,
  reposRoot: app.reposRoot,
  version: "test",
  onProgress: () => {},
  resume,
  journalEveryMs,
});

/** A store that counts the keys put under it. */
function counting(inner: Store, puts: string[]): Store {
  return {
    ...inner,
    put: (key, body) => {
      puts.push(key);
      return inner.put(key, body);
    },
  };
}

test("a name gives back the moment it stands for", () => {
  const at = new Date("2026-09-22T09:00:00Z");
  expect(snapshotStart(snapshotName(at))?.getTime()).toBe(at.getTime());
  expect(snapshotStart("not-a-snapshot")).toBeUndefined();
});

test("a snapshot cut short is finished under its name without putting its bundles again", async () => {
  const inner = dirStore(join(root, "store"));
  const at = new Date("2026-11-02T08:00:00Z");
  const prefix = `snapshots/${snapshotName(at)}/`;
  // The first attempt dies when the manifest is due: its journal is written on the way out.
  const dying: Store = {
    ...inner,
    put: (key, body) => {
      if (key.endsWith("manifest.json")) throw new Error("the release came");
      return inner.put(key, body);
    },
  };
  await expect(takeSnapshot(forge(), dying, at)).rejects.toThrow("the release came");
  expect(await inner.get(prefix + "manifest.json")).toBeUndefined();
  const journal = JSON.parse(new TextDecoder().decode(await inner.get(prefix + JOURNAL))) as { path: string }[];
  expect(journal.map((e) => e.path).sort()).toEqual(["repos/alice/one.bundle", "repos/alice/two.bundle"]);

  const puts: string[] = [];
  const manifest = await takeSnapshot(forge(true), counting(inner, puts), at);
  expect(puts.some((k) => k.includes("/repos/"))).toBe(false);
  expect(puts.some((k) => k.includes("forge.db"))).toBe(true);
  expect(manifest.name).toBe(snapshotName(at));
  expect(manifest.files.map((f) => f.path)).toContain("repos/alice/one.bundle");
  expect(manifest.repos).toBe(2);
  // Every object the manifest lists is in the store at its size, and the journal is gone.
  for (const f of manifest.files) expect((await inner.get(prefix + f.path))?.byteLength).toBe(f.bytes);
  expect(await inner.get(prefix + JOURNAL)).toBeUndefined();
});

test("without resume, everything goes up again", async () => {
  const inner = dirStore(join(root, "store2"));
  const puts: string[] = [];
  await takeSnapshot(forge(), counting(inner, puts), new Date("2026-11-02T09:00:00Z"));
  expect(puts.some((k) => k.includes("/repos/"))).toBe(true);
});

const HOUR = 3_600_000;

/** Takes a snapshot at `at` that dies before its manifest, leaving a journal. */
async function cutShortAt(inner: Store, at: Date): Promise<void> {
  const dying: Store = {
    ...inner,
    put: (key, body) => {
      if (key.endsWith("manifest.json")) throw new Error("the release came");
      return inner.put(key, body);
    },
  };
  await expect(takeSnapshot(forge(), dying, at)).rejects.toThrow("the release came");
}

test("a kill that runs no finally still leaves the journal, written on a clock", async () => {
  const inner = dirStore(join(root, "store-kill"));
  const at = new Date("2026-11-02T08:00:00Z");
  const prefix = `snapshots/${snapshotName(at)}/`;
  // Everything but the bundles hangs for ever: the process is killed there.
  const hung: Store = {
    ...inner,
    put: (key, body) => (key.includes("/repos/") || key.endsWith(JOURNAL) ? inner.put(key, body) : new Promise<void>(() => {})),
  };
  void takeSnapshot(forge(false, 20), hung, at).catch(() => {});
  let journal: { path: string }[] = [];
  for (let i = 0; i < 100 && journal.length < 2; i++) {
    await Bun.sleep(50);
    const body = await inner.get(prefix + JOURNAL);
    if (body !== undefined) journal = JSON.parse(new TextDecoder().decode(body)) as { path: string }[];
  }
  expect(journal.map((e) => e.path).sort()).toEqual(["repos/alice/one.bundle", "repos/alice/two.bundle"]);
  expect(await inner.get(prefix + "manifest.json")).toBeUndefined();
}, 15_000);

test("a bundle of the same size but other content is put again", async () => {
  const inner = dirStore(join(root, "store-stale"));
  const at = new Date("2026-11-02T08:00:00Z");
  const prefix = `snapshots/${snapshotName(at)}/`;
  await cutShortAt(inner, at);
  const body = JSON.parse(new TextDecoder().decode(await inner.get(prefix + JOURNAL))) as { path: string; bytes: number; sha256: string }[];
  // The journal remembers a different content of the very size the bundle has now.
  const forged = body.map((e) => (e.path === "repos/alice/one.bundle" ? { ...e, sha256: "0".repeat(64) } : e));
  await inner.put(prefix + JOURNAL, JSON.stringify(forged));
  const puts: string[] = [];
  await takeSnapshot(forge(true), counting(inner, puts), at);
  expect(puts.filter((k) => k.includes("/repos/"))).toEqual([prefix + "repos/alice/one.bundle"]);
});

test("the journal is rewritten after every N landed objects", async () => {
  expect(JOURNAL_EVERY).toBeGreaterThan(1);
  const inner = dirStore(join(root, "store-every"));
  const puts: string[] = [];
  // The clock is far off, so only the first object and the way out write it.
  await expect(
    takeSnapshot(forge(false, 3_600_000), counting({ ...inner, put: (k, b) => (k.endsWith("manifest.json") ? Promise.reject(new Error("x")) : inner.put(k, b)) }, puts), new Date("2026-11-02T08:30:00Z")),
  ).rejects.toThrow("x");
  expect(puts.filter((k) => k.endsWith(JOURNAL)).length).toBeGreaterThanOrEqual(1);
});

async function due(inner: Store, nowMs: number) {
  const puts: string[] = [];
  const counted = counting(inner, puts);
  const again = startSnapshots(app, counted, { version: "t", nightly: false, now: () => nowMs });
  try {
    expect(await again.takeIfDue()).toBe(true);
  } finally {
    await again.stop();
  }
  return { puts, manifests: await listSnapshots(inner) };
}

test("takeIfDue resumes the newest prefix newer than the newest manifest", async () => {
  const inner = dirStore(join(root, "store-due1"));
  const old = new Date("2026-11-02T08:00:00Z");
  const prior = "2026-11-01T08-00-00Z";
  await inner.put(`snapshots/${prior}/manifest.json`, JSON.stringify({ name: prior, files: [], finishedAt: "2026-11-01T08:05:00Z" }));
  await cutShortAt(inner, old);
  const { puts, manifests } = await due(inner, old.getTime() + 2 * HOUR);
  expect(manifests[0]?.name).toBe(snapshotName(old));
  expect(puts.some((k) => k.includes("/repos/"))).toBe(false);
});

test("takeIfDue ignores a prefix older than the resume window", async () => {
  const inner = dirStore(join(root, "store-due2"));
  const old = new Date("2026-11-02T08:00:00Z");
  await cutShortAt(inner, old);
  const { puts, manifests } = await due(inner, old.getTime() + RESUME_WINDOW_MS + HOUR);
  expect(manifests.map((m) => m.name)).not.toContain(snapshotName(old));
  expect(puts.some((k) => k.includes("/repos/"))).toBe(true);
});

test("takeIfDue ignores a prefix with no journal", async () => {
  const inner = dirStore(join(root, "store-due3"));
  const old = new Date("2026-11-02T08:00:00Z");
  await inner.put(`snapshots/${snapshotName(old)}/forge.db`, "x");
  const { puts, manifests } = await due(inner, old.getTime() + 2 * HOUR);
  expect(manifests.map((m) => m.name)).not.toContain(snapshotName(old));
  expect(puts.some((k) => k.includes("/repos/"))).toBe(true);
});

test("a plain due snapshot takes fresh", async () => {
  const inner = dirStore(join(root, "store-due4"));
  const { puts, manifests } = await due(inner, Date.now());
  expect(manifests).toHaveLength(1);
  expect(puts.some((k) => k.includes("/repos/"))).toBe(true);
});

test("pruning removes a cut-short prefix nothing will resume, and keeps one that may be", async () => {
  const s = dirStore(join(root, "store-prune"));
  const whole = new Date("2026-11-02T08:00:00Z");
  await s.put(`snapshots/${snapshotName(whole)}/manifest.json`, "{}");
  const behind = `snapshots/2026-11-01T08-00-00Z/`;
  const stale = `snapshots/2026-10-01T08-00-00Z/`;
  const ahead = `snapshots/2026-11-02T20-00-00Z/`;
  for (const p of [behind, stale, ahead]) {
    await s.put(p + JOURNAL, "[]");
    await s.put(p + "repos/a.bundle", "x");
  }
  const gone = await pruneSnapshots(s, 14, whole.getTime() + 13 * HOUR);
  expect(gone.sort()).toEqual(["2026-10-01T08-00-00Z", "2026-11-01T08-00-00Z"]);
  expect(await s.list(ahead)).toHaveLength(2);
  expect(await s.list(behind)).toHaveLength(0);
});
