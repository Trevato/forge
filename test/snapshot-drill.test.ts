/**
 * The restore drill. A seeded forge's snapshot drills green with the right
 * counts; a corrupt one drills red naming the step; a hang ends red naming
 * the step; the scratch directory is gone afterwards in every case.
 */
import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { enableApp, setAppEnvVar } from "../src/actions/apps.ts";
import { createApp, type App } from "../src/app.ts";
import { createIssue } from "../src/core/issues.ts";
import { createUser } from "../src/core/users.ts";
import { drillBudgetMs, formatBudget, formatBytes, formatMinutes, runDrill } from "../src/snapshot/drill.ts";
import { pack, partPath } from "../src/snapshot/parts.ts";
import { takeSnapshot } from "../src/snapshot/snapshot.ts";
import { dirStore } from "../src/snapshot/store.ts";

const PASS = "correct horse battery staple";

describe("the drill's budget", () => {
  const GiB = 1024 ** 3;
  const MB = 1_000_000;
  test("an empty snapshot gets the 10 min floor", () => {
    expect(drillBudgetMs(0)).toBe(600_000);
  });
  test("400 MB gets 10 min + 400 × 1 s = 16 min 40 s", () => {
    expect(drillBudgetMs(400 * MB)).toBe(1_000_000);
    expect(formatMinutes(drillBudgetMs(400 * MB))).toBe("16.7 min");
  });
  test("334 MB, the database that ran out of a flat 10 min, gets 15 min 34 s", () => {
    expect(drillBudgetMs(334 * MB)).toBe(934_000);
  });
  test("2.1 GB reaches the 45 min ceiling, and 100 GiB stays at it", () => {
    expect(drillBudgetMs(2_100 * MB)).toBe(2_700_000);
    expect(drillBudgetMs(2_099 * MB)).toBe(2_699_000);
    expect(drillBudgetMs(100 * GiB)).toBe(2_700_000);
  });
  test("a size that is not a count of bytes counts as 0", () => {
    for (const b of [NaN, -5, Infinity]) expect(drillBudgetMs(b)).toBe(600_000);
  });
  test("budgets read in min, s or whole ms, never a raw float", () => {
    expect(formatBudget(840_000)).toBe("14 min");
    expect(formatBudget(846_000)).toBe("14.1 min");
    expect(formatBudget(1500.75)).toBe("1.5 s");
    expect(formatBudget(250.4)).toBe("250 ms");
  });
  test("the card's budget is always in minutes", () => {
    expect(formatMinutes(2_700_000)).toBe("45 min");
    expect(formatMinutes(1_000_000)).toBe("16.7 min");
    expect(formatMinutes(1_500)).toBe("0.1 min");
    expect(formatMinutes(NaN)).toBe("0 min");
  });
  test("sizes read in binary units with one decimal", () => {
    expect(formatBytes(Math.round(4.1 * GiB))).toBe("4.1 GiB");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
  });
});

describe("the restore drill", () => {
  let root: string;
  let app: App;
  const store = () => dirStore(join(root, "store"));
  const scratchLeft = (): string[] => {
    const d = join(root, "drill-data", "drill");
    return existsSync(d) ? readdirSync(d) : [];
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "forge-drill-"));
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
    const repo = await createRepo(app, a.value, {
      name: "notes",
      visibility: "private",
    });
    if (!repo.ok) throw new Error(String(repo.error));
    const c = await commitToBranch(app, a.value, repo.value, {
      message: "first",
      files: [{ path: "README.md", content: "# notes\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    for (const title of ["one", "two"])
      createIssue(app.db, {
        repoId: repo.value.id,
        authorId: a.value.id,
        title,
      });
    const enabled = enableApp(app, a.value, repo.value);
    if (!enabled.ok) throw new Error(String(enabled.error));
    const set = await setAppEnvVar(
      app,
      a.value,
      repo.value,
      "SECRET_WORD",
      "swordfish",
      "all",
    );
    if (!set.ok) throw new Error(String(set.error));
    await takeSnapshot(
      {
        db: app.db,
        dataDir: app.config.dataDir,
        reposRoot: app.reposRoot,
        version: "t",
        passphrase: PASS,
        // Small parts, so the drill restores a database that went up in several.
        partBytes: 4096,
      },
      store(),
      new Date("2026-09-22T08:00:00Z"),
    );
  });

  afterAll(async () => {
    app.close();
    await rm(root, { recursive: true, force: true });
  });

  const deps = (extra = {}) => ({
    store: store(),
    dataDir: join(root, "drill-data"),
    passphrase: PASS,
    // The boot has its own test (drill-verdict); here it answers healthy.
    boot: async () => ({ ok: true, reason: "" }),
    ...extra,
  });

  test("a good snapshot drills green with the right counts, and nothing is left", async () => {
    const r = await runDrill(deps());
    expect(r.verdict).toBe("green");
    expect(r.failedStep).toBeNull();
    expect(r.snapshotId).toBe("2026-09-22T08-00-00Z");
    const manifest = JSON.parse(
      new TextDecoder().decode((await store().get("snapshots/2026-09-22T08-00-00Z/manifest.json"))!),
    );
    expect(manifest.packed[0].parts).toBeGreaterThan(1);
    expect(r.counts).toEqual({ repositories: 1, issues: 2, users: 1, pulls: 0, apps: 1 });
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(scratchLeft()).toEqual([]);
  });

  test("a sealed value that cannot open (no passphrase, so no key) is red at unseal", async () => {
    const r = await runDrill(deps({ passphrase: undefined }));
    expect(r.verdict).toBe("red");
    expect(r.failedStep).toBe("unseal");
    expect(scratchLeft()).toEqual([]);
  });

  test("a snapshot whose database is not one drills red, naming the step, and nothing is left", async () => {
    const s = store();
    const manifest = JSON.parse(
      new TextDecoder().decode(
        (await s.get("snapshots/2026-09-22T08-00-00Z/manifest.json"))!,
      ),
    );
    const db = manifest.packed.find(
      (p: { path: string }) => p.path === "forge.db",
    );
    // Same size, packed the same way, so the restore accepts it; only opening it can tell.
    const junk = await pack("forge.db", new Uint8Array(db.bytes).fill(7));
    for (const [n, part] of junk.parts.entries())
      await s.put(`snapshots/2026-09-23T08-00-00Z/${partPath("forge.db", n)}`, part);
    const files = [
      ...junk.parts.map((part, n) => ({ path: partPath("forge.db", n), bytes: part.byteLength })),
      ...manifest.files.filter((f: { path: string }) => !f.path.startsWith("forge.db.zst.")),
    ];
    for (const f of files)
      if (!f.path.startsWith("forge.db.zst."))
        await s.put(
          `snapshots/2026-09-23T08-00-00Z/${f.path}`,
          (await s.get(`snapshots/2026-09-22T08-00-00Z/${f.path}`))!,
        );
    await s.put(
      "snapshots/2026-09-23T08-00-00Z/manifest.json",
      JSON.stringify({ ...manifest, name: "2026-09-23T08-00-00Z", files, packed: [junk.packed] }),
    );
    const r = await runDrill(deps());
    expect(r.snapshotId).toBe("2026-09-23T08-00-00Z");
    expect(r.verdict).toBe("red");
    expect(r.failedStep).toBe("open");
    expect(scratchLeft()).toEqual([]);
  });

  test("a restore that hangs ends red at restore, and nothing is left", async () => {
    const r = await runDrill(
      deps({
        timeoutMs: 1500, // one clock covers fetch too; 50 ms lost to a loaded shard
        restore: () => new Promise(() => {}),
      }),
    );
    expect(r.verdict).toBe("red");
    expect(r.failedStep).toBe("restore");
    expect(r.reason).toContain("timed out");
    expect(scratchLeft()).toEqual([]);
  });

  test("a restore that reports progress and then hangs names the phase and the counts", async () => {
    const r = await runDrill(
      deps({
        timeoutMs: 1500,
        restore: (async (_s: unknown, _n: unknown, _t: unknown, o: { onProgress?: (p: unknown) => void }) => {
          o.onProgress?.({ phase: "files", done: 3, total: 3, bytes: 100 });
          o.onProgress?.({ phase: "bundles", done: 37, total: 212, bytes: Math.round(1.8 * 1024 ** 3) });
          await new Promise(() => {});
        }) as never,
      }),
    );
    expect(r.failedStep).toBe("restore");
    expect(r.reason).toBe("restore timed out in bundles (37 of 212 cloned, 1.8 GiB fetched) after its 1.5 s budget");
  });

  test("a step that times out names its budget and the snapshot's size, never a raw float of ms", async () => {
    const r = await runDrill(deps({ timeoutMs: 1500.75, restore: () => new Promise(() => {}) }));
    expect(r.reason).toMatch(/^restore timed out: no answer within its 1\.5 s budget for a [\d.]+ (B|KiB|MiB) snapshot$/);
  });

  /** A store holding one snapshot with this manifest; its objects are never fetched. */
  const holding = (manifest: object) => ({
    where: "test",
    put: async () => {},
    get: async (key: string) =>
      key === "snapshots/2026-10-18T08-00-00Z/manifest.json"
        ? new TextEncoder().encode(JSON.stringify({ name: "2026-10-18T08-00-00Z", ...manifest }))
        : undefined,
    list: async () => [],
    names: async () => ["2026-10-18T08-00-00Z"],
    delete: async () => {},
  });

  /** Drill `manifest` with a restore that hangs, on fake timers; still waiting at `quietMs`, red by `redMs`. */
  async function hang(manifest: object, quietMs: number, redMs: number) {
    let begun!: () => void;
    const restoring = new Promise<void>((resolve) => (begun = resolve));
    jest.useFakeTimers();
    try {
      let done = false;
      const running = runDrill(
        deps({
          store: holding(manifest),
          restore: () => {
            begun();
            return new Promise(() => {});
          },
        }),
      ).finally(() => (done = true));
      await restoring;
      jest.advanceTimersByTime(quietMs);
      await Promise.resolve();
      expect(done).toBe(false);
      jest.advanceTimersByTime(redMs - quietMs);
      const r = await running;
      expect(r.verdict).toBe("red");
      expect(r.failedStep).toBe("restore");
      return r;
    } finally {
      jest.useRealTimers();
      expect(scratchLeft()).toEqual([]);
    }
  }

  test("with no timeout given, a hanging restore of a 400 MB snapshot has 10 min + 1 s per MB", async () => {
    const bytes = 400_000_000;
    // 600 + 400 = 1000 s; still waiting a second before, red just after.
    const r = await hang({ files: [{ path: "forge.db", bytes }], bytes }, 999_000, 1_000_001);
    expect(r.reason).toBe("restore timed out: no answer within its 16.7 min budget for a 381.5 MiB snapshot");
  });

  test("a manifest with no total, or one that is not a number, is sized by the sum of its files", async () => {
    const files = [
      { path: "forge.db", bytes: 150_000_000 },
      { path: "repos/a/b.bundle", bytes: 150_000_000 },
    ];
    // 150 + 150 MB: 600 + 300 s = 15 min; still waiting just before, red just after.
    for (const manifest of [{ files }, { files, bytes: "300 MB" }]) {
      const r = await hang(manifest, 15 * 60_000 - 1_000, 15 * 60_000 + 1);
      expect(r.reason).toBe("restore timed out: no answer within its 15 min budget for a 286.1 MiB snapshot");
    }
  });

  test("an empty store is red at fetch", async () => {
    const r = await runDrill(
      deps({ store: dirStore(join(root, "nothing")) }),
    );
    expect(r.verdict).toBe("red");
    expect(r.failedStep).toBe("fetch");
    expect(r.snapshotId).toBeNull();
  });
});
