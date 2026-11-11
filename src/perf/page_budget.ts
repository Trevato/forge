/**
 * The page-load budget (#11320, #11360): the pages people open first, each
 * with the median it answers in warm and the SQL statements one request of
 * it may run. Plain data, one line per page: add a page in one line here.
 * `test/page-budget.test.ts` walks the table in-process, and a production
 * probe can read the same table.
 *
 * The statement count is the hard limit: it is the same on a loaded machine
 * as on an idle one, so an N+1 fails it every run. The median is the promise
 * people feel; a loaded check host can miss it, so the test measures it again
 * before it judges.
 */

export interface PageBudget {
  /** What the page is, in words, for the failure line. */
  readonly page: string;
  /** The router pattern; `:owner` and `:name` are filled by `pagePath`. */
  readonly pattern: string;
  /** The median of 20 warm requests stays under this many ms. */
  readonly medianMs: number;
  /** One warm request runs at most this many SQL statements. */
  readonly statements: number;
  /** Walked with no cookie: a stranger's page, not a signed-in person's. */
  readonly signedOut?: true;
}

/** Statement limits are today's count, signed in, plus a little: lower them as pages get cheaper, raise one only on purpose. */
export const PAGE_BUDGETS: readonly PageBudget[] = [
  { page: "home", pattern: "/", medianMs: 50, statements: 46 },
  { page: "explore", pattern: "/explore", medianMs: 50, statements: 18 },
  { page: "map", pattern: "/map", medianMs: 50, statements: 21 },
  { page: "an app page", pattern: "/:owner/:name", medianMs: 50, statements: 49 },
  { page: "changelog", pattern: "/changelog", medianMs: 50, statements: 20 },
  // A stranger's way to a forge (#11410): walked signed out. `/claim` is
  // measured on a spawned forge with a live link, as the child's owner sees it.
  { page: "pricing", pattern: "/pricing", medianMs: 50, statements: 10, signedOut: true },
  { page: "new forge", pattern: "/forges/new", medianMs: 50, statements: 14, signedOut: true },
  { page: "claim", pattern: "/claim", medianMs: 50, statements: 14, signedOut: true },
];

/** The path a budget's pattern names for one repository: `:owner` and `:name` filled, everything else as written. */
export function pagePath(b: PageBudget, owner: string, name: string): string {
  return b.pattern.replace(":owner", encodeURIComponent(owner)).replace(":name", encodeURIComponent(name));
}
