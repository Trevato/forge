/** The clog's one sentence (#6517): plain data in, one plain string out; escaping is the drawer's job. */

export type ClogFacts = {
  reasons: readonly string[];
  conflictedApproved?: number | null;
  hottest?: { path: string; pulls: number } | undefined;
  strandedUsd?: number | null;
};

const MAX = 160;

const count = (n: number | null | undefined): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
const pulls = (n: number, what: string): string => `${n} ${what} pull${n === 1 ? "" : "s"}`;

/** "Clogged: 60 approved pulls conflict; 61 open pulls touch <file>. $X of crew work is waiting to land." */
export function clogSays(f: ClogFacts): string {
  const conflicts = count(f.conflictedApproved);
  const hot = f.hottest && count(f.hottest.pulls) > 0 && f.hottest.path ? f.hottest : undefined;
  const dollars = Math.round(f.strandedUsd ?? 0);
  const build = (reasons: readonly string[], withHot: boolean): string => {
    const parts = reasons.filter((r) => r.trim() !== "").map((r) => r.trim());
    if (conflicts) parts.push(`${pulls(conflicts, "approved")} ${conflicts === 1 ? "conflicts" : "conflict"}`);
    if (hot && withHot) parts.push(`${pulls(count(hot.pulls), "open")} touch ${hot.path}`);
    const head = parts.length ? `Clogged: ${parts.join("; ")}.` : "";
    const tail = dollars > 0 ? `$${dollars} of crew work is waiting to land.` : "";
    return [head, tail].filter(Boolean).join(" ");
  };
  // Over the bound: drop the reasons first, then the file, so the sentence never runs long.
  for (const [reasons, withHot] of [[f.reasons, true], [[], true], [[], false]] as const) {
    const s = build(reasons, withHot);
    if (s.length <= MAX) return s;
  }
  return build([], false).slice(0, MAX);
}
