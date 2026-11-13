/**
 * Whether a forge this one made answers yet: the one answer behind
 * `GET /forges/<name>/ready` and the terminal's "Does a forge answer?".
 * Probes the child's `/healthz` through the probe seam; says yes or no, never
 * the claim code or the address. `undefined` is a name this forge never made.
 */
import { childNamed } from "../actions/spawn.ts";
import type { App } from "../app.ts";
import { probeFor } from "./door.ts";
import { isAwakeBody } from "./host.ts";

/** A booting child must never hold this forge's loop. */
export const READY_PROBE_MS = 800;

/**
 * Where a forge this one made is on its way to answering: `starting` while its
 * process is not up yet, `answering` once it runs here and its public address
 * is being asked, `ready` when that address answers.
 */
export type ChildStep = "starting" | "answering" | "ready";

export async function childStep(app: App, name: string, onPhase?: <T>(phase: string, run: () => Promise<T>) => Promise<T>): Promise<ChildStep | undefined> {
  const time = onPhase ?? ((_p, run) => run());
  const child = await time("ledger", () => childNamed(app, name));
  if (child === undefined) return undefined;
  // Always asked, awake or not: the ask is also what wakes a forge that sleeps.
  if (await time("probe", () => probeFor(app, child.url, READY_PROBE_MS)())) return "ready";
  return isAwakeBody(app, child.bodyId) ? "answering" : "starting";
}

export async function childReady(app: App, name: string): Promise<boolean | undefined> {
  const step = await childStep(app, name);
  return step === undefined ? undefined : step === "ready";
}
