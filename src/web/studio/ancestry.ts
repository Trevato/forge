/**
 * Ancestries that git has answered, kept across pages. The ancestors of a
 * commit never change, so an answer is good for as long as it is kept; a
 * deploy that lands is a different commit and a different key. Bounded by
 * the commits held (not entries), least recently used out first, and an
 * answer longer than a quarter of the bound is not kept at all, so a few
 * huge repositories cannot hold the process's memory. Holds commit ids
 * only: nothing in it depends on who is looking.
 */

import { ancestorsOf } from "../../git/merge.ts";

type Read = (
  dir: string,
  oid: string,
) => Promise<ReadonlySet<string> | undefined>;

export class AncestryCache {
  private readonly kept = new Map<string, ReadonlySet<string>>();
  private held = 0;
  private asked = 0;

  constructor(
    private readonly limit: number,
    private readonly read: Read = ancestorsOf,
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
    this.asked++;
    const set = await this.read(dir, oid);
    if (set !== undefined) this.remember(key, set);
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

  has(dir: string, oid: string): boolean {
    return this.kept.has(`${dir}\0${oid}`);
  }
}

export const ancestries = new AncestryCache(400_000);
