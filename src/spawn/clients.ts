/**
 * The client list (#776): every forge this one sent, for whom, and how it
 * is doing. The parent's ledger says what was sent; the child itself says
 * whether it was claimed and when anything last happened there, through a
 * small answer (`forgeState`, `GET /api/v1/forge`) that holds nothing else.
 * Claimed is anyone's to know; when anything last happened is the parent's
 * alone, for it tells when private work goes on: the parent shows a secret
 * kept in its ledger, and the child checks it against the hash it holds. A child that does not answer in time reads "unknown": the
 * list never waits on, or fails for, one forge that is down.
 */

import type { App } from "../app.ts";
import { listChildren, statusTokenOf, type Child } from "../actions/spawn.ts";
import { sha256 } from "../kernel/hash.ts";
import { hasAdmin, spawnedOrg } from "./claim.ts";

/** What a spawned forge says about itself to anyone: nothing more. */
export interface ForgeState {
  readonly claimed: boolean;
  readonly lastActivityAt: string | null;
}

/** One row of the client list; `claimed` is null when the child did not answer. */
export interface ClientRow {
  readonly name: string;
  readonly url: string;
  readonly for: string | null;
  readonly apps: readonly string[];
  readonly sentAt: string | null;
  /** False while the child is still being made (a resumed spawn finishes it). */
  readonly made: boolean;
  readonly claimed: boolean | null;
  readonly lastActivityAt: string | null;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const PROBE_MS = 2000;
/**
 * Where the parent shows its secret. Its own header, not `Authorization`:
 * a bearer there is always a forge token, and this is no account's.
 */
export const PARENT_HEADER = "x-forge-parent";
const fetchers = new WeakMap<App, FetchLike>();

/** Tests (and a placement with its own way in, one day) swap how children are reached. */
export function useChildFetch(app: App, fetcher: FetchLike): void {
  fetchers.set(app, fetcher);
}

/**
 * This forge's own answer; undefined when it was not spawned. `shown` is
 * what the caller showed: only the parent's secret unlocks the timing.
 */
export async function forgeState(
  app: App,
  shown: string | undefined,
): Promise<ForgeState | undefined> {
  const spawned = await spawnedOrg(app);
  if (spawned === undefined) return undefined;
  const claimed = hasAdmin(app.db);
  const parent =
    spawned.statusHash !== undefined &&
    shown !== undefined &&
    sha256(shown) === spawned.statusHash;
  if (!parent) return { claimed, lastActivityAt: null };
  // Anything that happened: an event, a tell or a change touched, a run,
  // an account made (the claim is one).
  const last = app.db
    .query<{ at: string | null }, []>(
      `SELECT MAX(at) AS at FROM (
         SELECT MAX(created_at) AS at FROM event
         UNION ALL SELECT MAX(updated_at) FROM issue
         UNION ALL SELECT MAX(created_at) FROM run
         UNION ALL SELECT MAX(created_at) FROM user WHERE kind = 'user' AND is_agent = 0
       )`,
    )
    .get();
  return { claimed, lastActivityAt: last?.at ?? null };
}

async function probe(app: App, child: Child): Promise<ForgeState | undefined> {
  if (!child.done) return undefined;
  const fetcher = fetchers.get(app) ?? fetch;
  const token = await statusTokenOf(app, child.name);
  try {
    const res = await fetcher(`${child.url}/api/v1/forge`, {
      ...(token === undefined ? {} : { headers: { [PARENT_HEADER]: token } }),
      signal: AbortSignal.timeout(PROBE_MS),
      redirect: "error",
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as Record<string, unknown>;
    if (typeof body["claimed"] !== "boolean") return undefined;
    const at = body["lastActivityAt"];
    return {
      claimed: body["claimed"],
      lastActivityAt:
        typeof at === "string" && !Number.isNaN(Date.parse(at)) ? at : null,
    };
  } catch {
    return undefined;
  }
}

/** Every child this forge sent, newest first, each asked how it is, all at once. */
export async function clientRows(app: App): Promise<ClientRow[]> {
  const children = await listChildren(app);
  const states = await Promise.all(children.map((c) => probe(app, c)));
  return children
    .map((c, i) => ({
      name: c.name,
      url: c.url,
      for: c.for,
      apps: c.apps,
      sentAt: c.createdAt,
      made: c.done,
      claimed: states[i]?.claimed ?? null,
      lastActivityAt: states[i]?.lastActivityAt ?? null,
    }))
    .sort(
      (a, b) =>
        (b.sentAt ?? "").localeCompare(a.sentAt ?? "") ||
        a.name.localeCompare(b.name),
    );
}
