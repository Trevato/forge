/**
 * The public repositories as sitemap.xml and llms.txt list them, read once a
 * minute however many ask. Kept here, not with the pages, because whatever
 * changes who may be listed — a repository made private or deleted, an
 * account suspended or removed, an organization retired — says so at its
 * own write (`forgetListings`), so no caller can forget to.
 */

import type { Database } from "bun:sqlite";
import { Fresh } from "../kernel/fresh.ts";
import { listReposVisibleTo } from "./repos.ts";

const LISTING_MS = 60_000;
export const SITEMAP_ROWS = 5000;
export const LLMS_ROWS = 200;

interface Kept {
  readonly sitemap: Fresh<readonly string[]>;
  readonly llms: Fresh<readonly string[]>;
}
const kept = new WeakMap<Database, Kept>();

/** Test seam: how many times each listing was read from the database. */
export const listingBuilds = { sitemap: 0, llms: 0 };

function holders(db: Database): Kept {
  let k = kept.get(db);
  if (k === undefined) {
    k = {
      sitemap: new Fresh(LISTING_MS, 1),
      llms: new Fresh(LISTING_MS, 1),
    };
    kept.set(db, k);
  }
  return k;
}

/** Forget the kept listings: the next ask reads them again. */
export function forgetListings(db: Database): void {
  const k = kept.get(db);
  k?.sitemap.clear();
  k?.llms.clear();
}

/** `owner/name` of the newest public repositories, at most `SITEMAP_ROWS`. */
export function sitemapRepos(db: Database): readonly string[] {
  return holders(db).sitemap.get("", () => {
    listingBuilds.sitemap++;
    return names(db, SITEMAP_ROWS);
  });
}

/** `owner/name` of the newest public repositories, at most `LLMS_ROWS`. */
export function llmsRepos(db: Database): readonly string[] {
  return holders(db).llms.get("", () => {
    listingBuilds.llms++;
    return names(db, LLMS_ROWS);
  });
}

function names(db: Database, limit: number): string[] {
  return listReposVisibleTo(db, undefined, { limit }).map(
    (r) => `${r.ownerName}/${r.name}`,
  );
}
