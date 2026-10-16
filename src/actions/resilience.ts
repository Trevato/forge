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
