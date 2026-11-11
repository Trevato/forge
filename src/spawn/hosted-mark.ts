/**
 * Which Apps are hosted children: a second `App` in the parent's process.
 * `main.ts` starts a crew for the parent only, so a hosted child has none;
 * the crew pages ask this to say so instead of promising a runner.
 *
 * A hosted child's admin is its owner, not this machine's: its cells hide
 * the parent's data as well as its own, and take no egress grant, which is
 * a site admin's word about this machine's network (`core/egress_grants.ts`).
 */

import { tmpdir } from "node:os";
import type { App } from "../app.ts";

/** Each hosted child, and the data directory of the parent that holds it. */
const hosted = new WeakMap<App, string>();

export function markHostedChild(child: App, parentDataDir: string): void {
  hosted.set(child, parentDataDir);
}

export const isHostedChild = (app: App): boolean => hosted.has(app);

/** What every cell of `app`'s code hides: its data, its host's home and temp, and the parent's data when it is hosted. */
export function cellHides(app: App): string[] {
  const parent = hosted.get(app);
  return [app.config.dataDir, ...(parent === undefined ? [] : [parent]), process.env["HOME"] ?? "", tmpdir()];
}

/** The grants a cell of `app` may use: none for a hosted child, whatever its own admin stored. */
export const grantsHere = (app: App, granted: () => string[]): string[] => (isHostedChild(app) ? [] : granted());
