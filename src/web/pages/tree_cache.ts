/**
 * The rendered listing of one directory at one commit (#8199).
 *
 * A branch page costs a tree read, a ref list, the explorer's walk and the
 * README render, and strangers ask for the same few directories again and
 * again. For an anonymous reader of a public repository the markup depends
 * on nothing but the commit, the path and the ref spelled in the URL, so it
 * is kept under that key. The branch is resolved to its commit once, from the
 * ref files (no process); a push moves the branch, so the next request keys
 * on the new commit and the old entry simply ages out. The ref switcher's
 * menu is the one part a new branch elsewhere can change: it is at most
 * `TTL_MS` stale. Nothing here is truth: any entry can be dropped.
 */

import { isFullId } from "../../http/addressed.ts";
import { refTip } from "../../git/read.ts";
import { ViewCache } from "../../view/cache.ts";
import { clearKeptPages } from "./kept_page.ts";
import type { BlobForRender } from "../../git/read.ts";
import type { RepoSource } from "../../view/source.ts";
import type { RefSet } from "./refs.ts";
import type { Html } from "../html.ts";

export const TTL_MS = 60_000;

export interface RenderedTree {
  readonly explorer: Html;
  readonly content: Html;
}

/** Bytes the page columns may hold; shown on /system. */
export const COLUMN_BYTES = 32 * 1024 * 1024;
const cache = new ViewCache({ maxEntries: 512, maxBytes: COLUMN_BYTES });

/** The commit `ref` names: a full id itself, a branch by its ref file; undefined for anything else (the caller reads git). */
export async function resolveCommit(dir: string, ref: string): Promise<string | undefined> {
  if (isFullId(ref)) return ref;
  return refTip(dir, `refs/heads/${ref}`);
}

const keyOf = (repoId: string, commit: string, ref: string, path: string, all: boolean): string =>
  [repoId, commit, ref, path, all ? "all" : "window"].join("\0");

export const cachedTree = (repoId: string, commit: string, ref: string, path: string, all: boolean) =>
  cache.get<RenderedTree>(keyOf(repoId, commit, ref, path, all));

export function keepTree(repoId: string, commit: string, ref: string, path: string, all: boolean, tree: RenderedTree): void {
  cache.set(keyOf(repoId, commit, ref, path, all), tree, TTL_MS, tree.explorer.text.length + tree.content.text.length);
}

export const treeCacheStats = () => cache.stats();

/** Test seam: start from nothing. */
export const clearTreeCache = (): void => {
  cache.clear();
  rawCache.clear();
  mediaCache.clear();
  parts.clear();
  clearKeptPages();
};

/**
 * The parts a stranger's page is built from, kept between pages (#9514).
 * A file's page reads its folder and every folder above it for the explorer,
 * and the branch and tag names for the ref switcher: five git runs for
 * `src/web/x.ts`, ~16 ms of the git pool, while the rendered pages above only
 * help the second reader of that same file. A folder's listing at a full
 * commit id never changes, and the files of one folder share it, so a wide
 * crawl of a repository reads each folder once. The ref names are kept
 * `TTL_MS`, the staleness the kept pages already allow their switcher.
 */
/** Bytes the folders and ref names may hold; shown on /system. */
export const PARTS_BYTES = 16 * 1024 * 1024;
const parts = new ViewCache({ maxEntries: 8192, maxBytes: PARTS_BYTES });
/** A folder at a commit cannot change: kept for as long as it fits. */
const FOLDER_TTL_MS = 10 * 60_000;

/** `source` with `tree` at a full commit id read once and kept: the explorer's folders for a stranger's page. */
export function withKeptFolders(repoId: string, source: RepoSource): RepoSource {
  const kept: RepoSource = Object.create(source);
  return Object.assign(kept, {
    tree: async (ref: string, path: string) => {
      if (!isFullId(ref)) return source.tree(ref, path);
      const key = ["folder", repoId, ref, path].join("\0");
      const hit = parts.get<Awaited<ReturnType<RepoSource["tree"]>>>(key);
      if (hit !== undefined) return hit;
      const read = await source.tree(ref, path);
      if (read.ok) parts.set(key, read, FOLDER_TTL_MS, 64 + read.value.reduce((n, e) => n + 64 + e.name.length * 2, 0));
      return read;
    },
  });
}

/** The branch and tag names for a stranger's ref switcher, read at most once per `TTL_MS` a repository. */
export async function keptRefs(repoId: string, read: () => Promise<RefSet>): Promise<RefSet> {
  const key = ["refs", repoId].join("\0");
  const hit = parts.get<RefSet>(key);
  if (hit !== undefined) return hit;
  const refs = await read();
  const bytes = [...refs.branches, ...refs.tags].reduce((n, r) => n + 32 + r.length * 2, 64);
  parts.set(key, refs, TTL_MS, bytes);
  return refs;
}

export const keptPartsStats = () => parts.stats();

/**
 * A file's page at one full commit id (#9405). Same reasoning as the listing:
 * a commit names its bytes forever, so an anonymous reader's markup depends on
 * nothing but the commit, the path and the view; after the first read the page
 * costs no git read at all.
 */
export interface RenderedBlob extends RenderedTree {
  readonly title: string;
  readonly objectSrc: boolean;
  readonly frame: boolean;
  readonly csv: boolean;
  readonly font: boolean;
}

const blobKey = (repoId: string, commit: string, path: string, view: string, all: boolean): string =>
  ["blob", repoId, commit, path, view, all ? "all" : "window"].join("\0");

export const cachedBlobPage = (repoId: string, commit: string, path: string, view: string, all: boolean) =>
  cache.get<RenderedBlob>(blobKey(repoId, commit, path, view, all));

export function keepBlobPage(repoId: string, commit: string, path: string, view: string, all: boolean, page: RenderedBlob): void {
  cache.set(blobKey(repoId, commit, path, view, all), page, TTL_MS, page.explorer.text.length + page.content.text.length);
}

/** A file's bytes at a full commit id, for `/raw`: small bodies only, so a few big files cannot fill the cache. */
const RAW_MAX = 1024 * 1024;
const rawCache = new ViewCache({ maxEntries: 512, maxBytes: 32 * 1024 * 1024 });
const rawKey = (repoId: string, commit: string, path: string): string => ["raw", repoId, commit, path].join("\0");

export const cachedRaw = (repoId: string, commit: string, path: string) => rawCache.get<BlobForRender>(rawKey(repoId, commit, path));

export function keepRaw(repoId: string, commit: string, path: string, blob: BlobForRender): void {
  if (blob.kind === "missing" || blob.kind === "too_large") return;
  if (blob.size <= RAW_MAX) rawCache.set(rawKey(repoId, commit, path), blob, TTL_MS, blob.size);
}

/** A small media file at a full commit id (#9505): its blob id and bytes, so a repeat read spawns no git. */
export interface KeptMedia {
  readonly oid: string;
  readonly body: Uint8Array;
}
const MEDIA_MAX = 1024 * 1024;
const mediaCache = new ViewCache({ maxEntries: 512, maxBytes: 32 * 1024 * 1024 });
const mediaKey = (repoId: string, commit: string, path: string): string => ["media", repoId, commit, path].join("\0");

export const cachedMedia = (repoId: string, commit: string, path: string) => mediaCache.get<KeptMedia>(mediaKey(repoId, commit, path));

export function keepMedia(repoId: string, commit: string, path: string, media: KeptMedia): void {
  if (media.body.length <= MEDIA_MAX) mediaCache.set(mediaKey(repoId, commit, path), media, TTL_MS, media.body.length + 128);
}
