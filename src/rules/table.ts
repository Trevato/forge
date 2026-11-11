/**
 * The repo-wide rules and the fix for each (#7560): one entry per rule test.
 * A failing rule test is named `<describe> > <breach>`, the breach being
 * `path:line: source` (`test/helpers/rule.ts`) or `path is not pinned: …`.
 * Plain text in, plain data out.
 */

export interface RuleFix {
  /** The rule, as its describe says it. */
  readonly rule: string;
  /** What the describe's name starts with. */
  readonly describe: RegExp;
  /** The fix, one sentence. */
  readonly fix: string;
}

export const RULES: readonly RuleFix[] = [
  {
    rule: "no raw wall-clock budget in a test (#4429)",
    describe: /^no raw wall-clock budget in a test \(#4429\)/,
    fix: "hold the speed by counting work with `expectWork(measured, { max })` from test/helpers/work.ts (SQL statements, bytes, git spawns), not by milliseconds; a hang guard above 1 s may stay a plain expect",
  },
  {
    rule: "no tight wall-clock bound in a test",
    describe: /^no tight wall-clock bound in a test/,
    fix: "assert a speed relative to a baseline measured in the same run, or bound it at 200 ms or more (WALL_CLOCK_FLOOR_MS in scripts/flake.ts) so only the failure the test names crosses it",
  },
  {
    rule: "no wait that runs out of time and carries on (#9017)",
    describe: /^a wait that runs out of time and carries on/,
    fix: "wait on the event itself, or throw when the deadline passes instead of falling through to the next line",
  },
  {
    rule: "every migration is pinned by its own pull (#783)",
    describe: /^a migration on main is never edited/,
    fix: "run `bun scripts/pin-migrations.ts` and commit the one `.pin` file it writes beside the migration; never edit a migration that is already pinned, add a new one",
  },
];

export interface Breach {
  readonly rule: string;
  readonly fix: string;
  readonly file: string;
  readonly line?: number;
  /** The breach as the test named it, cut. */
  readonly said: string;
}

const AT = /^([\w@./+-]{1,200}):(\d+): /;
const FILE_ONLY = /^([\w@./+-]{1,200}) is not pinned/;
const SAID_MAX = 200;

/** The rule a failing test's name breaks, with the place it names; undefined when it is no rule's. */
export function breachOf(name: string): Breach | undefined {
  const cut = name.indexOf(" > ");
  if (cut < 0) return undefined;
  const entry = RULES.find((r) => r.describe.test(name.slice(0, cut)));
  if (entry === undefined) return undefined;
  const said = name.slice(cut + 3);
  const at = AT.exec(said);
  if (at !== null) return { rule: entry.rule, fix: entry.fix, file: at[1]!, line: Number(at[2]), said: said.slice(0, SAID_MAX) };
  const file = FILE_ONLY.exec(said)?.[1];
  // A rule test red with no place (its aggregate test) names no file: no exact comment.
  if (file === undefined) return undefined;
  return { rule: entry.rule, fix: entry.fix, file, said: said.slice(0, SAID_MAX) };
}
