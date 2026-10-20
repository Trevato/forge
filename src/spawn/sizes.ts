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

export const SIZES: Readonly<Record<Size, SizeLimits>> = {
  small: { cpu: 1, memoryMiB: 512, diskMiB: 2048 },
  medium: { cpu: 2, memoryMiB: 2048, diskMiB: 10240 },
  large: { cpu: 4, memoryMiB: 8192, diskMiB: 40960 },
};

/** A size, or one sentence saying which are allowed. */
export function parseSize(v: unknown): Result<Size, string> {
  if (typeof v === "string" && Object.hasOwn(SIZES, v)) return ok(v as Size);
  return err("size must be small, medium or large");
}

export const DEFAULT_SIZE: Size = "small";

export const isSize = (v: unknown): v is Size => typeof v === "string" && Object.hasOwn(SIZES, v);
