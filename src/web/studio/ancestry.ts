/**
 * Ancestries that git has answered, kept across pages. The ancestors of a
 * commit never change, so an answer is good for as long as it is kept; a
 * deploy that lands is a different commit and a different key. Bounded by
 * the commits held (not entries), least recently used out first, and an
 * answer longer than a quarter of the bound is not kept at all, so a few
 * huge repositories cannot hold the process's memory. Holds commit ids
 * only: nothing in it depends on who is looking.
 *
 * A miss with an answer already kept for the same directory (production's
 * previous commit, after a deploy) asks git only for the commits since it
 * (`ancestorsSince`) and adds them to the kept set: a few milliseconds where
 * the whole history costs tens (#8388). When the kept commit is not an
 * ancestor of the new one — a force push — the whole history is read.
 */

import { ancestorsOf, ancestorsSince } from "../../git/merge.ts";

type Read = (
  dir: string,
  oid: string,
) => Promise<ReadonlySet<string> | undefined>;

type Since = (
  dir: string,
  oid: string,
  base: string,
) => Promise<{ added: ReadonlySet<string>; reaches: boolean } | undefined>;

export class AncestryCache {
  private readonly kept = new Map<string, ReadonlySet<string>>();
  private held = 0;
  private asked = 0;
  private extended = 0;

  constructor(
    private readonly limit: number,
    private readonly read: Read = ancestorsOf,
    private readonly since: Since = ancestorsSince,
  ) {}

  /** The commits reachable from `oid` in `dir`, from memory when git already said. */
  async of(
    dir: string,
    oid: string,
  ): Promise<ReadonlySet<string> | undefined> {
    const key = `${dir}\0${oid}`;
    const hit = this.kept.get(key);
    if (hit !== undefined) {
      this.kept.delete(key);
      this.kept.set(key, hit);
      return hit;
    }
    const grown = await this.grow(dir, oid);
    if (grown !== undefined) {
      this.remember(key, grown);
      return grown;
    }
    this.asked++;
    const set = await this.read(dir, oid);
    if (set !== undefined) this.remember(key, set);
    return set;
  }

  /** The ancestry of `oid` as the freshest kept one in `dir` plus the commits since it. */
  private async grow(
    dir: string,
    oid: string,
  ): Promise<ReadonlySet<string> | undefined> {
    const prefix = `${dir}\0`;
    let base: string | undefined;
    for (const key of this.kept.keys())
      if (key.startsWith(prefix)) base = key.slice(prefix.length);
    if (base === undefined) return undefined;
    this.asked++;
    const since = await this.since(dir, oid, base);
    if (since === undefined || !since.reaches) return undefined;
    const kept = this.kept.get(prefix + base);
    if (kept === undefined) return undefined; // evicted while git answered
    this.extended++;
    const set = new Set(kept);
    for (const c of since.added) set.add(c);
    return set;
  }

  private remember(key: string, set: ReadonlySet<string>): void {
    if (set.size > this.limit / 4 || this.kept.has(key)) return;
    this.kept.set(key, set);
    this.held += set.size;
    for (const [old, size] of this.kept) {
      if (this.held <= this.limit) break;
      this.kept.delete(old);
      this.held -= size.size;
    }
  }

  /** How many times git was asked, for tests that prove a page did not ask. */
  get reads(): number {
    return this.asked;
  }

  /** How many of those asks grew an answer from a kept one rather than reading the whole history. */
  get grown(): number {
    return this.extended;
  }

  has(dir: string, oid: string): boolean {
    return this.kept.has(`${dir}\0${oid}`);
  }
}

export const ancestries = new AncestryCache(400_000);
