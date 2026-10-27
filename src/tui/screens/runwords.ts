/**
 * How a run reads: the tone its state wears, the environment as a person says
 * it, the dollars it spent. Shared by the runs list and the run's log so
 * neither imports the other.
 */

import type { RunState } from "../../core/runs.ts";
import type { Tone } from "../ui/widgets.ts";

/** The tone a run's state wears — the same reading on every surface. */
export function runTone(state: RunState): Tone | undefined {
  switch (state) {
    case "ok":
      return "success";
    case "failed":
      return "danger";
    case "running":
      return "attn";
    case "cancelled":
      return "secondary";
    case "queued":
      return undefined;
  }
}

/** `production`, or `pull #4` — the environment as a person says it. */
export function envLabel(env: string): string {
  return env.startsWith("pull-") ? `pull #${env.slice(5)}` : env || "—";
}

/** The dollars a run spent, or nothing when it spent none. */
export function costText(costUsd: number): string {
  return costUsd > 0 ? `$${costUsd.toFixed(2)}` : "";
}
