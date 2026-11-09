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
 * issue the nightly hunt filed (`src/nightly/`).
 *
 * The excluded files are not unseen: the forge's nightly job (`src/nightly/`)
 * runs `outsideFiles` nightly and files a `Red:` issue for each that fails (#812).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
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
  { file: "test/apps-api.test.ts", reason: "not yet admitted", issue: 261 },
  {
    file: "test/apps-open-host.test.ts",
    reason: "not yet admitted",
    issue: 261,
  },
  { file: "test/apps-sleep.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/apps-ws.test.ts", reason: "not yet admitted", issue: 261 },
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
  {
    file: "test/rehearsal-real.test.ts",
    reason: "red on main@accaa65 under the gate: the second real roll's old forge does not come up",
    issue: 7632,
  },
  {
    file: "test/reviews.test.ts",
    reason: "red in random order: a posted review comment appears inline, anchored to its line",
    issue: 2106,
  },
  { file: "test/runs-lease.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/scaffold.test.ts", reason: "not yet admitted", issue: 261 },
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
  { file: "test/ssh-app.test.ts", reason: "not yet admitted", issue: 261 },
  {
    file: "test/ssh-port-taken.test.ts",
    reason: "not yet admitted",
    issue: 261,
  },
  { file: "test/ssh.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/studio-phone.test.ts", reason: "not yet admitted", issue: 261 },
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
 * What the scheduled run runs (`bun scripts/flake-hunt.ts outside`): the
 * present files `EXCLUDED` names, in name order. Derived from the same list
 * as `gateFiles`, so a file is in exactly one of the two: moving it into
 * the gate stops the schedule running it.
 */
export function outsideFiles(
  present: readonly string[] = presentTests(),
  excluded: readonly Exclusion[] = EXCLUDED,
): string[] {
  const gated = new Set(gateFiles(present, excluded));
  return present.filter((file) => !gated.has(file));
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

function git(args: string[], cwd: string = process.cwd()): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["git", ...args], { stderr: "pipe", cwd });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim() };
}

/**
 * Pins the pull edited, against its base: `$FORGE_CHECK_BASE`, else the
 * merge base with main. A pin whose migration is not on the base was never
 * history, so it is deleted and regenerated rather than left to a new migration.
 * It also compares HEAD to main's tip (#8352): a pin there that the pull's
 * own commits changed or deleted is refused, though a squash landing left
 * the merge base before it. A tree with no git history (the forge's full
 * check exports one) has nothing to diff and says so on stderr; a repository
 * where no base resolves is refused, never passed unchecked.
 */
// Imported on use: `treeGate` loads this file alone, outside the repository.
export async function pinRefusal(cwd: string = process.cwd()): Promise<string[]> {
  const { parseNameStatus, pinEdits, tipEdits, unpinnedAdds } = await import("../src/kernel/pin_edits.ts");
  if (!git(["rev-parse", "--git-dir"], cwd).ok) {
    console.error("gate: no base to compare to (set FORGE_CHECK_BASE): migration pins not checked");
    return [];
  }
  const env = process.env.FORGE_CHECK_BASE;
  const base =
    env || git(["merge-base", "origin/main", "HEAD"], cwd).out || git(["merge-base", "main", "HEAD"], cwd).out;
  const tip =
    env ||
    git(["rev-parse", "--verify", "--quiet", "origin/main^{commit}"], cwd).out ||
    git(["rev-parse", "--verify", "--quiet", "main^{commit}"], cwd).out;
  const unchecked = (why: string) => [
    `${why}: a migration on main is history, so its pins must be checked; set FORGE_CHECK_BASE or fetch origin/main`,
  ];
  if (!base || !tip) return unchecked("no base to compare to");
  const diff = git(["diff", "--name-status", "-M", `${base}..HEAD`], cwd);
  if (!diff.ok) return unchecked(`git diff against ${base} failed`);
  const fromTip = git(
    ["diff", "--name-status", "--no-renames", tip, "HEAD", "--", "src/core/migration-pins", "src/core/migration-pins.json"],
    cwd,
  );
  if (!fromTip.ok) return unchecked(`git diff against ${tip} failed`);
  const changes = parseNameStatus(diff.out);
  const edits = pinEdits(changes).map((path) => {
    const name = path.split("/").pop()?.replace(/\.pin$/, "") ?? "";
    const deleted = changes.some((c) => c.path === path && c.status.startsWith("D"));
    const onBase = git(["cat-file", "-e", `${base}:src/core/migrations/${name}.ts`], cwd).ok;
    if (path.endsWith(".pin") && !onBase)
      return `${path} was changed: its migration is not on the base yet, so delete the pin and re-run bun scripts/pin-migrations.ts`;
    return deleted
      ? `${path} was deleted: a migration on main is history, so restore it`
      : `${path} was changed: a migration on main is history, so add a new migration instead`;
  });
  // Pins on main's tip the pull's commits wrote: by content, so a rebase passes.
  const named = new Set(pinEdits(changes));
  const touched = (path: string) => git(["log", "-1", "--format=%H", `${base}..HEAD`, "--", path], cwd).out !== "";
  const landed = tipEdits(parseNameStatus(fromTip.out), touched)
    .filter(({ path }) => !named.has(path))
    .map(({ status, path }) =>
      status.startsWith("D")
        ? `${path} was deleted: a migration on main is history, so restore it`
        : `${path} was changed: a migration on main is history, so add a new migration instead`,
    );
  // Last, so the check's summary — its last line — names the one-step fix.
  const pinned = (name: string) => existsSync(join(cwd, "src/core/migration-pins", `${name}.pin`));
  const missing = unpinnedAdds(changes, pinned).map(
    (name) =>
      `this pull adds migration ${name} without its pin: run bun scripts/pin-migrations.ts and commit src/core/migration-pins/${name}.pin`,
  );
  return [...edits, ...landed, ...missing];
}

/** Review findings that repeated (#8888): see `src/kernel/review_rules.ts`. */
export function reviewRefusal(root = "."): string[] {
  // Loaded by `require` so `treeGate`, which loads this file alone, never needs it.
  const { reviewProblems } = require("../src/kernel/review_rules.ts") as typeof import("../src/kernel/review_rules.ts");
  const dir = join(root, "test");
  if (!existsSync(dir)) return [];
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => ({ path: `test/${f}`, text: readFileSync(join(dir, f), "utf8") }));
  return reviewProblems(sources);
}

/**
 * A pull that changes a reachable surface must say how to try it on its
 * preview (#8889). Same base and same pass-when-unknown as `pinRefusal`.
 */
export async function tryItRefusal(cwd: string = process.cwd()): Promise<string[]> {
  const { parseNameStatus } = await import("../src/kernel/pin_edits.ts");
  const { tryItProblems } = await import("../src/kernel/try_it.ts");
  const base =
    process.env.FORGE_CHECK_BASE ||
    git(["merge-base", "origin/main", "HEAD"], cwd).out ||
    git(["merge-base", "main", "HEAD"], cwd).out;
  if (!base) return [];
  const diff = git(["diff", "--name-status", "-M", `${base}..HEAD`], cwd);
  const log = git(["log", "--format=%B%x00", `${base}..HEAD`], cwd);
  if (!diff.ok || !log.ok) return [];
  return tryItProblems(parseNameStatus(diff.out), log.out.split("\0").map((m) => m.trim()).filter(Boolean));
}

// `bun scripts/gate.ts`: the audit alone, first in `forge.json`'s check, so
// a stale exclusion fails in under a second — not after install and tsc.
if (import.meta.main) {
  const refusal = [...gateRefusal(presentTests()), ...(await pinRefusal()), ...(await tryItRefusal()), ...reviewRefusal()];
  for (const line of refusal) console.error(`gate: ${line}`);
  process.exit(refusal.length === 0 ? 0 : 2);
}
