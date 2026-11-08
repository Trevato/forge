/**
 * Which Apps are hosted children: a second `App` in the parent's process.
 * `main.ts` starts a crew for the parent only, so a hosted child has none;
 * the crew pages ask this to say so instead of promising a runner.
 */

import type { App } from "../app.ts";

const hosted = new WeakSet<App>();

export function markHostedChild(child: App): void {
  hosted.add(child);
}

export const isHostedChild = (app: App): boolean => hosted.has(app);
