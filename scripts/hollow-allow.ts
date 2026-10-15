/**
 * The hollow work the gate lets stand (`scripts/hollow.ts`): an action no
 * surface calls as `src/actions/<file>.ts#<name>`, a screen no page links
 * to as `GET <path>`. Each entry says why it is hollow today and names the
 * issue that owns calling it, linking it or removing it.
 *
 * An entry leaves in the pull that makes it reachable — the audit goes red
 * on one that is no longer hollow — and one is added only with an issue to
 * answer for it. New work is not listed here: it is wired.
 */

export type Allowed = {
  /** What `scripts/hollow.ts` calls it. */
  orphan: string;
  /** One line: why nothing reaches it today. */
  reason: string;
  /** The issue that owns reaching or removing it. */
  issue: number;
};

export const ALLOWED: readonly Allowed[] = [
  {
    orphan: "GET /fleet/graph",
    reason:
      "the fleet graph shipped ahead of the fleet page that is to link to it",
    issue: 448,
  },
  {
    orphan: "GET /oauth/authorize",
    reason: "reached only through an OAuth client's redirect",
    issue: 971,
  },
];
