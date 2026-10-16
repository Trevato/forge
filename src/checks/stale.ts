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

/**
 * Whether `require_checks` holds a merge back: the live head's check is not
 * green, or is green only against an older base — a check still to come.
 * The page and the terminal read this one answer, so neither offers a merge
 * the other would not.
 */
export function checksHold(
  requireChecks: boolean,
  state: string,
  stale: boolean,
): boolean {
  return requireChecks && (state !== "ok" || stale);
}
