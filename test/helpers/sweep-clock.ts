/**
 * The pool the route sweeps share (#10401). The sweeps run on every push,
 * so their cost is bounded by the route table — one request per (verb,
 * route) and pass — never by a clock: wall-clock is a coin flip in a loaded
 * check cell and is never judged in a pull (`test/helpers/work.ts`, #7824);
 * a 5 s bound here reddened pulls that had not touched a route (2026-11-09).
 */

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
