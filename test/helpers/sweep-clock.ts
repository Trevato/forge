/**
 * The clock and the pool the route sweeps share (#10401): the security-floor
 * sweeps run on every push, so their request loops are held under
 * `SWEEP_CEILING_MS`. Only the loops are timed — never server boot or the
 * seed — so a loaded runner's slow start does not flake the bound.
 */

/** What the request loops of one sweep file may take together. */
export const SWEEP_CEILING_MS = 5_000;

/** Run `loop`, and say how long it took in milliseconds. */
export async function timed<T>(loop: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await loop();
  return { value, ms: performance.now() - start };
}

/**
 * Run every job, `width` at a time, answers in the items' order. The server
 * is one process, so more in flight buys nothing.
 */
export async function pool<T, R>(items: readonly T[], work: (item: T) => Promise<R>, width = 32): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await work(items[i]!);
      }
    }),
  );
  return out;
}
