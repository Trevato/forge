/**
 * What a model call costs at list price, in dollars, from the usage the
 * provider reports. USD per million tokens, Anthropic's published list
 * (anthropic.com/pricing): Opus 15 in / 75 out, Sonnet 3 / 15, Haiku 1 / 5;
 * a cache write costs 1.25x the input price and a cache read 0.1x. A model
 * whose family is not recognised is priced as Opus, the dearest: a lent
 * credential is never undercounted, and the worst a wrong guess does is
 * stop a child's spending early.
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

const FAMILIES: readonly (readonly [RegExp, Rate])[] = [
  [/haiku/i, { in: 1, out: 5 }],
  [/sonnet/i, { in: 3, out: 15 }],
  [/opus/i, { in: 15, out: 75 }],
];
const DEAREST: Rate = { in: 15, out: 75 };

export const rateOf = (model: string): Rate => FAMILIES.find(([re]) => re.test(model))?.[1] ?? DEAREST;

/** Dollars at list price: tokens / 1e6 * USD per million, summed. Unrounded. */
export function listPriceUsd(model: string, u: Usage): number {
  const r = rateOf(model);
  return (
    (u.inputTokens * r.in + u.outputTokens * r.out + u.cacheWriteTokens * r.in * 1.25 + u.cacheReadTokens * r.in * 0.1) /
    1_000_000
  );
}
