/**
 * Whether a forge this one made answers yet: the one answer behind
 * `GET /forges/<name>/ready` and the terminal's "Does a forge answer?".
 * Probes the child's `/healthz` through the probe seam; says yes or no, never
 * the claim code or the address. `undefined` is a name this forge never made.
 */
import { childNamed } from "../actions/spawn.ts";
import type { App } from "../app.ts";
import { probeFor } from "./door.ts";

/** A booting child must never hold this forge's loop. */
export const READY_PROBE_MS = 800;

export async function childReady(app: App, name: string, onPhase?: <T>(phase: string, run: () => Promise<T>) => Promise<T>): Promise<boolean | undefined> {
  const time = onPhase ?? ((_p, run) => run());
  const child = await time("ledger", () => childNamed(app, name));
  if (child === undefined) return undefined;
  return time("probe", () => probeFor(app, child.url, READY_PROBE_MS)());
}
