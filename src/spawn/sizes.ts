/**
 * Sizes: what small, medium and large mean for a child, in one table.
 * Plain data in, plain data out; nothing here reads or enforces a limit.
 */

import { err, ok, type Result } from "../kernel/result.ts";

export type Size = "small" | "medium" | "large";

export interface SizeLimits {
  readonly cpu: number;
  readonly memoryMiB: number;
  readonly diskMiB: number;
}

// A child is a whole forge: its own process, its apps, a crew run and a
// check, all held to one figure. One app's first deploy took a forge to
// 1195 MiB and another past 2 GiB, so a small forge never came up in 512.
export const SIZES: Readonly<Record<Size, SizeLimits>> = {
  small: { cpu: 1, memoryMiB: 2048, diskMiB: 2048 },
  medium: { cpu: 2, memoryMiB: 4096, diskMiB: 10240 },
  large: { cpu: 4, memoryMiB: 8192, diskMiB: 40960 },
};

/**
 * A child's disk bandwidth, held by the kernel (`io.max` on the device under
 * the forge's data, `apps/cgroup.ts`): bytes and operations a second, read
 * and write. One child's install or checkout cannot starve the forge's own
 * database or its neighbours' of the disk; io.weight only orders a queue.
 */
export interface SizeIo {
  readonly rbps: number;
  readonly wbps: number;
  readonly riops: number;
  readonly wiops: number;
}

const MiB = 1024 * 1024;

export const SIZE_IO: Readonly<Record<Size, SizeIo>> = {
  small: { rbps: 50 * MiB, wbps: 25 * MiB, riops: 1000, wiops: 500 },
  medium: { rbps: 100 * MiB, wbps: 50 * MiB, riops: 2000, wiops: 1000 },
  large: { rbps: 200 * MiB, wbps: 100 * MiB, riops: 4000, wiops: 2000 },
};

/** A size, or one sentence saying which are allowed. */
export function parseSize(v: unknown): Result<Size, string> {
  if (typeof v === "string" && Object.hasOwn(SIZES, v)) return ok(v as Size);
  return err("size must be small, medium or large");
}

export const DEFAULT_SIZE: Size = "small";

export const isSize = (v: unknown): v is Size => typeof v === "string" && Object.hasOwn(SIZES, v);

// What each size is for, never how big: the figures live only in SIZES.
const SAYS: Readonly<Record<Size, string>> = {
  small: "For a notes app, a small tool, a place to try things.",
  medium: "For a busy app, or a few apps side by side.",
  large: "For a crew's working forge, with room to build.",
};

/** What each size means, for a page or an agent to offer; read from SIZES. */
export function sizesView(): { sizes: { size: Size; cpu: number; memoryMiB: number; diskMiB: number; says: string }[]; default: Size } {
  return {
    sizes: (Object.keys(SIZES) as Size[]).map((size) => ({ size, ...SIZES[size], says: SAYS[size] })),
    default: DEFAULT_SIZE,
  };
}
