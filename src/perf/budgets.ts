/** Budgets per route pattern and per git subcommand, in words with the number beside it (#7559, #8158). One file. */

export interface Budget {
  /** The router pattern, or a prefix ending in `*`. */
  readonly pattern: string;
  readonly words: string;
  /** p95 over this many ms, warm, is a finding. */
  readonly p95Ms: number;
}

export const BUDGETS: readonly Budget[] = [
  { pattern: "/", words: "home p95 under 800 ms warm", p95Ms: 800 },
  { pattern: "/boards", words: "boards p95 under 800 ms warm", p95Ms: 800 },
  { pattern: "/explore", words: "explore p95 under 800 ms warm", p95Ms: 800 },
  { pattern: "/api/v1/health", words: "health p95 under 100 ms", p95Ms: 100 },
  { pattern: "/:owner/:name", words: "repo page p95 under 800 ms warm", p95Ms: 800 },
  { pattern: "/:owner/:name/*", words: "repo sub-page p95 under 1000 ms warm", p95Ms: 1000 },
];

/** The budget a route pattern is held to, or undefined for a route with none. */
export function budgetFor(pattern: string): Budget | undefined {
  return (
    BUDGETS.find((b) => b.pattern === pattern) ??
    BUDGETS.find((b) => b.pattern.endsWith("*") && pattern.startsWith(b.pattern.slice(0, -1)))
  );
}

/** A plumbing git subcommand's budget (#8158): a single process past this at p95 is a queue or a loaded machine. */
export const GIT_BUDGET: Budget = { pattern: "git *", words: "each git process p95 under 250 ms", p95Ms: 250 };

/**
 * Subcommands that move or rewrite whole packs are slow on a healthy machine,
 * so 250 ms would file a finding per subcommand; they are held to 10 s.
 */
const HEAVY_GIT = new Set([
  "clone", "fetch", "pull", "push", "gc", "repack", "pack-objects", "index-pack",
  "unpack-objects", "archive", "bundle", "upload-pack", "receive-pack", "fsck", "prune",
]);
export const HEAVY_GIT_BUDGET: Budget = { pattern: "git *", words: "a pack-moving git process p95 under 10 s", p95Ms: 10_000 };

/** The budget a `git <subcommand>` key is held to. */
export function gitBudgetFor(key: string): Budget {
  return HEAVY_GIT.has(key.slice(4)) ? HEAVY_GIT_BUDGET : GIT_BUDGET;
}
