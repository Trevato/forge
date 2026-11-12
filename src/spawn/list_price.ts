/**
 * What a model call costs at list price, in dollars, from the usage the
 * provider reports. USD per million tokens, from anthropic.com/pricing
 * (Opus 4.5 rate announced 2025-11-24; the rest as listed there):
 *   Opus 4.5 and later (incl. 5.x)  5 in / 25 out
 *   Opus 4, 4.1                    15 in / 75 out
 *   Sonnet                          3 in / 15 out
 *   Haiku                           1 in /  5 out
 * A cache write costs 1.25x the input price and a cache read 0.1x.
 * Any other model (Fable has no published rate recorded here) is priced at
 * 15 / 75, the dearest, so a lent credential is never undercounted.
 */

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
}

export const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };

interface Rate {
  readonly in: number;
  readonly out: number;
}

// Matched on the id with . and _ turned into -, so opus-4.5 and opus-4_5 are
// opus-4-5. Opus 4.5+ is `opus-4-5`..`opus-4-9` or `opus-5`.., either before or
// after the version (claude-4-5-opus); `opus-4-20250514` (a date) is not 4.5.
const OPUS_45_UP = /opus-(?:4-[5-9]|[5-9])(?!\d)|(?:4-[5-9]|[5-9])-opus/;

const FAMILIES: readonly (readonly [RegExp, Rate])[] = [
  [/haiku/i, { in: 1, out: 5 }],
  [/sonnet/i, { in: 3, out: 15 }],
  [OPUS_45_UP, { in: 5, out: 25 }],
  [/opus/i, { in: 15, out: 75 }],
];
const DEAREST: Rate = { in: 15, out: 75 };

export const rateOf = (model: string): Rate => FAMILIES.find(([re]) => re.test(model.toLowerCase().replace(/[._]/g, "-")))?.[1] ?? DEAREST;

/** Dollars at list price: tokens / 1e6 * USD per million, summed. Unrounded. */
export function listPriceUsd(model: string, u: Usage): number {
  const r = rateOf(model);
  return (
    (u.inputTokens * r.in + u.outputTokens * r.out + u.cacheWriteTokens * r.in * 1.25 + u.cacheReadTokens * r.in * 0.1) /
    1_000_000
  );
}
