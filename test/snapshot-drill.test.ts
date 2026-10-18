/**
 * The restore drill. A seeded forge's snapshot drills green with the right
 * counts; a corrupt one drills red naming the step; a hang ends red naming
 * the step; the scratch directory is gone afterwards in every case.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { enableApp, setAppEnvVar } from "../src/actions/apps.ts";
import { createApp, type App } from "../src/app.ts";
import { createIssue } from "../src/core/issues.ts";
import { createUser } from "../src/core/users.ts";
import { runDrill } from "../src/snapshot/drill.ts";
import { pack, partPath } from "../src/snapshot/parts.ts";
import { takeSnapshot } from "../src/snapshot/snapshot.ts";
import { dirStore } from "../src/snapshot/store.ts";

const PASS = "correct horse battery staple";

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

  test("a step that times out says its budget in whole milliseconds", async () => {
    const r = await runDrill(deps({ timeoutMs: 1500.75, restore: () => new Promise(() => {}) }));
    expect(r.reason).toMatch(/^restore timed out: no answer in \d+ ms$/);
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
