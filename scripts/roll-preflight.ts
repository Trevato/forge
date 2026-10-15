/**
 * The roll recipe's first step (`docs/ops/ROLL.md`, #1588): read what
 * `kubectl` printed, answer with `scripts/roll.ts` whether a surge pod can
 * schedule beside the running forge, print that answer, and exit:
 *
 *   0  it fits: the roll is zero-downtime
 *   3  it does not fit: the answer names the headroom it lacks
 *   2  the input is not what kubectl prints
 *
 *   bun scripts/roll-preflight.ts --node node.json --pods pods.json \
 *     --pod forge/forge-7d9c-abcde --steady 3712Mi [--json]
 *
 * It runs nothing and reaches no cluster: the files are the operator's.
 */

import { readFileSync } from "node:fs";
import { parseQuantity, report, surge } from "./roll.ts";

export interface Args {
  readonly node: string;
  readonly pods: string;
  readonly pod: string;
  readonly steady: string;
  readonly json: boolean;
}

const VALUED = ["--node", "--pods", "--pod", "--steady"] as const;

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
    return {
      code: s.fits ? 0 : 3,
      out: args.json ? JSON.stringify(s, null, 2) : report(s),
    };
  } catch (e) {
    return { code: 2, out: `roll-preflight: ${(e as Error).message}` };
  }
}

if (import.meta.main) {
  const { code, out } = run(process.argv.slice(2));
  console.log(out);
  process.exit(code);
}
