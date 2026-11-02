/** Budgets per route pattern, in words with the number beside it (#7559). One file. */

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
