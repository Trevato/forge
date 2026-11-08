/**
 * Main's looks: when a pull lands, the pictures taken at its head become
 * main's current look for each page, kind and theme. A later landing
 * replaces them page by page; a page only an earlier pull photographed
 * keeps that pull's picture. Only main's latest is kept, never every head.
 *
 * A copy, not a reference: the pull's environment folder is swept when it
 * closes. The copy is synchronous on the event path: fine for a few PNGs, so it must not grow. Files under `main-looks/<app id>/`, outside `looks/` so the
 * environment sweeps never reach them; the file is the record.
 */

import { copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import {
  DEFAULT_THEME,
  looksForEnv,
  type Look,
  type LookKind,
  type LookTheme,
} from "../core/looks.ts";

export const mainLooksRoot = (dataDir: string): string =>
  join(dataDir, "main-looks");

/** The id is the forge's own, but a path is built from it: refuse anything else. */
const SAFE = /^[A-Za-z0-9_-]+$/;

const fileFor = (
  dataDir: string,
  appId: string,
  page: string,
  kind: LookKind,
  theme: LookTheme,
): string | undefined =>
  SAFE.test(appId)
    ? join(
        mainLooksRoot(dataDir),
        appId,
        `${encodeURIComponent(page)}.${kind}.${theme}.png`,
      )
    : undefined;

/** Main's look for a page, kind and theme: the file's path, or nothing. */
export function mainLook(
  dataDir: string,
  appId: string,
  page: string,
  kind: LookKind,
  theme: LookTheme = DEFAULT_THEME,
): { readonly path: string } | undefined {
  const path = fileFor(dataDir, appId, page, kind, theme);
  return path !== undefined && existsSync(path) ? { path } : undefined;
}

/**
 * Keep what an environment's pictures show as main's looks. Call before
 * the environment is swept. Returns how many pictures were kept.
 */
export function keepAsMain(
  db: Database,
  dataDir: string,
  appId: string,
  env: string,
): number {
  // Newest first: the first of each slot is the head's.
  const seen = new Set<string>();
  let kept = 0;
  for (const look of looksForEnv(db, appId, env, "any") as Look[]) {
    if (look.error !== null || look.attachedBy !== null || look.path === "")
      continue;
    const slot = `${look.page}\0${look.kind}\0${look.theme}`;
    if (seen.has(slot)) continue;
    seen.add(slot);
    const from = join(dataDir, look.path);
    const to = fileFor(dataDir, appId, look.page, look.kind, look.theme);
    if (to === undefined || !existsSync(from)) continue;
    mkdirSync(join(to, ".."), { recursive: true });
    const tmp = `${to}.tmp`;
    copyFileSync(from, tmp);
    renameSync(tmp, to);
    kept++;
  }
  return kept;
}
