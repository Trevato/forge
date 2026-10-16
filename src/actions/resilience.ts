/**
 * Each failure domain with its last drill, read by the forge's owner
 * (`kernel/domains.ts`, `core/domain_drills.ts`): a forge admin only, never
 * an agent, and everyone else is told `not_found`. The settings page and the
 * terminal read this and nothing else.
 */

import type { App } from "../app.ts";
import { lastDrill, type LastDrill } from "../core/domain_drills.ts";
import type { User } from "../core/users.ts";
import { DOMAINS } from "../kernel/domains.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { snapshotsOf } from "../snapshot/service.ts";
import { forgeNeeds } from "./health.ts";

export interface ResilienceRow {
  readonly key: string;
  readonly name: string;
  readonly breaks: string;
  readonly says: readonly string[];
  readonly backMinutes: number;
  /** A drill's name and its last result (none yet), or why there is none. */
  readonly drill:
    | { readonly name: string; readonly last: LastDrill | null }
    | { readonly name: null; readonly why: string };
}

export function listResilience(
  app: App,
  actor: User | undefined,
): Result<ResilienceRow[], "not_found"> {
  if (actor?.isAdmin !== true || actor.kind === "agent") return err("not_found");
  return ok(
    DOMAINS.map((d) => ({
      key: d.key,
      name: d.name,
      breaks: d.breaks,
      says: d.says,
      backMinutes: d.backMinutes,
      drill:
        d.drill.name === null
          ? { name: null, why: d.drill.why }
          : { name: d.drill.name, last: lastDrill(app.db, d.key) },
    })),
  );
}

/** Where snapshots go and the newest one, as Settings → Backups says them. */
export interface SnapshotView {
  /** The store's name (never a secret), or null when the forge has none. */
  readonly where: string | null;
  readonly mirror: string | null;
  /** The newest snapshot's finish time and size, or null when none is kept (or the store cannot be read). */
  readonly last: { readonly at: string; readonly bytes: number } | null;
}

export interface OwnerView {
  readonly needs: string[];
  readonly snapshots: SnapshotView;
  readonly domains: (ResilienceRow & { readonly owner: string })[];
}

/** What needs the owner: the forge's needs, its snapshot store, and every failure domain. */
export async function ownerView(
  app: App,
  actor: User | undefined,
): Promise<Result<OwnerView, "not_found">> {
  const listed = listResilience(app, actor);
  if (!listed.ok) return listed;
  const handle = snapshotsOf(app);
  let last: SnapshotView["last"] = null;
  try {
    const newest = (await handle?.list())?.[0];
    if (newest !== undefined) last = { at: newest.finishedAt, bytes: newest.bytes };
  } catch {
    // an unreadable store is a nothing-to-show, the domain row says what to do
  }
  const owner = new Map(DOMAINS.map((d) => [d.key, d.owner]));
  return ok({
    needs: forgeNeeds(app, actor) ?? [],
    snapshots: {
      where: handle?.store?.where ?? null,
      mirror: handle?.mirror?.where ?? null,
      last,
    },
    domains: listed.value.map((d) => ({ ...d, owner: owner.get(d.key) ?? "" })),
  });
}
