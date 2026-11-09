/**
 * Plan items of one shape (#10403, #10404, #10406, #10427–#10432: ten "The
 * X list is keyboard-first: j/k move between rows, enter opens one" issues
 * in two hours, each a run, each a pull on the same files). Two titles have
 * one shape when they have the same number of words and differ in one, or
 * in two of twelve or more. Three or more of one shape are one change on
 * several things: one issue with a checklist, never a run each. Pure.
 */

/** Items of one shape from this many up are refused as a plan. */
export const LOOK_ALIKE_MIN = 3;
/** Titles shorter than this, in words, are too plain to call alike. */
const SHORT = 5;
/** One differing word per this many words of the title. */
const WORDS_PER_SLOT = 6;

const words = (title: string): string[] =>
  title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");

/** Whether two titles are the same words but one (or two, in a long title). */
export function sameShape(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (x.length !== y.length || x.length < SHORT) return false;
  let differ = 0;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) differ++;
  return (
    differ > 0 && differ <= Math.max(1, Math.floor(x.length / WORDS_PER_SLOT))
  );
}

/** The groups of `LOOK_ALIKE_MIN` or more items of one shape, each in the order given. */
export function lookAlikes<T>(
  items: readonly T[],
  titleOf: (item: T) => string,
): T[][] {
  const group = items.map((_, i) => i);
  const root = (i: number): number => {
    while (group[i] !== i) i = group[i]!;
    return i;
  };
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++)
      if (sameShape(titleOf(items[i]!), titleOf(items[j]!)))
        group[root(j)] = root(i);
  const by = new Map<number, T[]>();
  items.forEach((item, i) => {
    const r = root(i);
    by.set(r, [...(by.get(r) ?? []), item]);
  });
  return [...by.values()].filter((g) => g.length >= LOOK_ALIKE_MIN);
}
