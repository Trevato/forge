/**
 * Why a gate went red (#5276), read once where the gate ends and carried on
 * the verdict, so the queue's log says it and acts on it:
 *
 * - `tests` — the check ran and named red tests: the code's, searched.
 * - `typecheck` — tsc printed an error: the code's, searched.
 * - `check` — the check step exited red and named neither: the code's,
 *   searched, as every red was before this.
 * - `install` — the install step failed (#5093), `setup` — the gate failed
 *   before any step ran (export, history, a manifest it could not read),
 *   `timeout` — a step ran past its time. None of these says which pull is
 *   at fault: the queue gates once more and then calls it infrastructure,
 *   never red for a pull, and never searched.
 *
 * Plain data in, plain data out: no I/O here.
 */

import type { GateTests } from "./gate_tests.ts";

/** Where in its run the gate stopped red, as the check service saw it. */
export type GateStage = "setup" | "install" | "check" | "timeout";

export type GateReason =
  | { readonly kind: "tests"; readonly failed: number }
  | { readonly kind: "typecheck" }
  | { readonly kind: "check" }
  | { readonly kind: "install" }
  | { readonly kind: "setup" }
  | { readonly kind: "timeout" };

/** `src/x.ts(3,5): error TS2322: …` or `src/x.ts:3:5 - error TS2322: …`. */
const TSC_ERROR = /\berror TS\d+:/;

/** What a step's error says when it ran past its time (`apps/process.ts`). */
const TOOK_LONGER = /^\S+ took longer than \d+s/;

/**
 * The reason of a red gate: its stage, and for the check step what its
 * lines name. `failedTests` is how many red tests `failuresOf` read.
 */
export function gateReason(stage: GateStage, error: string, lines: readonly string[], failedTests: number): GateReason {
  if (stage === "timeout" || TOOK_LONGER.test(error)) return { kind: "timeout" };
  if (stage === "install") return { kind: "install" };
  if (stage === "setup") return { kind: "setup" };
  if (failedTests > 0) return { kind: "tests", failed: failedTests };
  if (lines.some((line) => TSC_ERROR.test(line))) return { kind: "typecheck" };
  return { kind: "check" };
}

/** Whether a red with this reason is the code's, and so searched for its culprit. */
export function searched(reason: GateReason | undefined): boolean {
  if (reason === undefined) return true;
  return reason.kind === "tests" || reason.kind === "typecheck" || reason.kind === "check";
}

/** The reason in the queue's log: `install`, `typecheck`, `tests: 3 failed`. */
export function reasonWords(reason: GateReason | undefined): string {
  if (reason === undefined) return "check";
  return reason.kind === "tests" ? `tests: ${reason.failed} failed` : reason.kind;
}

/** The most failing tests the queue's log line names; the rest are counted. */
export const LOG_NAMES = 5;

/**
 * A red in the queue's log (#6739): the failing tests by name when the gate
 * named any — `2 failed: "a > b", "c > d"`, `… and 3 more` past
 * `LOG_NAMES` — and otherwise its reason, as `reasonWords` says it.
 */
export function redWords(reason: GateReason | undefined, tests: GateTests | undefined): string {
  if (tests === undefined || tests.failing.length === 0) return reasonWords(reason);
  const failed = Math.max(tests.failed, tests.failing.length);
  const named = tests.failing.slice(0, LOG_NAMES).map((t) => JSON.stringify(t.name));
  const more = failed - named.length;
  return `${failed} failed: ${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

/**
 * A merge conflict in a batch, the earlier pull first and the one left out
 * second: `merge-conflict (#5088 × #5090)`; `main × #5090` against the base.
 */
export function conflictWords(earlier: number | undefined, pull: number): string {
  return `merge-conflict (${earlier === undefined ? "main" : `#${earlier}`} × #${pull})`;
}

/** The stage of a check step that ended red: `timeout` when it ran past its time. */
export function checkStage(error: string): GateStage {
  return TOOK_LONGER.test(error) ? "timeout" : "check";
}
