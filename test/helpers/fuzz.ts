/**
 * A seeded fuzzer in forty lines. A case is a string (every parser takes
 * text); a property throws when the case breaks it. On a failure the error
 * names the seed and the shrunk case: put the case in a fixed test, and
 * rerun the rest with `FUZZ_SEED=<n>`.
 */

export type Rand = () => number;

export const rng = (seed: number): Rand => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const SEED = Number(process.env["FUZZ_SEED"] ?? 1244);
export const RUNS = Number(process.env["FUZZ_RUNS"] ?? 400);

export const int = (r: Rand, n: number): number => Math.floor(r() * n);
export const pick = <T>(r: Rand, xs: readonly T[]): T => xs[int(r, xs.length)]!;

/** Text from a pool of awkward pieces, so cases reach past "random bytes". */
export function mix(r: Rand, pieces: readonly string[], max = 12): string {
  let out = "";
  for (let n = int(r, max) + 1; n > 0; n--)
    out += r() < 0.15 ? String.fromCharCode(int(r, 0x250)) : pick(r, pieces);
  return out;
}

/** Remove chunks while the case still fails: halves, then single characters. */
async function shrink(
  input: string,
  fails: (s: string) => Promise<boolean>,
): Promise<string> {
  let best = input;
  for (let size = Math.ceil(best.length / 2); size >= 1; size = Math.floor(size / 2)) {
    for (let at = 0; at < best.length; ) {
      const trial = best.slice(0, at) + best.slice(at + size);
      if (await fails(trial)) best = trial;
      else at += size;
    }
    if (size === 1) break;
  }
  return best;
}

export async function fuzz(
  name: string,
  gen: (r: Rand) => string,
  property: (input: string) => void | Promise<void>,
  runs = RUNS,
): Promise<void> {
  const r = rng(SEED);
  for (let i = 0; i < runs; i++) {
    const input = gen(r);
    try {
      await property(input);
    } catch (error) {
      const minimal = await shrink(input, async (s) => {
        try {
          await property(s);
          return false;
        } catch {
          return true;
        }
      });
      throw new Error(
        `fuzz ${name}: FUZZ_SEED=${SEED} case ${i}\n  minimal: ${JSON.stringify(minimal)}\n  ${String(error)}`,
      );
    }
  }
}
