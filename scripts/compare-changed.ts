/**
 * Replays the last merged pulls and compares what the fast tier picked with
 * what `bun test --changed=<parent>` picks (#2056).
 *
 *   FORGE_URL=… FORGE_TOKEN=… bun scripts/compare-changed.ts [--pulls 50] [--dir <scratch>] [--map <impact map>]
 *
 * For each merged pull: its squash commit against the parent; the fast tier's
 * pick (`fastSet`, with the impact map given by --map: the day's map is not
 * kept, so this is today's map on that day's diff); the `--changed` pick at
 * that commit, from a detached worktree; and the test files red in the
 * pull's check logs.
 * Prints a markdown table and the verdict. Logs are cached in --dir.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { junitFiles, redFiles, runsAll, verdict, missed, type Row } from "../src/checks/changed_compare.ts";
import { GATE_FILE, gateListAdds, parseImpact } from "../src/checks/impact.ts";
import { fastSet, importsOf } from "../src/checks/tiers.ts";
import { treeGate } from "./gate.ts";

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1]! : fallback;
};
const count = Number(flag("--pulls", "50"));
const dir = flag("--dir", join(process.env.TMPDIR ?? tmpdir(), "compare-changed"));
const base = `${process.env.FORGE_URL}/api/v1/repos/trevato/forge`;
const headers = { authorization: `Bearer ${process.env.FORGE_TOKEN}` };
const root = process.cwd();
mkdirSync(join(dir, "logs"), { recursive: true });

async function get(path: string): Promise<any> {
  return (await fetch(`${base}${path}`, { headers })).json();
}

async function page(path: string, keep: (item: any) => boolean, want: number): Promise<any[]> {
  const out: any[] = [];
  let cursor = "";
  for (let i = 0; i < 60 && out.length < want; i++) {
    const j = await get(`${path}&limit=100${cursor ? `&cursor=${cursor}` : ""}`);
    out.push(...j.items.filter(keep));
    if (!j.next_cursor) break;
    cursor = j.next_cursor;
  }
  return out.slice(0, want);
}

const git = (...args: string[]): string => {
  const r = Bun.spawnSync(["git", ...args], { cwd: root, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
};

async function logOf(id: string): Promise<string> {
  const file = join(dir, "logs", `${id}.txt`);
  if (existsSync(file)) return readFileSync(file, "utf8");
  const text = await (await fetch(`${base}/runs/${id}/log`, { headers })).text();
  writeFileSync(file, text);
  return text;
}

const pulls = await page("/pulls?state=closed", (p) => p.mergedAt && p.mergedOid, count);
const oldest = pulls.at(-1)!.createdAt as string;
const runs: any[] = [];
for (let cursor = ""; ; ) {
  const j = await get(`/runs?kind=check&limit=100${cursor ? `&cursor=${cursor}` : ""}`);
  runs.push(...j.items);
  if (!j.next_cursor || j.items.at(-1).createdAt < oldest) break;
  cursor = j.next_cursor;
}

const tree = join(dir, "tree");
// The map is handed by the forge, not kept in the repository: without --map the fast tier guesses by imports.
const mapFile = flag("--map", "");
const impact = mapFile === "" ? undefined : parseImpact(readFileSync(mapFile, "utf8"));
if (impact !== undefined && !impact.ok) throw new Error(`--map: ${impact.error}`);
const needle = "NO-TEST-IS-NAMED-THIS";
const rows: Row[] = [];
const notes: string[] = [];
for (const pull of pulls) {
  const oid: string = pull.mergedOid;
  let parent: string;
  try {
    parent = git("rev-parse", `${oid}^`).trim();
  } catch {
    notes.push(`#${pull.number}: ${oid.slice(0, 8)} is not in this clone`);
    continue;
  }
  const changed = git("diff", "--name-only", "--no-renames", parent, oid).split("\n").filter(Boolean);
  // This pull's checks, newest first: on its branch, and the land gate on its squash commit.
  const mine = runs
    .filter(
      (r) =>
        (r.env === `pull-${pull.number}` || (r.env === "main" && r.commitOid === oid)) &&
        (r.state === "ok" || r.state === "failed"),
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const reds = new Set<string>();
  for (const r of mine.filter((r) => r.state === "failed")) for (const f of redFiles(await logOf(r.id))) reds.add(f);
  if (changed.length === 0) {
    notes.push(`#${pull.number}: ${oid.slice(0, 8)} changes nothing against its parent (the work landed in an earlier commit); left out`);
    continue;
  }
  if (!existsSync(tree)) git("worktree", "add", "--detach", "-f", tree, oid);
  else Bun.spawnSync(["git", "-C", tree, "checkout", "--detach", "--force", oid]);
  if (!existsSync(join(tree, "node_modules"))) symlinkSync(join(root, "node_modules"), join(tree, "node_modules"));
  const gate = new Set<string>(await treeGate(tree, oid));
  const cache = new Map<string, string[]>();
  const imports = (file: string): string[] => {
    let found = cache.get(file);
    if (found === undefined) {
      try {
        found = importsOf(readFileSync(join(tree, file), "utf8"), file).flatMap((path) =>
          /\.[cm]?[jt]sx?$/.test(path) ? [path] : [path, `${path}.ts`],
        );
      } catch {
        found = [];
      }
      cache.set(file, found);
    }
    return found;
  };
  let gateAdds: string[] | undefined;
  if (changed.includes(GATE_FILE)) gateAdds = gateListAdds(git("diff", "-U0", "--no-renames", parent, oid, "--", GATE_FILE));
  let times = new Map<string, number>();
  try {
    times = new Map(Object.entries(JSON.parse(readFileSync(join(tree, "scripts/test-times.json"), "utf8")) as Record<string, number>));
  } catch {
    // no times: a test is not known to be quick
  }
  const plan = fastSet({
    changed,
    tests: [...gate],
    imports,
    times,
    ...(gateAdds === undefined ? {} : { gateAdds }),
    ...(impact?.ok ? { impact: impact.value } : {}),
  });
  const fast = plan.files;
  const report = join(dir, "junit.xml");
  rmSync(report, { force: true });
  Bun.spawnSync(
    ["bun", "test", `--changed=${parent}`, "-t", needle, "--reporter=junit", `--reporter-outfile=${report}`],
    { cwd: tree, stdout: "ignore", stderr: "ignore", env: { ...process.env, FORGE_TEST_SOCKET: "port" } },
  );
  const imported = existsSync(report) ? junitFiles(readFileSync(report, "utf8")).filter((f) => gate.has(f)) : [];
  // Non-import triggers (fixtures, forge.json, scripts/, bun.lock) run all.
  const bun = changed.some(runsAll) ? [...gate] : imported;
  rows.push({ pull: pull.number, changed: changed.length, fast, bun, reds: [...reds].sort() });
}
Bun.spawnSync(["git", "worktree", "remove", "--force", tree], { cwd: root });

console.log("| pull | changed | fast set | --changed set | reds | fast missed | --changed missed |");
console.log("|---|---|---|---|---|---|---|");
for (const r of rows) {
  const f = r.fast === undefined ? undefined : missed(r.reds, new Set(r.fast));
  const b = missed(r.reds, new Set(r.bun));
  console.log(
    `| #${r.pull} | ${r.changed} | ${r.fast?.length ?? "n/a"} | ${r.bun.length} | ${r.reds.length} | ${f === undefined ? "n/a" : f.length ? f.join(", ") : 0} | ${b.length ? b.join(", ") : 0} |`,
  );
}
const v = verdict(rows);
console.log(`\n${JSON.stringify(v)}`);
for (const n of notes) console.log(n);
