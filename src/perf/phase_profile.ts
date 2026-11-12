/**
 * Per-phase profile of the code pages (#9503): which of tree, blob, raw and
 * media a request is, what its Server-Timing header named, and the p50/p95 of
 * each phase. Plain data in, plain data out; `bench/code-phases.ts` asks the
 * pages, this reads the answers.
 */

export type CodeKind = "tree" | "blob" | "raw" | "media";
export const KINDS: readonly CodeKind[] = ["tree", "blob", "raw", "media"];

/** The kind of a repository path (`/o/r/blob/<ref>/f`), undefined for any other page. */
export function kindOf(path: string): CodeKind | undefined {
  const m = /^\/[^/]+\/[^/]+\/(tree|blob|raw|media)\//.exec(path);
  return m === null ? undefined : (m[1] as CodeKind);
}

/** `git;dur=1.5, render;dur=3` as phase → ms; malformed entries are skipped. */
export function parseTiming(header: string | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of (header ?? "").matchAll(/([A-Za-z][\w-]*);dur=(\d+(?:\.\d+)?)/g)) out.set(m[1]!, Number(m[2]));
  return out;
}

/** Nearest-rank percentile of an ascending list; NaN when empty. */
export const percentile = (sorted: readonly number[], p: number): number =>
  sorted.length === 0 ? NaN : sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;

/** Only a page that was served counts: 200, or 206 for a ranged media read. A redirect or a refusal is not a sample. */
export const counted = (status: number): boolean => status === 200 || status === 206;

/** How many answers were not counted, by status (0 for a failed connection), e.g. `{ "404": 3 }`. */
export function dropped(observed: readonly { readonly status: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of observed) if (!counted(o.status)) out[String(o.status)] = (out[String(o.status)] ?? 0) + 1;
  return out;
}

/**
 * The commit-pinned tree, blob, raw and media paths of `repo` named in `html`;
 * each blob also yields its raw sibling. Query strings and fragments are cut.
 */
export function gatherLinks(html: string, repo: string): string[] {
  const esc = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new Set<string>();
  for (const m of html.matchAll(new RegExp(`/${esc}/(?:tree|blob|raw|media)/[0-9a-f]{40}[^"'<> ?#]*`, "g"))) {
    found.add(m[0]);
    if (m[0].includes("/blob/")) found.add(m[0].replace("/blob/", "/raw/"));
  }
  return [...found];
}

export interface Observation {
  readonly kind: CodeKind;
  /** Wall time as the client saw it, ms. */
  readonly wall: number;
  readonly phases: ReadonlyMap<string, number>;
  readonly status: number;
}

export interface Row {
  readonly kind: CodeKind;
  readonly phase: string;
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
}

/**
 * One row per kind and phase, `wall` (the client's clock) first, then the
 * named phases. The four phases asked for — git, render, highlight, session —
 * are always listed, with n = 0 where the page never named them, so a missing
 * phase reads as "not measured" and not as "free".
 */
export function profile(observed: readonly Observation[]): Row[] {
  const rows: Row[] = [];
  for (const kind of KINDS) {
    const mine = observed.filter((o) => o.kind === kind && counted(o.status));
    const names = new Set<string>(["git", "render", "highlight", "session"]);
    for (const o of mine) for (const k of o.phases.keys()) names.add(k);
    const row = (phase: string, xs: number[]): Row => {
      xs.sort((a, b) => a - b);
      return { kind, phase, n: xs.length, p50: percentile(xs, 50), p95: percentile(xs, 95) };
    };
    rows.push(row("wall", mine.map((o) => o.wall)));
    for (const name of names) rows.push(row(name, mine.flatMap((o) => (o.phases.has(name) ? [o.phases.get(name)!] : []))));
  }
  return rows;
}

/** A Markdown table of `profile`, ms to one decimal; "–" where nothing was observed. */
export function table(rows: readonly Row[]): string {
  const f = (x: number) => (Number.isNaN(x) ? "–" : x.toFixed(1));
  return [
    "| page | phase | n | p50 ms | p95 ms |",
    "| ---- | ----- | -: | -----: | -----: |",
    ...rows.map((r) => `| ${r.kind} | ${r.phase} | ${r.n} | ${f(r.p50)} | ${f(r.p95)} |`),
  ].join("\n");
}
