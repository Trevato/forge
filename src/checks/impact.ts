/**
 * The impact map (#1279): for each test file, the `src/**` files it
 * executed, as measured by Bun's coverage in the full run. A pull's diff
 * intersected with it is the set of tests the change can reach.
 *
 * Plain data in, plain data out. `scripts/test-shards.ts` runs the
 * coverage and reads the files; this module parses, formats and decides
 * what the map cannot bound.
 */

export type Impact = ReadonlyMap<string, readonly string[]>;

const TEST = /^test\/[A-Za-z0-9_.-]+\.test\.[cm]?[jt]sx?$/;
const SOURCE = /^src\/[A-Za-z0-9_./-]+$/;

/** The `src/**` files an lcov report shows executed (a line hit at least once). */
export function executedFiles(lcov: string): string[] {
  const found = new Set<string>();
  let file: string | undefined;
  let hit = false;
  const end = (): void => {
    if (file !== undefined && hit && SOURCE.test(file)) found.add(file);
    file = undefined;
    hit = false;
  };
  for (const line of lcov.split("\n")) {
    if (line.startsWith("SF:")) {
      end();
      file = line.slice(3).trim().replace(/^\.\//, "");
    } else if (line.startsWith("DA:")) {
      const count = Number(line.slice(3).split(",")[1]);
      if (count > 0) hit = true;
    } else if (line.startsWith("end_of_record")) end();
  }
  end();
  return [...found].sort();
}

export function parseImpact(
  text: string,
): { ok: true; value: Map<string, string[]> } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "not JSON" };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return { ok: false, error: "not an object of test file to source files" };
  const map = new Map<string, string[]>();
  for (const [test, files] of Object.entries(data)) {
    if (!TEST.test(test)) return { ok: false, error: `${JSON.stringify(test)} is not a test file` };
    if (!Array.isArray(files) || !files.every((f) => typeof f === "string" && SOURCE.test(f)))
      return { ok: false, error: `${test}: not a list of src files` };
    map.set(test, files as string[]);
  }
  return { ok: true, value: map };
}

export function formatImpact(map: ReadonlyMap<string, readonly string[]>): string {
  const entries = [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return "{}\n";
  const lines = entries.map(
    ([test, files]) => `  ${JSON.stringify(test)}: ${JSON.stringify([...files].sort())}`,
  );
  return `{\n${lines.join(",\n")}\n}\n`;
}

/** What the map cannot bound: manifests, scripts, the kernel. */
export function needsFull(changed: readonly string[]): string | undefined {
  return changed.find(
    (f) =>
      f === "forge.json" ||
      f === "package.json" ||
      (f.startsWith("scripts/") && !f.endsWith("test-times.json") && !f.endsWith("test-impact.json")) ||
      f.startsWith("src/kernel/"),
  );
}

export interface Reach {
  /** Tests whose executed files meet the diff, with the first file that did. */
  readonly tests: ReadonlyMap<string, string>;
  /** Changed `src/**` files no mapped test executes. */
  readonly unreached: readonly string[];
}

export function reach(changed: readonly string[], impact: Impact): Reach {
  const tests = new Map<string, string>();
  const hit = new Set<string>();
  const sources = changed.filter((f) => SOURCE.test(f));
  for (const [test, files] of impact) {
    const set = new Set(files);
    const first = sources.find((f) => set.has(f));
    if (first !== undefined) tests.set(test, first);
    for (const f of sources) if (set.has(f)) hit.add(f);
  }
  return { tests, unreached: sources.filter((f) => !hit.has(f)) };
}

/** `3 changed files reach 14 tests; src/web/x.ts reaches none` */
export function reachLine(changed: number, tests: number, unreached: readonly string[]): string {
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
  const head = `${plural(changed, "changed file")} reach${changed === 1 ? "es" : ""} ${plural(tests, "test")}`;
  return unreached.length === 0 ? head : `${head}; ${unreached.join(", ")} reaches none`;
}

/**
 * The map to write: the old one refreshed by what this run measured, and
 * every test that left the gate forgotten.
 */
export function mergeImpact(
  old: ReadonlyMap<string, readonly string[]>,
  measured: ReadonlyMap<string, readonly string[]>,
  gate: readonly string[],
): Map<string, string[]> {
  const merged = new Map<string, string[]>();
  for (const [test, files] of [...old, ...measured])
    if (gate.includes(test)) merged.set(test, [...files]);
  return merged;
}
