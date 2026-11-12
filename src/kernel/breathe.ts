/**
 * Let the event loop serve what is waiting (#8848). A long pass over many rows
 * calls `breathe` between slices of work: a request that arrived meanwhile is
 * answered before the next slice, so the pass never holds the thread for more
 * than one slice. A timer, not a microtask: a resolved promise would run before
 * the loop looks at its sockets.
 */

/** The longest a slice of a background pass may run before it breathes, ms. */
export const SLICE_MS = 20;

export const breathe = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

/**
 * A clock for one pass: `due()` is true once a slice has run {@link SLICE_MS},
 * and `await slice.breathe()` hands the thread back and starts the next slice.
 * Cheaper than breathing every row, and the bound is time, not a guess at rows.
 */
export function sliced(now: () => number = () => performance.now()): { due(): boolean; breathe(): Promise<void> } {
  let from = now();
  return {
    due: () => now() - from >= SLICE_MS,
    breathe: async () => {
      await breathe();
      from = now();
    },
  };
}
