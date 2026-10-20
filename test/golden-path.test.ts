/** How long New app took to its first preview and to production. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { firstPreviews, goldenPath, goldenPathLine, spanWords } from "../src/apps/golden_path.ts";
import { appPace } from "../src/actions/apps.ts";
import { getRepo } from "../src/core/repos.ts";
import { createApp as insertApp, type AppRecord } from "../src/core/apps.ts";
import { createUser, type User } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (ms: number): string => new Date(T0 + ms).toISOString();

describe("the golden path's figures", () => {
  let dataDir = "";
  let app: App;
  let alice: User;
  let n = 0;

  const fresh = async (): Promise<AppRecord> => {
    n += 1;
    const repo = await createRepo(app, alice, { name: `gp${n}`, visibility: "private" });
    if (!repo.ok) throw new Error(repo.error);
    const made = insertApp(app.db, { repoId: repo.value.id, slug: `gp${n}`, access: "private" });
    if (!made.ok) throw new Error(made.error);
    app.db.query("UPDATE app SET created_at = ?1 WHERE id = ?2").run(at(0), made.value.id);
    return { ...made.value, createdAt: at(0) };
  };
  const deploy = (repoId: string, env: string, created: number, serving: number | null): void => {
    app.db
      .query(
        `INSERT INTO run (id, repo_id, kind, env, state, created_at, serving_at)
         VALUES (?1, ?2, 'deploy', ?3, 'ok', ?4, ?5)`,
      )
      .run(`r${Math.random()}`, repoId, env, at(created), serving === null ? null : at(serving));
  };
  const merge = (repoId: string, number: number, mergedAt: number): void => {
    const row = app.db
      .query<{ default_branch: string }, [string]>("SELECT default_branch FROM repo WHERE id = ?1")
      .get(repoId)!;
    app.db
      .query(
        `INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES (?1, ?2, ?3, 'pull', 'p', ?4)`,
      )
      .run(`i${repoId}${number}`, repoId, number, alice.id);
    app.db
      .query(
        `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at)
         VALUES (?1, ?2, 'h', 'a', 'b', ?3)`,
      )
      .run(`i${repoId}${number}`, row.default_branch, at(mergedAt));
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-golden-path-"));
    app = createApp({ dataDir, port: 0 });
    const made = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice", email: "alice@forge.test",
      password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an app with no preview yet has no figures and no line", async () => {
    const record = await fresh();
    deploy(record.repoId, "pull-1", 1000, null);
    expect(goldenPath(app.db, record)).toEqual({});
    expect(goldenPathLine({})).toBe("");
  });

  test("a preview that served is the first figure", async () => {
    const record = await fresh();
    deploy(record.repoId, "pull-2", 60_000, 200_000);
    deploy(record.repoId, "pull-1", 1000, 134_000);
    const path = goldenPath(app.db, record);
    expect(path).toEqual({ firstPreviewMs: 134_000 });
    expect(goldenPathLine(path)).toBe("first preview 2m 14s after New app");
  });

  test("a merged change served in production is the second", async () => {
    const record = await fresh();
    deploy(record.repoId, "pull-1", 1000, 134_000);
    deploy(record.repoId, "production", 10_000, 20_000); // before any merge: not the change
    merge(record.repoId, 1, 400_000);
    expect(goldenPath(app.db, record)).toEqual({ firstPreviewMs: 134_000 });
    deploy(record.repoId, "production", 401_000, 540_000);
    const path = goldenPath(app.db, record);
    expect(path).toEqual({ firstPreviewMs: 134_000, firstProductionChangeMs: 540_000 });
    expect(goldenPathLine(path)).toBe("first preview 2m 14s after New app · in production 9m");
  });

  test("the terminal's line is the same words, for a reader only", async () => {
    const record = await fresh();
    deploy(record.repoId, "pull-1", 1000, 134_000);
    const repo = getRepo(app.db, "alice", `gp${n}`)!;
    expect(appPace(app, alice, repo)).toBe("first preview 2m 14s after New app");
    expect(appPace(app, undefined, repo)).toBe("");
  });

  test("spans read in at most two units", () => {
    expect(spanWords(14_000)).toBe("14s");
    expect(spanWords(134_000)).toBe("2m 14s");
    expect(spanWords(600_000 + 14_000)).toBe("10m");
    expect(spanWords(7_200_000)).toBe("2h");
    expect(spanWords(3 * 86_400_000 + 5 * 3_600_000)).toBe("3d 5h");
    expect(spanWords(3_900_000)).toBe("1h 5m");
    expect(spanWords(3 * 86_400_000)).toBe("3d");
  });

  test("firstPreviews reads many apps in one query and matches goldenPath", async () => {
    const apps = [await fresh(), await fresh(), await fresh()];
    deploy(apps[0]!.repoId, "pull-1", 0, 9_000);
    deploy(apps[0]!.repoId, "pull-2", 0, 30_000);
    deploy(apps[1]!.repoId, "pull-1", 0, null);
    let queries = 0;
    const counted = new Proxy(app.db, {
      get(target, key) {
        if (key === "query" || key === "prepare") queries += 1;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const found = firstPreviews(counted, apps);
    expect(queries).toBe(1);
    expect([...found]).toEqual([[apps[0]!.repoId, 9_000]]);
    expect(goldenPath(app.db, apps[0]!).firstPreviewMs).toBe(9_000);
  });
});
