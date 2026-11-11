/**
 * Apps — the rows. An app is a repository that runs; the row holds what git
 * cannot say about it (the slug its hostnames hang off, who may reach it,
 * whether a preview starts from a copy of production's data) and nothing
 * git can. How it runs is `forge.json` in the tree (`apps/manifest.ts`);
 * what is running is a process (`apps/runtime.ts`). Pure data: no authz,
 * no events.
 */

import { PUBLIC_VISIBLE } from "./visibility.ts";
import type { Database } from "bun:sqlite";
import { id } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import type { PreviewData } from "../apps/data.ts";

export type AppAccess = "public" | "private";

export interface AppRecord {
  readonly id: string;
  readonly repoId: string;
  /** The hostname label: `<slug>.<domain>`, `<slug>--<n>.<domain>`. */
  readonly slug: string;
  /** Who may reach its environments: anyone, or someone the forge vouches for. */
  readonly access: AppAccess;
  /** What a new preview's data directory starts as. */
  readonly previewData: PreviewData;
  readonly createdAt: string;
}

interface AppRow {
  id: string;
  repo_id: string;
  slug: string;
  access: AppAccess;
  preview_data: PreviewData;
  created_at: string;
}

const toApp = (r: AppRow): AppRecord => ({
  id: r.id,
  repoId: r.repo_id,
  slug: r.slug,
  access: r.access,
  previewData: r.preview_data,
  createdAt: r.created_at,
});

/**
 * A slug that is also an environment's suffix: `<slug>--b<sha7>` is a build
 * preview, so no slug may be `b` and seven hex digits; `<slug>--v-<label>` is a variant (`core/variants.ts`), so none is `v-` and a label.
 */
const RESERVED_SLUG = /^b[0-9a-f]{7}$/;
const reserved = (slug: string): boolean => RESERVED_SLUG.test(slug) || /^v-[a-z0-9]{1,16}$/.test(slug);

/**
 * A slug is a DNS label: lowercase letters, digits, single hyphens inside.
 * `--` is reserved as the separator before a preview number, so a slug can
 * never contain it — which is what keeps `hello--12` unambiguous.
 */
export const SLUG_MAX = 40;
const SLUG = /^[a-z0-9](?:-?[a-z0-9])*$/;

export function isSlug(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= SLUG_MAX &&
    SLUG.test(value) &&
    !reserved(value)
  );
}

/** The slug a repository name suggests: lowercased, runs of junk to one `-`. */
export function slugFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return slug === "" ? "app" : reserved(slug) ? `${slug}-app` : slug;
}

export type CreateAppError = "invalid_slug" | "slug_taken" | "already_app";

export function createApp(
  db: Database,
  input: {
    repoId: string;
    slug: string;
    access: AppAccess;
    /** @default "copy" */
    previewData?: PreviewData;
  },
): Result<AppRecord, CreateAppError> {
  if (!isSlug(input.slug)) return err("invalid_slug");
  if (getAppByRepo(db, input.repoId)) return err("already_app");
  if (getAppBySlug(db, input.slug)) return err("slug_taken");
  const appId = id();
  try {
    db.query(
      "INSERT INTO app (id, repo_id, slug, access, preview_data) VALUES (?1, ?2, ?3, ?4, ?5)",
    ).run(
      appId,
      input.repoId,
      input.slug,
      input.access,
      input.previewData ?? "copy",
    );
  } catch (error) {
    // Two racing creates: the constraint settles it, the check above only
    // named it early.
    if (
      error instanceof Error &&
      /UNIQUE constraint failed/.test(error.message)
    ) {
      return err(getAppByRepo(db, input.repoId) ? "already_app" : "slug_taken");
    }
    throw error;
  }
  return ok(getAppById(db, appId)!);
}

export function getAppById(db: Database, appId: string): AppRecord | undefined {
  const row = db
    .query<AppRow, [string]>("SELECT * FROM app WHERE id = ?1")
    .get(appId);
  return row ? toApp(row) : undefined;
}

export function getAppByRepo(
  db: Database,
  repoId: string,
): AppRecord | undefined {
  const row = db
    .query<AppRow, [string]>("SELECT * FROM app WHERE repo_id = ?1")
    .get(repoId);
  return row ? toApp(row) : undefined;
}

export function getAppBySlug(
  db: Database,
  slug: string,
): AppRecord | undefined {
  const row = db
    .query<AppRow, [string]>("SELECT * FROM app WHERE slug = ?1 COLLATE NOCASE")
    .get(slug);
  return row ? toApp(row) : undefined;
}

/** Every app, oldest first — the runtime's boot list. */
export function listApps(db: Database): AppRecord[] {
  return db.query<AppRow, []>("SELECT * FROM app ORDER BY id").all().map(toApp);
}

/**
 * The apps whose repository is public — what any reader, signed in or not,
 * may see — newest first, at most `limit`. One query over the apps
 * themselves, so a forge with many plain repositories never crowds an app
 * out of the window.
 */
export function listPublicApps(db: Database, limit: number): AppRecord[] {
  return db
    .query<AppRow, [number]>(
      `SELECT app.* FROM app JOIN repo ON repo.id = app.repo_id
       WHERE ${PUBLIC_VISIBLE} ORDER BY app.id DESC LIMIT ?1`,
    )
    .all(limit)
    .map(toApp);
}

/** The apps among these repositories, keyed by repo id — one query. */
export function appsForRepos(
  db: Database,
  repoIds: readonly string[],
): Map<string, AppRecord> {
  const out = new Map<string, AppRecord>();
  const unique = [...new Set(repoIds)];
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<
        AppRow,
        string[]
      >(`SELECT * FROM app WHERE repo_id IN (${batch.map((_, n) => `?${n + 1}`).join(",")})`)
      .all(...batch);
    for (const row of rows) out.set(row.repo_id, toApp(row));
  }
  return out;
}

export interface AppPatch {
  slug?: string;
  access?: AppAccess;
  previewData?: PreviewData;
}

export type UpdateAppError = "invalid_slug" | "slug_taken";

export function updateApp(
  db: Database,
  appId: string,
  patch: AppPatch,
): Result<AppRecord | undefined, UpdateAppError> {
  if (patch.slug !== undefined) {
    if (!isSlug(patch.slug)) return err("invalid_slug");
    const holder = getAppBySlug(db, patch.slug);
    if (holder && holder.id !== appId) return err("slug_taken");
  }
  const sets: string[] = [];
  const params: (string | null)[] = [];
  if (patch.slug !== undefined) {
    params.push(patch.slug);
    sets.push(`slug = ?${params.length}`);
  }
  if (patch.access !== undefined) {
    params.push(patch.access);
    sets.push(`access = ?${params.length}`);
  }
  if (patch.previewData !== undefined) {
    params.push(patch.previewData);
    sets.push(`preview_data = ?${params.length}`);
  }
  if (sets.length > 0) {
    params.push(appId);
    db.query(
      `UPDATE app SET ${sets.join(", ")} WHERE id = ?${params.length}`,
    ).run(...params);
  }
  return ok(getAppById(db, appId));
}

export function deleteApp(db: Database, appId: string): boolean {
  return db.transaction(() => {
    db.run("DELETE FROM app_vital WHERE app_id = ?1", [appId]);
    db.run("DELETE FROM app_feature WHERE app_id = ?1", [appId]);
    db.run("DELETE FROM app_feature_setting WHERE app_id = ?1", [appId]);
    db.run("DELETE FROM feature_fire WHERE app_id = ?1", [appId]);
    db.run("DELETE FROM pull_run WHERE app_id = ?1", [appId]);
    return db.query("DELETE FROM app WHERE id = ?1").run(appId).changes > 0;
  })();
}
