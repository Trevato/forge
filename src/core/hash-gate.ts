/**
 * How many argon2 checks may run at once. Each one holds 64 MiB and a core,
 * and the sign-in windows count attempts per minute, not attempts in flight:
 * a burst of distinct accounts from many sources would still start them all
 * together. Past the cap an attempt is refused at once, not queued, so a
 * flood cannot pile up memory behind the hash. Passwords past `MAX_PASSWORD`
 * bytes are never hashed: no person types one, and the cost grows with length.
 */

export const MAX_CONCURRENT_HASHES = 4;
export const MAX_PASSWORD = 1024;
/** Seconds a refused caller is told to wait. */
export const GATE_RETRY_AFTER = 1;
/** What a person is told when a password they set is past the cap. */
export const PASSWORD_TOO_LONG = `Use ${MAX_PASSWORD} bytes or fewer.`;

/** Whether a password is within the cap, counted in bytes as it is hashed. */
export const withinPasswordCap = (password: string): boolean =>
  Buffer.byteLength(password) <= MAX_PASSWORD;

let running = 0;

/** Run `work` in a free slot, or return undefined when every slot is taken. */
export async function withHashSlot<T>(
  work: () => Promise<T>,
  cap: number = MAX_CONCURRENT_HASHES,
): Promise<T | undefined> {
  if (running >= cap) return undefined;
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
  }
}
