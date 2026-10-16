/**
 * Argon2 at its cheapest, for tests: `test/helpers/preload.ts` installs it
 * before every test file (`bunfig.toml`).
 *
 * A forge hashes a password with `Bun.password.hash(password, "argon2id")`,
 * Bun's default cost — 64 MiB and two passes, about 150 ms on a quiet
 * machine and several times that with sixteen files hashing side by side.
 * The suite makes an account and signs it in about four hundred times, so
 * that cost was most of a typical `beforeAll` and most of the gate's floor
 * (#2038). Here the default becomes argon2id's minimum (8 KiB, one pass);
 * `Bun.password.verify` reads the cost back from the hash, so signing in is
 * as cheap. Production never loads this file, and a test that names its own
 * cost (`test/signin-throttle.test.ts`) keeps it.
 *
 * `realHash` is the runtime's own, for the test that proves this is only a
 * test's saving.
 */

export const realHash = Bun.password.hash.bind(Bun.password);

/** argon2id's floor: the cheapest hash a verify still accepts as argon2id. */
export const CHEAP = { algorithm: "argon2id", memoryCost: 8, timeCost: 1 } as const;

type Algorithm = Parameters<typeof Bun.password.hash>[1];

/** The cost a test hash is made at: the floor, unless the caller named one. */
export function cheapened(algorithm: Algorithm): Algorithm {
  if (algorithm === undefined || algorithm === "argon2id") return CHEAP;
  return algorithm;
}

/** Every `Bun.password.hash` in this process from now on, at the floor. */
export function installCheapHash(): void {
  Bun.password.hash = (password, algorithm) => realHash(password, cheapened(algorithm));
}
