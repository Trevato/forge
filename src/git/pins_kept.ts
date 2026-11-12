/**
 * Each repository's pins as last listed (`listBuildPins` with no label),
 * kept in memory so a page that reads many repositories' pins — a display
 * and its chooser, the Arcade's shelf — spawns git once per repository, not
 * once per request (#10445).
 *
 * A listing is dropped when this process writes the repository's pins or
 * notes (`git/builds.ts` calls `pinsMoved`), when an event may have moved
 * them (`dropAllPins`, from the display cache's bus subscription), and after
 * `PINS_FRESH_MS` in any case, so a ref moved by nothing the forge saw is
 * read again within that. Git stays the record: this is a cache, empty on
 * boot, bounded by `PINS_KEPT_MAX` repositories.
 */

/** How long a listing is answered before it is read again. */
export const PINS_FRESH_MS = 30_000;
/** The most repositories' listings kept at once; the oldest goes first. */
export const PINS_KEPT_MAX = 2_000;

interface Entry<T> {
  readonly value: Promise<T>;
  readonly at: number;
  readonly epoch: number;
}

const kept = new Map<string, Entry<unknown>>();
const epochs = new Map<string, number>();
let allEpoch = 0;

const epochOf = (dir: string): number => (epochs.get(dir) ?? 0) + allEpoch * 1e9;

/** This process wrote `dir`'s pins or notes: its listing is read again. */
export function pinsMoved(dir: string): void {
  epochs.set(dir, (epochs.get(dir) ?? 0) + 1);
  kept.delete(dir);
}

/** An event may have moved any repository's pins: every listing is read again. */
export function dropAllPins(): void {
  allEpoch++;
  kept.clear();
}

/** `dir`'s listing as kept, or `read` once, shared by concurrent callers; a failed read is not kept. */
export function keptPins<T>(dir: string, read: () => Promise<T>): Promise<T> {
  const seen = kept.get(dir) as Entry<T> | undefined;
  const epoch = epochOf(dir);
  if (seen !== undefined && seen.epoch === epoch && Date.now() - seen.at <= PINS_FRESH_MS) return seen.value;
  const value = read();
  const entry: Entry<T> = { value, at: Date.now(), epoch };
  kept.delete(dir);
  kept.set(dir, entry);
  if (kept.size > PINS_KEPT_MAX) kept.delete(kept.keys().next().value!);
  value.catch(() => {
    if (kept.get(dir) === entry) kept.delete(dir);
  });
  return value;
}
