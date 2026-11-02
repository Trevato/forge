/**
 * The test files the fast tier would run for your diff.
 *
 *   bun scripts/fast.ts [--base origin/main] [--why | --null | --json]
 *   files=$(bun scripts/fast.ts) && bun test $files
 *   bun scripts/fast.ts --null | xargs -0 -r bun test
 *
 * The files changed between the base and the working tree (committed and
 * uncommitted, untracked included) go through `fastSet`, with the times
 * table and `scripts/test-impact.json` as the check reads them. Stdout
 * holds only the answer: one path per line (`--why` adds a tab and the
 * reason, `--null` ends each path with NUL, `--json` is one object).
 * Words for people go to stderr. Exit 0: files listed. Exit 2: the diff
 * is unbounded (full tier) or the arguments or git failed. Exit 3: the
 * change reaches no test, stdout empty. A bare `bun test $(…)` with
 * nothing listed would run everything, so guard on the exit code (`&&`).
 * Git is spawned with an argument list, never a shell.
  */

import { readFileSync } from "node:fs";
import { GATE_FILE, gateListAdds, handedImpact, needsFull } from "../src/checks/impact.ts";
import { fastSet, duration } from "../src/checks/tiers.ts";
import { importsReader, readImpact } from "./tier-input.ts";
import { CHECK_CACHE } from "../src/checks/cache.ts";
import { gateFiles } from "./gate.ts";
import { overlayTimes, parseTimes } from "./shards.ts";

/** A revision git cannot read as a flag. */
const REV = /^[A-Za-z0-9_][A-Za-z0-9_./@^~-]*$/;

export type Args =
  | { readonly ok: true; readonly base: string; readonly format: Format }
  | { readonly ok: false; readonly error: string };

export type Format = "lines" | "why" | "null" | "json";

/** `[--base REV] [--why | --null | --json]`; anything else is refused. */
export function parseArgs(argv: readonly string[]): Args {
  let base = "origin/main";
  let format: Format | undefined;
  let seenBase = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--why" || arg === "--null" || arg === "--json") {
      if (format !== undefined) return { ok: false, error: "one of --why, --null, --json" };
      format = arg.slice(2) as Format;
    } else if (arg === "--base" || arg.startsWith("--base=")) {
      const value = arg === "--base" ? argv[++i] : arg.slice("--base=".length);
      if (seenBase) return { ok: false, error: "--base named twice" };
      if (value === undefined || !REV.test(value))
        return { ok: false, error: "--base needs a revision such as origin/main" };
      base = value;
      seenBase = true;
    } else return { ok: false, error: `unknown argument ${arg.slice(0, 40)}` };
  }
  return { ok: true, base, format: format ?? "lines" };
}

/** Paths from `git diff --name-only` / `ls-files` output: one per line, no repeats, none outside the repo. */
export function parseNames(...outputs: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const output of outputs)
    for (const line of output.split("\n")) {
      const path = line.trim();
      if (path === "" || path.startsWith("/") || path.split("/").includes("..")) continue;
      seen.add(path);
    }
  return [...seen];
}

export interface Report {
  /** Exactly what goes to stdout. */
  readonly stdout: string;
  /** Words for a person, to stderr. */
  readonly notes: string[];
  readonly code: 0 | 2 | 3;
}

/**
 * What to print: the files, nothing (3), or the full tier (2). Stdout never
 * carries a sentence, so word-splitting it cannot hand `bun test` a filter;
 * `--json` always carries the whole answer, `full` included.
 */
export function report(
  plan: { files: readonly string[]; why: ReadonlyMap<string, string> },
  unbounded: string | undefined,
  format: Format,
): Report {
  const code = unbounded !== undefined ? 2 : plan.files.length === 0 ? 3 : 0;
  const files = unbounded !== undefined ? [] : plan.files;
  const notes =
    unbounded !== undefined
      ? [`fast: full tier: ${unbounded} changed; the diff is not bounded`]
      : files.length === 0
        ? ["fast: the change reaches no test; nothing to run"]
        : [];
  if (format === "json")
    return {
      stdout:
        JSON.stringify({
          full: unbounded ?? null,
          files: files.map((file) => ({ file, why: plan.why.get(file) ?? "" })),
        }) + "\n",
      notes,
      code,
    };
  if (format === "null") return { stdout: files.map((file) => `${file}\0`).join(""), notes, code };
  return {
    stdout: files
      .map((file) => (format === "why" ? `${file}\t${plan.why.get(file) ?? ""}\n` : `${file}\n`))
      .join(""),
    notes,
    code,
  };
}

function git(args: string[]): string {
  const run = Bun.spawnSync(["git", ...args], { stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${run.stderr.toString().trim()}`);
  return run.stdout.toString();
}

function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function loadTimes(): Map<string, number> {
  const one = (path: string): Map<string, number> => {
    const text = read(path);
    const parsed = text === undefined ? undefined : parseTimes(text);
    return parsed?.ok ? parsed.value : new Map();
  };
  return overlayTimes(
    one(new URL("./test-times.json", import.meta.url).pathname),
    one(`${CHECK_CACHE}/test-times.json`),
  );
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error(`fast: ${args.error}`);
    return 2;
  }
  let changed: string[];
  let gateAdds: string[] | undefined;
  try {
    const from = git(["merge-base", args.base, "HEAD"]).trim();
    changed = parseNames(
      git(["diff", "--name-only", "--no-renames", from]),
      git(["ls-files", "--others", "--exclude-standard"]),
    );
    if (changed.includes(GATE_FILE))
      gateAdds = gateListAdds(git(["diff", "-U0", "--no-renames", from, "--", GATE_FILE]));
  } catch (error) {
    console.error(`fast: ${(error as Error).message}`);
    return 2;
  }
  const tests = gateFiles();
  const handed = handedImpact(process.env["FORGE_CHECK_IMPACT"]);
  const impact = readImpact(
    handed ?? new URL("./test-impact.json", import.meta.url).pathname,
    handed ?? "scripts/test-impact.json",
    (line) => console.error(`fast: ${line}`),
  );
  const imports = importsReader();
  const plan = fastSet({
    ...(impact === undefined ? {} : { impact }),
    changed,
    ...(gateAdds === undefined ? {} : { gateAdds }),
    tests,
    imports,
    times: loadTimes(),
  });
  const out = report(plan, needsFull(changed, gateAdds), args.format);
  process.stdout.write(out.stdout);
  for (const note of out.notes) console.error(note);
  if (out.code === 0)
    console.error(
      `fast: ${plan.files.length} of ${tests.length} files for ${changed.length} changed, expected ${duration(plan.expected)}${plan.overBudget ? " (over the 5m budget)" : ""}`,
    );
  return out.code;
}

if (import.meta.main) process.exit(main());
