/**
 * The roll recipe's first step (`docs/ops/ROLL.md`, #1588): read what
 * `kubectl` printed, answer with `scripts/roll.ts` whether a surge pod can
 * schedule beside the running forge, print that answer, and exit:
 *
 *   0  it fits: the roll is zero-downtime
 *   3  it does not fit and the owner has not said yes to this version:
 *      do not roll; the answer names the seconds dark and the headroom
 *   2  the input is not what kubectl prints
 *
 *   bun scripts/roll-preflight.ts --node node.json --pods pods.json \
 *     --pod forge/forge-7d9c-abcde --steady 3712Mi [--json]
 *     [--version 0.7.104 --yes-file docs/ops/dark-rolls.log --dark-seconds 90]
 *
 * With no surge, exit 0 needs the log to hold a yes for exactly --version
 * (`scripts/dark-roll.ts`, #1589).
 *
 * It runs nothing and reaches no cluster: the files are the operator's.
 */

import { readFileSync } from "node:fs";
import { ask, decide, isVersion, parseYeses } from "./dark-roll.ts";
import { parseQuantity, report, surge } from "./roll.ts";

export interface Args {
  readonly node: string;
  readonly pods: string;
  readonly pod: string;
  readonly steady: string;
  readonly json: boolean;
  readonly version: string | null;
  readonly yesFile: string | null;
  readonly darkSeconds: number | null;
}

const VALUED = ["--node", "--pods", "--pod", "--steady", "--version", "--yes-file", "--dark-seconds"] as const;

export function parseArgs(argv: readonly string[]): Args {
  const one: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] ?? "";
    if (flag === "--json") {
      json = true;
      continue;
    }
    if (!(VALUED as readonly string[]).includes(flag))
      throw new Error(`unknown argument ${JSON.stringify(flag).slice(0, 40)}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`${flag} wants a value`);
    if (one[flag] !== undefined) throw new Error(`${flag} given twice`);
    one[flag] = value;
  }
  const need = (f: (typeof VALUED)[number]): string => {
    const v = one[f];
    if (v === undefined) throw new Error(`${f} is required`);
    return v;
  };
  return {
    node: need("--node"),
    pods: need("--pods"),
    pod: need("--pod"),
    steady: need("--steady"),
    json,
    version: one["--version"] ?? null,
    yesFile: one["--yes-file"] ?? null,
    darkSeconds: one["--dark-seconds"] === undefined ? null : Number(one["--dark-seconds"]),
  };
}

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`cannot read ${path}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} is not JSON — was it written with -o json?`);
  }
}

/** The whole step as a function of the arguments: exit code and output. */
export function run(argv: readonly string[]): { code: number; out: string } {
  try {
    const args = parseArgs(argv);
    const steady = parseQuantity(args.steady);
    if (steady === null)
      throw new Error(`--steady ${JSON.stringify(args.steady).slice(0, 40)} is not a quantity`);
    const s = surge({
      node: readJson(args.node),
      pods: readJson(args.pods),
      forgePod: args.pod,
      steadyMemory: steady,
    });
    if (args.version !== null && !isVersion(args.version))
      throw new Error(`--version ${JSON.stringify(args.version).slice(0, 40)} is not a version`);
    if (
      args.darkSeconds !== null &&
      !(Number.isInteger(args.darkSeconds) && args.darkSeconds >= 0 && args.darkSeconds <= 86400)
    )
      throw new Error("--dark-seconds is whole seconds, 0 to 86400");
    let yeses: ReturnType<typeof parseYeses> = [];
    if (args.yesFile !== null) {
      try {
        yeses = parseYeses(readFileSync(args.yesFile, "utf8"));
      } catch {
        throw new Error(`cannot read ${args.yesFile}`);
      }
    }
    const d = decide(s, args.version, yeses);
    const text = args.json
      ? JSON.stringify({ ...s, roll: d.roll, dark: d.dark, yes: d.yes }, null, 2)
      : [
          report(s),
          ...(d.dark
            ? [`dark roll of ${args.version} allowed: ${d.yes!.owner} said yes on ${d.yes!.date}`]
            : d.roll
              ? []
              : [ask(s, args.version, args.darkSeconds)]),
        ].join("\n");
    return { code: d.roll ? 0 : 3, out: text };
  } catch (e) {
    return { code: 2, out: `roll-preflight: ${(e as Error).message}` };
  }
}

if (import.meta.main) {
  const { code, out } = run(process.argv.slice(2));
  console.log(out);
  process.exit(code);
}
