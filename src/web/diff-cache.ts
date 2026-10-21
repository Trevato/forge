/**
 * The Files page's diff work, kept for the next reader of the same head.
 *
 * What costs time on `/pulls/N/files` is reading git and highlighting whole
 * blobs; both are pure functions of two commit oids. So that is what is kept:
 * the parsed diff and its syntax map, keyed by base oid, head oid and the
 * view's options. Nothing viewer-specific enters the key or the value —
 * review links, forms, threads and marks are drawn after it, per request.
 * In memory only, bounded by entries and by estimated bytes, least recently
 * used out first.
 */

import type { Diff } from "../git/diff.ts";
import type { SyntaxMap } from "./diff-view.ts";

export interface KeptDiff {
  /** The merge base the diff was taken from. */
  readonly from: string;
  readonly diff: Diff;
  readonly syntax: SyntaxMap;
  /** Git failed and this is a stand-in: serve it, never keep it. */
  readonly failed?: boolean;
}

/** The view options that change the diff itself. */
export interface DiffView {
  readonly whitespace?: "keep" | "ignore";
  readonly layout?: "unified" | "split";
}

export const MAX_ENTRIES = 32;
export const MAX_BYTES = 32 * 1024 * 1024;

const kept = new Map<string, { value: KeptDiff; bytes: number }>();
let total = 0;
let hits = 0;
let misses = 0;

/** What has been counted so far, for a Server-Timing phase and for tests. */
export function diffCacheCounts(): { hits: number; misses: number; entries: number; bytes: number } {
  return { hits, misses, entries: kept.size, bytes: total };
}

export function diffKey(baseOid: string, headOid: string, view: DiffView = {}): string {
  return `${baseOid}:${headOid}:${view.whitespace ?? "keep"}:${view.layout ?? "unified"}`;
}

/** A rough size: the text the diff and its tokens hold, doubled for overhead. */
export function sizeOf(value: KeptDiff): number {
  let n = 0;
  for (const file of value.diff.files)
    for (const hunk of file.hunks) for (const line of hunk.lines) n += line.content.length + 32;
  for (const tokens of value.syntax.values())
    for (const side of [tokens.old, tokens.new])
      for (const line of side ?? []) for (const t of line) n += t.text.length + 48;
  return n * 2;
}

/**
 * The kept diff for `key`, or what `make` builds, which is kept when it fits.
 * Callers must treat the value as read-only.
 */
export async function keptDiff(key: string, make: () => Promise<KeptDiff>): Promise<KeptDiff> {
  const known = kept.get(key);
  if (known !== undefined) {
    kept.delete(key);
    kept.set(key, known);
    hits++;
    return known.value;
  }
  misses++;
  const value = await make();
  const bytes = sizeOf(value);
  if (value.failed !== true && bytes <= MAX_BYTES && !kept.has(key)) {
    kept.set(key, { value, bytes });
    total += bytes;
    while (kept.size > MAX_ENTRIES || total > MAX_BYTES) {
      const oldest = kept.keys().next().value as string;
      total -= kept.get(oldest)!.bytes;
      kept.delete(oldest);
    }
  }
  return value;
}

/** Forget everything (tests). */
export function clearDiffCache(): void {
  kept.clear();
  total = 0;
  hits = 0;
  misses = 0;
}
