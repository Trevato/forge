/**
 * PNG cards on disk: one file per sha256 of the card's inputs, under the
 * app's data directory, so a card is rasterized once however many times it
 * is asked for. The cache holds at most `OG_PNG_CAP` files; past that the
 * least recently used go. Concurrent first requests share one render, cold
 * renders run one at a time, and past `OG_PNG_QUEUE` waiting the cache refuses
 * (a throw, which the route answers as 503) so a crawl cannot hold the loop.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CardInput } from "./card.ts";
import type { Rasterizer } from "./raster.ts";

export const OG_PNG_CAP = 512;
export const OG_PNG_QUEUE = 4;
/** Bump when the card's look or the fonts change: old files are then unreachable. */
const LOOK = "1";

/** Thrown when too many cards wait; working as designed, not a failure. */
export class Busy extends Error {}

export function cardKey(input: CardInput): string {
  return createHash("sha256").update(`${LOOK}\n${JSON.stringify(input)}`).digest("hex");
}

export interface PngCache {
  /** The card's PNG; throws when it cannot be rasterized. */
  get(input: CardInput): Promise<Uint8Array>;
}

export function pngCache(opts: {
  dir: string;
  raster: () => Promise<Rasterizer>;
  svg: (input: CardInput) => string;
  cap?: number;
  queue?: number;
}): PngCache {
  const cap = opts.cap ?? OG_PNG_CAP;
  const maxQueue = opts.queue ?? OG_PNG_QUEUE;
  /** Cold renders running or waiting; `tail` ends when the last of them does. */
  let queued = 0;
  let tail: Promise<unknown> = Promise.resolve();
  /** key → seen order; the first entry is the least recently used. */
  const lru = new Map<string, true>();
  const pending = new Map<string, Promise<Uint8Array>>();
  let scanned: Promise<void> | undefined;

  const path = (key: string) => join(opts.dir, `${key}.png`);

  const scan = () =>
    (scanned ??= (async () => {
      await mkdir(opts.dir, { recursive: true });
      const found: [string, number][] = [];
      for (const name of await readdir(opts.dir)) {
        if (!/^[0-9a-f]{64}\.png$/.test(name)) continue;
        const s = await stat(join(opts.dir, name)).catch(() => undefined);
        if (s) found.push([name.slice(0, 64), s.mtimeMs]);
      }
      for (const [key] of found.sort((a, b) => a[1] - b[1])) lru.set(key, true);
      await trim();
    })());

  async function trim(): Promise<void> {
    while (lru.size > cap) {
      const oldest = lru.keys().next().value as string;
      lru.delete(oldest);
      await unlink(path(oldest)).catch(() => {});
    }
  }

  async function make(key: string, input: CardInput): Promise<Uint8Array> {
    const png = (await opts.raster())(opts.svg(input));
    const tmp = path(key) + `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    // The directory may have been removed since the scan.
    await mkdir(opts.dir, { recursive: true });
    try {
      await writeFile(tmp, png);
      await rename(tmp, path(key));
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
    lru.set(key, true);
    await trim();
    return png;
  }

  return {
    async get(input) {
      const key = cardKey(input);
      await scan();
      const hit = Bun.file(path(key));
      if (await hit.exists()) {
        lru.delete(key);
        lru.set(key, true);
        const now = new Date();
        utimes(path(key), now, now).catch(() => {});
        return new Uint8Array(await hit.arrayBuffer());
      }
      let job = pending.get(key);
      if (!job) {
        if (queued >= maxQueue) throw new Busy("too many cards waiting to be rasterized");
        queued++;
        const run = tail.then(() => make(key, input));
        tail = run.catch(() => {});
        job = run.finally(() => {
          queued--;
          pending.delete(key);
        });
        pending.set(key, job);
      }
      return job;
    },
  };
}
