/**
 * What `/map` keeps between requests, as docs/CACHING.md designs it (#2716):
 * a layout by the graph it was drawn from, and a lane by the repository's
 * latest event, the viewer's sealed scope and the UTC day.
 *
 * Access is never in here: the caller works out which repositories a viewer
 * may read and which sealed issues they may see on every request, and the
 * answer goes into the key. Nothing here is truth; every entry can be
 * dropped and the only cost is one rebuild.
 */

import type { Database } from "bun:sqlite";
import { ViewCache } from "../view/cache.ts";
import type { Graph } from "../core/dependencies.ts";

/** A lane is rebuilt at least this often: covers inputs that move without an event. */
export const LANE_TTL_MS = 60_000;
/** An unused layout goes after an hour; the cap is what bounds memory. */
const LAYOUT_TTL_MS = 60 * 60_000;

const lanes = new ViewCache({ maxEntries: 128 });
const layouts = new ViewCache({ maxEntries: 256 });

/** What `sealedScope` computed, as a string that goes into a key. */
export function scopeKey(scope: { sealed?: true; sealedBy?: string }): string {
  return scope.sealed === true
    ? "all"
    : scope.sealedBy === undefined
      ? "none"
      : `own:${scope.sealedBy}`;
}

/**
 * Each repository's latest event sequence, in one grouped read from the
 * `event_repo_seq` index. Read from the database each time, so a write by
 * another process moves it too. A repository with no event is 0.
 */
export function repoHeads(
  db: Database,
  repoIds: readonly string[],
): Map<string, number> {
  const heads = new Map<string, number>(repoIds.map((id) => [id, 0]));
  if (repoIds.length === 0) return heads;
  // A grouped MAX would scan every event of every listed repository; one
  // correlated MAX per row is a single index seek each, in one statement.
  const rows = db
    .query<{ id: string; head: number | null }, string[]>(
      `SELECT repo.id AS id,
              (SELECT MAX(seq) FROM event WHERE event.repo_id = repo.id) AS head
         FROM repo WHERE repo.id IN (${repoIds.map((_, n) => `?${n + 1}`).join(",")})`,
    )
    .all(...repoIds);
  for (const row of rows) heads.set(row.id, row.head ?? 0);
  return heads;
}

const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

/**
 * A lane's cached build, or `build()`'s result kept for next time. `null`
 * is a cached answer too: a repository with nothing to draw.
 */
export function cachedLane<T>(
  key: { repoId: string; head: number; scope: string; now: Date },
  build: () => T,
): T {
  const k = `lane:${key.repoId}:${key.head}:${key.scope}:${utcDay(key.now)}`;
  const kept = lanes.get<{ value: T }>(k);
  if (kept !== undefined) return kept.value;
  const value = build();
  lanes.set(k, { value }, LANE_TTL_MS);
  return value;
}

const plans = new ViewCache({ maxEntries: 64 });
let planBuilds = 0;

/**
 * The milestones page's plan: `build()` once per plan stamp (`planStamp`:
 * what the plan reads of this repository, so a write elsewhere on the forge
 * leaves it warm), spend visibility and UTC day, for at most a lane's
 * lifetime. The plan holds no
 * viewer: who may read the repository and the seats are the caller's, every
 * request.
 */
export function cachedPlan<T>(
  key: { repoId: string; stamp: string | undefined; spend: boolean; now: Date },
  build: () => T,
): T {
  // No stamp inside a transaction: nothing is kept that a rollback could outlive.
  if (key.stamp === undefined) {
    planBuilds++;
    return build();
  }
  const k = `plan:${key.repoId}:${key.stamp}:${key.spend ? "spend" : "plain"}:${utcDay(key.now)}`;
  const kept = plans.get<{ value: T }>(k);
  if (kept !== undefined) return kept.value;
  planBuilds++;
  const value = build();
  plans.set(k, { value }, LANE_TTL_MS);
  return value;
}

/** How many plans were built rather than served from the cache. */
export const planBuildCount = (): number => planBuilds;

/** The key is the graph's own input: issues in order and the edges between. */
export function layoutKey(graph: Pick<Graph, "issues" | "edges">): string {
  const hash = new Bun.CryptoHasher("sha256");
  for (const i of graph.issues) hash.update(`${i.id}:${i.number}\n`);
  hash.update("--\n");
  for (const e of graph.edges) hash.update(`${e.blockedById}>${e.issueId}\n`);
  return `layout:${hash.digest("hex")}`;
}

/**
 * `draw(graph)` once per distinct graph. Only ids, levels and slots are kept;
 * every placed issue is put back from the request's own graph, so an edited
 * title shows on the next view.
 */
export function cachedLayout<
  P extends { readonly issue: { readonly id: string } },
  L extends { readonly nodes: readonly P[] },
>(graph: Graph, draw: (graph: Graph) => L): L {
  const key = layoutKey(graph);
  const kept = layouts.get<{ nodes: { id: string }[] }>(key);
  if (kept !== undefined) {
    const byId = new Map(graph.issues.map((i) => [i.id, i]));
    return {
      ...kept,
      nodes: kept.nodes.map(({ id, ...rest }) => ({
        ...rest,
        issue: byId.get(id),
      })),
    } as unknown as L;
  }
  const drawn = draw(graph);
  layouts.set(
    key,
    {
      ...drawn,
      nodes: drawn.nodes.map(({ issue, ...rest }) => ({ ...rest, id: issue.id })),
    },
    LAYOUT_TTL_MS,
  );
  return drawn;
}

/** Test seam: start from nothing. */
export function clearMapCache(): void {
  lanes.clear();
  plans.clear();
  layouts.clear();
}

/** What the tests read to know a request was served from the cache. */
export const mapCacheStats = (): {
  lanes: ReturnType<ViewCache["stats"]>;
  layouts: ReturnType<ViewCache["stats"]>;
} => ({ lanes: lanes.stats(), layouts: layouts.stats() });
