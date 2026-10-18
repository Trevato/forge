/**
 * "1 comment", "0 comments". A count and its noun are one phrase, so they are
 * formatted in one place — the alternative is `1 commits` in whichever screen
 * was written last, which is precisely what happened before this existed.
 */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}
