/**
 * The batch doctor's first question about a red (#7555): was it the load,
 * the machine, or the code? Read off the verdict the gate already carries
 * (`reason`, `tests`), never off a log.
 *
 * - `budget`: every failing test threw `expectBudget` — the gate's own load
 *   (the queue re-gates a red pull alone later); not held.
 * - `infra`: the gate stopped before tests, or a test died on the machine
 *   (extract, ENOENT, tarball, disk); not held.
 * - `functional`: a test the code made fail; held when alone.
 *
 * Plain data in, plain data out: no I/O.
 */

import type { GateReason } from "./gate_reason.ts";
import type { FailedTest, GateTests } from "./gate_tests.ts";

/** What a test's `expectBudget` throws: the mark of a timing red, not a logic one. */
const BUDGET_MARK = "over budget (expectBudget)";

export type RedClass = "budget" | "infra" | "functional";

export interface Diagnosis {
  readonly class: RedClass;
  /** The first failing test, when the gate named one. */
  readonly test?: FailedTest;
  /** The line the class went on: the first error line, else the reason. */
  readonly probe: string;
}

// Specific shapes only: a bare word like `extract` is as likely a function under test.
const INFRA = /\b(ENOENT|ENOSPC|EMFILE|ETIMEDOUT|ECONNRESET)\b|no space left|disk quota|(^|\s)tar: /i;
const PROBE_MAX = 300;

const clip = (s: string): string => (s.length > PROBE_MAX ? `${s.slice(0, PROBE_MAX - 1)}…` : s);

/** Class a red from its reason and the tests it named. */
export function classify(reason: GateReason | undefined, tests: GateTests | undefined): Diagnosis {
  if (reason !== undefined && (reason.kind === "install" || reason.kind === "setup" || reason.kind === "timeout"))
    return { class: "infra", probe: reason.kind };
  const failing = tests?.failing ?? [];
  const first = failing[0];
  const probe = clip(first?.errors[0] ?? (reason?.kind ?? "check"));
  // No test named: nothing to hold it by, so it is the queue's to re-gate.
  if (first === undefined) return { class: "infra", probe };
  const errors = (t: FailedTest): string => t.errors.join("\n");
  if (failing.every((t) => t.errors[0]?.includes(BUDGET_MARK))) return { class: "budget", test: first, probe };
  if (failing.every((t) => INFRA.test(errors(t)))) return { class: "infra", test: first, probe };
  return { class: "functional", test: first, probe };
}

const SAFE = /^[\w@./+-]{1,200}$/;

/** The command that reproduces a failing test, or undefined when its file is not a plain path. */
export function reproduce(test: FailedTest | undefined): string | undefined {
  if (test?.file === undefined || !SAFE.test(test.file)) return undefined;
  const path = test.file.startsWith("./") || test.file.startsWith("/") ? test.file : `./${test.file}`;
  return `bun test ${path}`;
}
