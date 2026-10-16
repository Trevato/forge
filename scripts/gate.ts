/**
 * Which test files the gate runs, and why the few others do not.
 *
 * The gate is every `test/*.test.ts` minus `EXCLUDED` (`gateFiles`): the
 * list `bun scripts/test-shards.ts --gate` runs, so `forge.json`'s
 * `check.run` names no test file itself, and a new test file is gated the
 * moment it exists — no shared list to edit, nothing to conflict on (#2037).
 * `EXCLUDED` is the quarantine: each file with the reason it is out and the
 * issue that owns bringing it back. `test/check-list.test.ts` goes red when
 * an exclusion names a file that does not exist, twice, or without a reason
 * or an issue.
 *
 * A file rejoins the gate by deleting its `EXCLUDED` entry in a pull whose
 * check is green and whose description carries ten green runs in random
 * order under load (`bun scripts/flake-hunt.ts admit <file>`). A flaky file
 * leaves it only through `bun scripts/flake-hunt.ts quarantine`, under the
 * issue the nightly hunt filed (`.forgejo/workflows/flake-hunt.yml`).
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

export type Exclusion = {
  /** Repository-relative path, `test/….test.ts`. */
  file: string;
  /** One line: why the gate does not run it today. */
  reason: string;
  /** The issue that owns admitting it. */
  issue: number;
};

export const EXCLUDED: readonly Exclusion[] = [
  { file: "test/crew-sandbox-real.test.ts", reason: "landed unlisted and red locally; the builder admits it", issue: 1238 },
  { file: "test/api-errors.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/apps-api.test.ts", reason: "not yet admitted", issue: 261 },
  {
    file: "test/apps-open-host.test.ts",
    reason: "not yet admitted",
    issue: 261,
  },
  { file: "test/apps-sleep.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/apps-ws.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/audit.test.ts", reason: "not yet admitted", issue: 261 },
  {
    file: "test/board-windows.test.ts",
    reason:
      "red: an app with spend and nothing shipped is missing from the board",
    issue: 555,
  },
  {
    file: "test/crew-interrupted.test.ts",
    reason: "not yet admitted",
    issue: 261,
  },
  { file: "test/parity.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/probe.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/probes.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/prompts.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/public-url.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/push-through.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/read-api.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/revert.test.ts", reason: "not yet admitted", issue: 261 },
  {
    file: "test/reviews-states.test.ts",
    reason: "not yet admitted",
    issue: 261,
  },
  { file: "test/reviews.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/runs-lease.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/scaffold.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/search.test.ts", reason: "not yet admitted", issue: 261 },
  {
    file: "test/security-merge.test.ts",
    reason: "not yet admitted",
    issue: 261,
  },
  { file: "test/security-xss.test.ts", reason: "not yet admitted", issue: 261 },
  {
    file: "test/snapshot-destination.test.ts",
    reason: "not yet admitted",
    issue: 261,
  },
  { file: "test/snapshot.test.ts", reason: "not yet admitted", issue: 261 },
  {
    file: "test/spawn-placement.test.ts",
    reason: "not yet admitted",
    issue: 261,
  },
  { file: "test/sse.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/ssh-app.test.ts", reason: "not yet admitted", issue: 261 },
  {
    file: "test/ssh-port-taken.test.ts",
    reason: "not yet admitted",
    issue: 261,
  },
  { file: "test/ssh.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/standards.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/studio-phone.test.ts", reason: "not yet admitted", issue: 261 },
  {
    file: "test/subscriptions.test.ts",
    reason: "not yet admitted",
    issue: 261,
  },
  {
    file: "test/tui-code.test.ts",
    reason:
      "red: the dashboard counts query runs 3 times and a bus event does not refresh it",
    issue: 2082,
  },
  { file: "test/tui-asked.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/tui-boards.test.ts", reason: "not yet admitted", issue: 261 },
];

/**
 * Everything wrong with the quarantine, against the test files that exist:
 * one line per problem, none when every exclusion is sound.
 */
export function auditGate(
  present: readonly string[],
  excluded: readonly Exclusion[],
): string[] {
  const problems: string[] = [];
  const exists = new Set(present);
  const out = new Set<string>();
  for (const { file, reason, issue } of excluded) {
    if (out.has(file)) problems.push(`${file} is in EXCLUDED twice`);
    out.add(file);
    if (!exists.has(file))
      problems.push(`${file} is in EXCLUDED but does not exist`);
    if (typeof reason !== "string" || reason.trim() === "")
      problems.push(`${file} is excluded with no reason`);
    if (!Number.isInteger(issue) || issue <= 0)
      problems.push(`${file} is excluded with no issue number`);
  }
  return problems;
}

/** The `test/*.test.ts` files under `root`, as the gate names them. */
export function presentTests(root = "."): string[] {
  try {
    return readdirSync(`${root}/test`)
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => `test/${name}`)
      .sort();
  } catch {
    return [];
  }
}

/** What the gate runs: every present test file not excluded, in name order. */
export function gateFiles(
  present: readonly string[] = presentTests(),
  excluded: readonly Exclusion[] = EXCLUDED,
): string[] {
  const out = new Set(excluded.map((e) => e.file));
  return present.filter((file) => !out.has(file));
}

/**
 * The gate a checked-out tree's own `scripts/gate.ts` names, whichever shape
 * it has: a tree from before #2071 lists it in `GATE`; a later one derives
 * it with `gateFiles` from the tree's test files. `key` makes each tree's
 * import its own module, so one process can read many commits.
 */
export async function treeGate(tree: string, key: string): Promise<string[]> {
  const module = (await import(`${join(tree, "scripts/gate.ts")}?${key}`)) as {
    GATE?: readonly string[];
    gateFiles?: (present: readonly string[]) => string[];
    presentTests?: (root: string) => string[];
  };
  if (module.gateFiles && module.presentTests)
    return module.gateFiles(module.presentTests(tree));
  return [...(module.GATE ?? [])];
}

/**
 * What the check prints when the quarantine is wrong: every problem, then
 * one last line naming the files to fix. Empty when it is right.
 */
export function gateRefusal(present: readonly string[]): string[] {
  const problems = auditGate(present, EXCLUDED);
  if (problems.length === 0) return [];
  const named = [
    ...new Set(problems.map((p) => p.match(/^(test\/\S+\.test\.ts) /)?.[1])),
  ].filter((f): f is string => f !== undefined);
  return [
    ...problems,
    `${named.join(", ")}: fix its EXCLUDED entry in scripts/gate.ts`,
  ];
}

// `bun scripts/gate.ts`: the audit alone, first in `forge.json`'s check, so
// a stale exclusion fails in under a second — not after install and tsc.
if (import.meta.main) {
  const refusal = gateRefusal(presentTests());
  for (const line of refusal) console.error(`gate: ${line}`);
  process.exit(refusal.length === 0 ? 0 : 2);
}
