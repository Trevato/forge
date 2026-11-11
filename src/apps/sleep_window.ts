/**
 * How long an environment may serve nobody before the sweep puts it to
 * sleep, and the words its log says when it does. The window comes from
 * the profit slider's position (`core/slider.ts`), read on every sweep so
 * moving the slider takes effect within one pass; an app's
 * `app.always_on: true` keeps its production awake whatever the position.
 *
 * Plain data in, plain data out.
 */

import { duration, policyAt } from "../core/slider.ts";

/** Where a window came from: the slider at a position, or a fixed setting (tests, a child forge). */
export type WindowSource =
  | { readonly kind: "slider"; readonly position: number }
  | { readonly kind: "fixed"; readonly sleepAfterMs: { readonly production: number; readonly preview: number } };

export interface SleepWindow {
  /** Idle milliseconds before it sleeps; `null` is never. */
  readonly ms: number | null;
  /** Why it is this long, for the log: "economy 20", "always_on". */
  readonly why: string;
}

/** The window for one environment: production or a preview. */
export function sleepWindow(
  source: WindowSource,
  production: boolean,
  alwaysOn: boolean,
): SleepWindow {
  if (production && alwaysOn) return { ms: null, why: "always_on" };
  if (source.kind === "fixed") {
    const { sleepAfterMs } = source;
    return { ms: production ? sleepAfterMs.production : sleepAfterMs.preview, why: "set for this forge" };
  }
  const after = policyAt(source.position).sleepAfterMs;
  return { ms: production ? after.production : after.preview, why: `economy ${source.position}` };
}

/** "asleep: nothing asked for it in 10 min (economy 20); the next request wakes it" */
export function asleepWords(window: SleepWindow & { readonly ms: number }): string {
  return `asleep: nothing asked for it in ${duration(window.ms)} (${window.why}); the next request wakes it`;
}

/**
 * `FORGE_PREVIEW_IDLE_DAYS` as the runtime's `idlePullMs`: unset is
 * `undefined`, so the runtime follows the slider each sweep; set pins the
 * age (0 keeps every preview warm). A value that is not a non-negative
 * number pins the default age, as it always has.
 */
export function previewIdleMs(raw: string | undefined, fallbackDays: number): number | undefined {
  if (raw === undefined) return undefined;
  const days = Number(raw);
  return (Number.isFinite(days) && days >= 0 ? days : fallbackDays) * 86_400_000;
}
