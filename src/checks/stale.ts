/**
 * Whether a pull's green was checked against an older base: the last check
 * run recorded the base tip it was merged with (`base_oid`), and the base
 * has moved since. A run that recorded no base, or a base that cannot be
 * read, is not called stale — the reading says only what it knows.
 */

export function checkStale(
  run: { readonly baseOid: string } | null,
  baseTip: string | undefined,
): boolean {
  if (run === null || run.baseOid === "") return false;
  if (baseTip === undefined || baseTip === "") return false;
  return run.baseOid !== baseTip;
}
