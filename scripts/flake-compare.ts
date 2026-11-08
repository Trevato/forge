/**
 * One night of the flake hunt and the outside gate, the forge's run beside
 * the Forgejo job's (#9045). Both sides run `scripts/flake-hunt.ts`, so
 * both logs carry the same lines; this reads what each filed out of them
 * and names where they differ.
 *
 *   bun scripts/flake-compare.ts --forge a.log [--forge b.log]
 *                                --forgejo c.log [--forgejo d.log]
 *
 * Each log is a run's whole output (the forge's `/resilience/nightly/<job>`,
 * a Forgejo Actions step log); give each side its hunt and its outside run,
 * in any order. A Forgejo slice log may be passed once per slice. Prints
 * both sides and the differences; exits 1 when there are any.
 *
 * They agree when the outside run sees the same files red and green, the
 * `Red:` issues move the same way (one side finding the other's already
 * open is agreement: it says nothing), and the same files are flaky,
 * broken and quarantined. Plain text in, plain data out.
 */

import { readFileSync } from "node:fs";

export type RedAction = { kind: "filed" | "updated" | "closed"; issue: number };

export type Night = {
  /** Outside the gate: file → red or green. */
  outside: Map<string, "red" | "green">;
  /** `Red:` issues the outside run opened, updated or closed: file → action. */
  red: Map<string, RedAction>;
  /** Hunt: file → the `Flaky:` issue filed or found open (null: not filed). */
  flaky: Map<string, number | null>;
  broken: Set<string>;
  /** Quarantine: file → the issue it was moved under. */
  quarantined: Map<string, number>;
  /** The quarantine pull's branch, when the log names one. */
  pull: string | null;
};

const TEST = String.raw`(test/[\w./-]+\.test\.ts)`;
const OUTSIDE = new RegExp(String.raw`(?:^|\s)(red  |green): ${TEST}\s*$`);
const RED = new RegExp(String.raw`(?:^|\s)(filed|updated|closed) #(\d+) for ${TEST}`);
const FLAKY = new RegExp(String.raw`(?:^|\s)FLAKY ${TEST}:`);
const FILED = /(?:^|\s)(?:filed|already open as) #(\d+)\s*$/;
const BROKEN = new RegExp(String.raw`red in every run \(broken, not flaky\): ${TEST}`);
const QUARANTINED = new RegExp(String.raw`(?:^|\s)quarantined ${TEST} \(#(\d+)\)`);
const PULL = /flake-hunt\/\d{4}-\d{2}-\d{2}/;

/** What one side's logs say it did. */
export function readNight(logs: string[]): Night {
  const night: Night = {
    outside: new Map(),
    red: new Map(),
    flaky: new Map(),
    broken: new Set(),
    quarantined: new Map(),
    pull: null,
  };
  for (const log of logs) {
    let lastFlaky: string | null = null;
    for (const line of log.split("\n")) {
      let m: RegExpExecArray | null;
      if ((m = OUTSIDE.exec(line))) night.outside.set(m[2]!, m[1] === "green" ? "green" : "red");
      else if ((m = RED.exec(line)))
        night.red.set(m[3]!, { kind: m[1] as RedAction["kind"], issue: Number(m[2]) });
      else if ((m = FLAKY.exec(line))) {
        lastFlaky = m[1]!;
        if (!night.flaky.has(lastFlaky)) night.flaky.set(lastFlaky, null);
      } else if ((m = FILED.exec(line)) && lastFlaky) night.flaky.set(lastFlaky, Number(m[1]));
      else if ((m = BROKEN.exec(line))) night.broken.add(m[1]!);
      else if ((m = QUARANTINED.exec(line))) night.quarantined.set(m[1]!, Number(m[2]));
      if ((m = PULL.exec(line))) night.pull = m[0];
    }
  }
  return night;
}

const issue = (n: number | null) => (n === null ? "not filed" : `#${n}`);

/** Every way the two nights disagree, one line each; empty when they agree. */
export function compareNights(forge: Night, forgejo: Night): string[] {
  const out: string[] = [];
  const sides = [
    ["forge", forge],
    ["forgejo", forgejo],
  ] as const;
  const union = <T>(a: Iterable<T>, b: Iterable<T>) => [...new Set([...a, ...b])].sort();

  for (const file of union(forge.outside.keys(), forgejo.outside.keys())) {
    const a = forge.outside.get(file);
    const b = forgejo.outside.get(file);
    if (a === b) continue;
    out.push(`outside ${file}: ${a ?? "not run"} on forge, ${b ?? "not run"} on forgejo`);
  }
  for (const file of union(forge.red.keys(), forgejo.red.keys())) {
    const a = forge.red.get(file);
    const b = forgejo.red.get(file);
    // One side acting and the other silent is the dedupe at work, unless the
    // outside runs already disagree on the file (named above).
    if (!a || !b || a.kind === b.kind) continue;
    out.push(`Red: ${file}: forge ${a.kind} #${a.issue}, forgejo ${b.kind} #${b.issue}`);
  }
  for (const file of union(forge.flaky.keys(), forgejo.flaky.keys())) {
    for (const [name, night] of sides) {
      const other = night === forge ? forgejo : forge;
      if (night.flaky.has(file) && !other.flaky.has(file))
        out.push(`Flaky: ${file}: only ${name} found it (${issue(night.flaky.get(file)!)})`);
    }
  }
  for (const file of union(forge.broken, forgejo.broken)) {
    if (forge.broken.has(file) !== forgejo.broken.has(file))
      out.push(`broken ${file}: only ${forge.broken.has(file) ? "forge" : "forgejo"} found it`);
  }
  for (const file of union(forge.quarantined.keys(), forgejo.quarantined.keys())) {
    if (forge.quarantined.has(file) !== forgejo.quarantined.has(file))
      out.push(`quarantined ${file}: only ${forge.quarantined.has(file) ? "forge" : "forgejo"} moved it`);
  }
  if ((forge.pull === null) !== (forgejo.pull === null))
    out.push(`quarantine pull: only ${forge.pull ? "forge" : "forgejo"} proposed one`);
  return out;
}

/** One side, as lines a person reads. */
export function describeNight(name: string, night: Night): string[] {
  const reds = [...night.outside].filter(([, s]) => s === "red").map(([f]) => f);
  const lines = [`${name}: outside ${night.outside.size} files, ${reds.length} red`];
  for (const [file, a] of night.red) lines.push(`  Red: ${a.kind} #${a.issue} for ${file}`);
  for (const [file, n] of night.flaky) lines.push(`  Flaky: ${file} (${issue(n)})`);
  for (const file of night.broken) lines.push(`  broken: ${file}`);
  for (const [file, n] of night.quarantined) lines.push(`  quarantined ${file} (#${n})`);
  lines.push(`  quarantine pull: ${night.pull ?? "none"}`);
  return lines;
}

/** The whole report and whether the two sides agree. */
export function report(forge: Night, forgejo: Night): { text: string; agree: boolean } {
  const diffs = compareNights(forge, forgejo);
  const lines = [...describeNight("forge", forge), ...describeNight("forgejo", forgejo), ""];
  if (diffs.length === 0) lines.push("no differences");
  else lines.push(`${diffs.length} differences:`, ...diffs.map((d) => `  ${d}`));
  return { text: lines.join("\n"), agree: diffs.length === 0 };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const paths: Record<"--forge" | "--forgejo", string[]> = { "--forge": [], "--forgejo": [] };
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const path = args[i + 1];
    if ((flag !== "--forge" && flag !== "--forgejo") || !path) {
      console.error("usage: bun scripts/flake-compare.ts --forge <log>... --forgejo <log>...");
      process.exit(2);
    }
    paths[flag].push(path);
  }
  if (paths["--forge"].length === 0 || paths["--forgejo"].length === 0) {
    console.error("give at least one log for each side: --forge <log> --forgejo <log>");
    process.exit(2);
  }
  const read = (list: string[]) => readNight(list.map((p) => readFileSync(p, "utf8")));
  const { text, agree } = report(read(paths["--forge"]), read(paths["--forgejo"]));
  console.log(text);
  process.exit(agree ? 0 : 1);
}
