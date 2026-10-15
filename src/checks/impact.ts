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

/**
 * The `src/**` files an lcov report shows executed: a function of theirs
 * was called (`FNH` > 0), or, for a file with no functions at all (`FNF`
 * 0: constants, tables), a line was hit. A line hit alone is not enough
 * where there are functions: loading a module runs its top level, so by
 * lines every file a test imports, however deep, would count — the import
 * graph again, which is what the map is for beating (#1794).
 */
export function executedFiles(lcov: string): string[] {
  const found = new Set<string>();
  let file: string | undefined;
  let lineHit = false;
  let functions: number | undefined;
  let called = 0;
  const end = (): void => {
    const executed = functions === undefined || functions === 0 ? lineHit : called > 0;
    if (file !== undefined && executed && SOURCE.test(file)) found.add(file);
    file = undefined;
    lineHit = false;
    functions = undefined;
    called = 0;
  };
  for (const line of lcov.split("\n")) {
    if (line.startsWith("SF:")) {
      end();
      file = line.slice(3).trim().replace(/^\.\//, "");
    } else if (line.startsWith("DA:")) {
      if (Number(line.slice(3).split(",")[1]) > 0) lineHit = true;
    } else if (line.startsWith("FNF:")) functions = Number(line.slice(4)) || 0;
    else if (line.startsWith("FNH:")) called = Number(line.slice(4)) || 0;
    else if (line.startsWith("end_of_record")) end();
  }
  end();
  return [...found].sort();
}

/**
 * The map's file as `FORGE_CHECK_IMPACT` names it: a plain file name in the
 * checkout the forge seeds and takes back (`impact-store.ts`). Anything
 * else — a path, a climb — is not the forge's and is ignored.
 */
export function handedImpact(name: string | undefined): string | undefined {
  return name !== undefined && /^(?!\.\.?$)[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}$/.test(name) ? name : undefined;
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
