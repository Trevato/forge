/**
 * A landing simulator: deterministic simulation testing for how the forge
 * lands pulls (the method FoundationDB, TigerBeetle and Turso test with).
 *
 * A seed makes a small repository and several pulls (in-repo, from a fork,
 * stacked, force-pushed, containing main) and a random interleaving of "main
 * moved", "check finished", "approved", "refreshed" and "landed", then drives
 * the REAL code paths (`mergePull`, the merge queue's `sweepGreen`, `combine`,
 * `recombine`, `refreshPullHead`) against a real bare repository and a real
 * database. Only the crew and the check are stubs: the check is a function of
 * a tree, the gate is the same function. After every step the invariants run
 * (each a named function, failing with the seed and a readable script), and a
 * shrinker cuts a failing scenario down to the pulls and edits that matter.
 *
 * Lines are the unit of loss: every generated line carries a unique token
 * (`~<tag>`), so "this reviewed line is in main" is a set test.
 *
 * The scenario is plain data (`Scenario`): rerun it, print it, shrink it.
 * `bun test/support/landsim.ts --seeds 200` runs the corpus and prints the
 * violation classes with one minimal reproducer each.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../../src/app.ts";
import {
  addTeamMember,
  createOrg,
  createTeam,
} from "../../src/actions/orgs.ts";
import { mergePull, openPull, submitReview } from "../../src/actions/pulls.ts";
import {
  commitToBranch,
  createRepo,
  forkRepo,
} from "../../src/actions/repos.ts";
import {
  checkSummary,
  claimRun,
  createRun,
  finishRun,
  setRunBase,
  setRunCombined,
} from "../../src/core/runs.ts";
import { commitIdentity } from "../../src/core/commit_identity.ts";
import { getPull, pullStatus, type Pull } from "../../src/core/pulls.ts";
import { recombine } from "../../src/core/recombine.ts";
import { refreshPullHead } from "../../src/core/following.ts";
import { getRepoById, type Repo } from "../../src/core/repos.ts";
import { reviewSummary } from "../../src/core/reviews.ts";
import { getOrg } from "../../src/core/orgs.ts";
import type { User } from "../../src/core/users.ts";
import { nextOfPull } from "../../src/flow/next_actor.ts";
import { bringUpToDate, sweepGreen } from "../../src/crew/autonomy.ts";
import {
  provideChecksForTest,
  type ChecksHandle,
} from "../../src/checks/service.ts";
import { readCombined } from "../../src/git/combined.ts";
import { runGitCapture } from "../../src/git/env.ts";
import { mergeable } from "../../src/git/merge.ts";
import { repoDir } from "../../src/git/repos.ts";
import type { FileWrite } from "../../src/git/write.ts";
import { int, pick, rng, type Rand } from "../helpers/fuzz.ts";
import { promote } from "../helpers/members.ts";
import { signUpProven } from "../helpers/verified.ts";

// ---------------------------------------------------------------------------
// The scenario: plain data

export type Who = "dave" | "carol" | "erin";

/** One change to the files, resolved against whatever the branch holds when it runs. */
export type Edit =
  | { k: "append"; file: string; tag: string; n: number }
  | { k: "list"; file: string; tag: string; n: number }
  | { k: "anchor"; file: string; tag: string; n: number; at: number }
  | { k: "line"; file: string; tag: string; at: number }
  | { k: "hunks"; file: string; tag: string }
  | { k: "space"; file: string; at: number }
  | { k: "rename"; file: string; to: string }
  | { k: "delete"; file: string }
  | { k: "addfile"; file: string; tag: string; n: number }
  | { k: "mode"; file: string };

export interface PullSpec {
  id: number;
  who: Who;
  /** Opened from the author's fork (erin always is). */
  fork: boolean;
  edits: Edit[];
  /** Branches from the main tip that existed after this many main moves (0 = the seed). */
  point: number;
  /** Branches from another pull's head (same repository only). */
  stackedOn?: number;
}

export type Step =
  | { op: "open"; p: number }
  | { op: "main"; edits: Edit[] }
  | { op: "check"; p: number }
  | { op: "approve"; p: number }
  | { op: "contain"; p: number }
  | { op: "refresh"; p: number; edits: Edit[]; force: boolean; rebase: boolean }
  | { op: "land"; p: number; how: "merge" | "squash" }
  | { op: "sweep"; during?: Step }
  | { op: "hook" }
  | { op: "settle" };

export interface Scenario {
  seed: number;
  files: Record<string, string>;
  pulls: PullSpec[];
  steps: Step[];
}

// ---------------------------------------------------------------------------
// Generation

/** The file a line belongs to decides its shape; the `~token` is what makes it unique. */
const lineOf = (file: string, tag: string): string => {
  if (file.endsWith(".md")) return `- item ${tag.replace(/^/, "~")}`;
  if (file.endsWith(".json"))
    return `  "k${tag.replace(/\W/g, "_")}": "~${tag}",`;
  if (file.endsWith(".lock"))
    return `pkg-${tag.replace(/\W/g, "_")}@1.0.0 ~${tag}`;
  if (file.includes(".test."))
    return `test("${tag}", () => expect(1).toBe(1)); // ~${tag}`;
  return `export const v_${tag.replace(/\W/g, "_")} = 1; // ~${tag}`;
};

function seedFiles(r: Rand): Record<string, string> {
  const names = [
    "src/core.ts",
    "src/util.ts",
    "test/core.test.ts",
    "README.md",
    "config.json",
    "bun.lock",
    "deps.lock",
    "docs/guide.md",
    "src/extra.ts",
    "src/more.ts",
    "test/util.test.ts",
    "docs/notes.md",
    "package.json",
  ];
  const count = 5 + int(r, 8);
  const chosen = new Set<string>([
    "src/core.ts",
    "test/core.test.ts",
    "README.md",
    "config.json",
    "deps.lock",
  ]);
  for (const n of names) if (chosen.size < count) chosen.add(n);
  const files: Record<string, string> = {};
  for (const [fi, f] of [...chosen].entries()) {
    const rows = 6 + int(r, 10);
    const lines: string[] = [];
    if (f.endsWith(".md")) {
      lines.push(`# ${f} ~r${fi}.h`);
      for (let i = 0; i < rows; i++) lines.push(`- item ~r${fi}.${i}`);
      lines.push("", `Prose that follows the list. ~r${fi}.p`);
    } else {
      for (let i = 0; i < rows; i++) lines.push(lineOf(f, `r${fi}.${i}`));
    }
    files[f] = `${lines.join("\n")}\n`;
  }
  return files;
}

function genEdit(
  r: Rand,
  files: readonly string[],
  tag: string,
  hot: readonly string[],
): Edit {
  const file = r() < 0.7 ? pick(r, hot) : pick(r, files);
  const roll = r();
  const n = 1 + int(r, 2);
  if (roll < 0.22) return { k: "append", file, tag, n };
  if (roll < 0.36)
    return {
      k: "list",
      file: files.find((f) => f.endsWith(".md")) ?? file,
      tag,
      n,
    };
  if (roll < 0.5) return { k: "anchor", file, tag, n, at: int(r, 20) };
  if (roll < 0.62) return { k: "line", file, tag, at: int(r, 20) };
  if (roll < 0.7) return { k: "hunks", file, tag };
  if (roll < 0.76)
    return {
      k: "rename",
      file,
      to: `${file.replace(/\.(\w+)$/, "")}-moved${tag.replace(/\W/g, "")}.${file.split(".").pop()}`,
    };
  if (roll < 0.8) return { k: "delete", file };
  if (roll < 0.87)
    return { k: "addfile", file: `src/new-${int(r, 2)}.ts`, tag, n };
  if (roll < 0.91) return { k: "mode", file };
  return { k: "space", file, at: int(r, 20) };
}

/** A scenario from one number: the same seed is always the same scenario. */
export function generate(seed: number): Scenario {
  const r = rng(seed);
  const files = seedFiles(r);
  const names = Object.keys(files);
  const hot = [
    pick(r, names),
    pick(r, names),
    "README.md",
    "test/core.test.ts",
  ].filter((f) => f in files);
  const nPulls = 2 + int(r, 4);
  const pulls: PullSpec[] = [];
  const steps: Step[] = [];
  let mains = 0;
  const queues: Step[][] = [];
  for (let id = 1; id <= nPulls; id++) {
    const fork = r() < 0.4;
    const who: Who = fork ? "erin" : r() < 0.5 ? "dave" : "carol";
    const edits: Edit[] = [];
    for (let e = 0, n = 1 + int(r, 3); e < n; e++)
      edits.push(genEdit(r, names, `p${id}e${e}`, hot));
    const spec: PullSpec = { id, who, fork, edits, point: 0 };
    const earlier = pulls.filter((p) => !p.fork && p.who !== "erin");
    if (!fork && earlier.length > 0 && r() < 0.15)
      spec.stackedOn = pick(r, earlier).id;
    pulls.push(spec);
    const q: Step[] = [{ op: "open", p: id }];
    if (r() < 0.12) q.push({ op: "contain", p: id });
    const first = r() < 0.5;
    q.push(first ? { op: "check", p: id } : { op: "approve", p: id });
    q.push(first ? { op: "approve", p: id } : { op: "check", p: id });
    if (r() < 0.18) {
      const again: Edit[] = [genEdit(r, names, `p${id}f`, hot)];
      q.push({
        op: "refresh",
        p: id,
        edits: again,
        force: r() < 0.6,
        rebase: r() < 0.4,
      });
      q.push({ op: "check", p: id }, { op: "approve", p: id });
    }
    if (r() < 0.8) {
      q.push({ op: "land", p: id, how: r() < 0.5 ? "squash" : "merge" });
      if (r() < 0.4) q.push({ op: "hook" });
    }
    queues.push(q);
  }
  // Pulls are opened against the main tip that existed after `point` main moves.
  const mainSteps: Step[] = [];
  for (let m = 0, n = int(r, 3); m < n; m++)
    mainSteps.push({
      op: "main",
      edits: [
        genEdit(r, names, `m${m}`, hot),
        ...(r() < 0.3 ? [genEdit(r, names, `m${m}b`, hot)] : []),
      ],
    });
  // A random interleaving that keeps each pull's own order.
  const live = queues.map((q) => [...q]);
  const pool: Step[][] = [...live];
  while (pool.some((q) => q.length > 0)) {
    const open = pool.filter((q) => q.length > 0);
    if (mainSteps.length > 0 && r() < 0.18) {
      steps.push(mainSteps.shift()!);
      mains++;
      continue;
    }
    if (r() < 0.12) {
      const during: Step | undefined =
        r() < 0.3 && mainSteps.length > 0 ? mainSteps.shift() : undefined;
      steps.push(
        during === undefined ? { op: "sweep" } : { op: "sweep", during },
      );
      if (during !== undefined) mains++;
      continue;
    }
    const q = pick(r, open);
    const step = q.shift()!;
    if (step.op === "open") {
      const spec = pulls.find((p) => p.id === step.p)!;
      spec.point = int(r, mains + 1);
    }
    steps.push(step);
  }
  for (const m of mainSteps) steps.push(m);
  steps.push({ op: "settle" });
  return { seed, files, pulls, steps };
}

// ---------------------------------------------------------------------------
// Printing: a scenario as a script a person can read

const editWords = (e: Edit): string => {
  switch (e.k) {
    case "append":
    case "list":
      return `${e.k} ${e.n} line(s) at the end of ${e.file} [${e.tag}]`;
    case "anchor":
      return `insert ${e.n} line(s) after line ${e.at} of ${e.file} [${e.tag}]`;
    case "line":
      return `rewrite line ${e.at} of ${e.file} [${e.tag}]`;
    case "hunks":
      return `edit two far-apart lines of ${e.file} [${e.tag}]`;
    case "space":
      return `whitespace-only change to line ${e.at} of ${e.file}`;
    case "rename":
      return `rename ${e.file} -> ${e.to}`;
    case "delete":
      return `delete ${e.file}`;
    case "addfile":
      return `add ${e.file} with ${e.n} line(s) [${e.tag}]`;
    case "mode":
      return `chmod +x ${e.file}`;
  }
};

const stepWords = (s: Step, pulls: readonly PullSpec[]): string => {
  switch (s.op) {
    case "open":
      return `open #${s.p}`;
    case "main":
      return `main moves: ${s.edits.map(editWords).join("; ")}`;
    case "check":
      return `check finishes on #${s.p}`;
    case "approve":
      return `approve #${s.p}`;
    case "contain":
      return `#${s.p} merges main into its branch`;
    case "refresh":
      return `#${s.p} ${s.force ? "is force-pushed" : "is pushed to"}${s.rebase ? " (rebased on main)" : ""}: ${s.edits.map(editWords).join("; ")}`;
    case "land":
      return `a person lands #${s.p} (${s.how})`;
    case "sweep":
      return `the merge queue sweeps${s.during === undefined ? "" : `, and while it gates: ${stepWords(s.during, pulls)}`}`;
    case "hook":
      return "a push to main reaches the post-receive hook (kept-fork pulls are combined again)";
    case "settle":
      return "settle: every open pull is checked, approved and landed if the forge lets it";
  }
};

/** The scenario as a readable script. */
export function script(sc: Scenario): string {
  const out = [
    `seed ${sc.seed}: ${Object.keys(sc.files).length} files (${Object.keys(sc.files).join(", ")})`,
  ];
  for (const p of sc.pulls) {
    const where = p.fork ? "from erin's fork" : `in-repo by ${p.who}`;
    out.push(
      `  pull #${p.id} ${where}, branched at main move ${p.point}${p.stackedOn === undefined ? "" : `, stacked on #${p.stackedOn}`}: ${p.edits.map(editWords).join("; ")}`,
    );
  }
  for (const [i, s] of sc.steps.entries())
    out.push(`  ${String(i + 1).padStart(2)}. ${stepWords(s, sc.pulls)}`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Files and edits

interface Entry {
  content: string;
  mode: "100644" | "100755";
}
type Tree = Map<string, Entry>;

const split = (content: string): string[] => {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};
const join2 = (lines: readonly string[]): string => `${lines.join("\n")}\n`;

/** The edits, applied to a copy of the tree: what to write (null deletes). */
export function applyEdits(base: Tree, edits: readonly Edit[]): FileWrite[] {
  const cur: Tree = new Map([...base].map(([k, v]) => [k, { ...v }]));
  const touched = new Set<string>();
  for (const e of edits) {
    const f = cur.get(e.file);
    if (e.k === "addfile") {
      if (cur.has(e.file)) continue;
      const lines = Array.from({ length: e.n }, (_, i) =>
        lineOf(e.file, `${e.tag}.${i}`),
      );
      cur.set(e.file, { content: join2(lines), mode: "100644" });
      touched.add(e.file);
      continue;
    }
    if (f === undefined) continue;
    const lines = split(f.content);
    switch (e.k) {
      case "append":
        for (let i = 0; i < e.n; i++)
          lines.push(lineOf(e.file, `${e.tag}.${i}`));
        break;
      case "list": {
        const last = lines.findLastIndex((l) => l.startsWith("- "));
        const at = last === -1 ? lines.length : last + 1;
        lines.splice(
          at,
          0,
          ...Array.from({ length: e.n }, (_, i) =>
            lineOf(e.file, `${e.tag}.${i}`),
          ),
        );
        break;
      }
      case "anchor":
        lines.splice(
          (e.at % Math.max(1, lines.length)) + 1,
          0,
          ...Array.from({ length: e.n }, (_, i) =>
            lineOf(e.file, `${e.tag}.${i}`),
          ),
        );
        break;
      case "line":
        if (lines.length > 0)
          lines[e.at % lines.length] = lineOf(e.file, e.tag);
        break;
      case "hunks":
        if (lines.length >= 6) {
          lines[Math.floor(lines.length * 0.15)] = lineOf(e.file, `${e.tag}.a`);
          lines[Math.floor(lines.length * 0.85)] = lineOf(e.file, `${e.tag}.b`);
        }
        break;
      case "space":
        if (lines.length > 0)
          lines[e.at % lines.length] =
            `${lines[e.at % lines.length]!.trimEnd()}  `;
        break;
      case "rename":
        if (cur.has(e.to)) continue;
        cur.delete(e.file);
        cur.set(e.to, f);
        touched.add(e.file);
        touched.add(e.to);
        continue;
      case "delete":
        cur.delete(e.file);
        touched.add(e.file);
        continue;
      case "mode":
        f.mode = "100755";
        touched.add(e.file);
        continue;
    }
    f.content = join2(lines);
    touched.add(e.file);
  }
  const writes: FileWrite[] = [];
  for (const path of touched) {
    const now = cur.get(path);
    if (now === undefined) {
      if (base.has(path)) writes.push({ path, content: null });
    } else if (
      base.get(path)?.content !== now.content ||
      base.get(path)?.mode !== now.mode
    )
      writes.push({ path, content: now.content, mode: now.mode });
  }
  return writes;
}

// ---------------------------------------------------------------------------
// Git reading (the harness's own eyes: never the code under test)

async function git(
  dir: string,
  args: string[],
  stdin?: string,
): Promise<{ code: number; out: string; err: string }> {
  const r = await runGitCapture(args, {
    cwd: dir,
    timeoutMs: 60_000,
    ...(stdin === undefined ? {} : { stdin }),
  });
  return { code: r.code, out: r.stdout, err: r.stderr };
}

async function readTree(dir: string, rev: string): Promise<Tree> {
  const ls = await git(dir, ["ls-tree", "-r", "-z", rev]);
  const entries: { mode: string; oid: string; path: string }[] = [];
  for (const rec of ls.out.split("\0")) {
    const m = /^(\d+) blob ([0-9a-f]+)\t(.*)$/s.exec(rec);
    if (m !== null) entries.push({ mode: m[1]!, oid: m[2]!, path: m[3]! });
  }
  const tree: Tree = new Map();
  if (entries.length === 0) return tree;
  const blobs = await git(
    dir,
    ["cat-file", "--batch"],
    `${entries.map((e) => e.oid).join("\n")}\n`,
  );
  let at = 0;
  const text = blobs.out;
  for (const e of entries) {
    const nl = text.indexOf("\n", at);
    const size = Number(
      /^[0-9a-f]+ blob (\d+)/.exec(text.slice(at, nl))?.[1] ?? 0,
    );
    tree.set(e.path, {
      content: text.slice(nl + 1, nl + 1 + size),
      mode: e.mode === "100755" ? "100755" : "100644",
    });
    at = nl + 1 + size + 1;
  }
  return tree;
}

/** Every tracked line (one holding a `~token`) in a tree: the set a loss is measured in. */
async function trackedLines(dir: string, rev: string): Promise<Set<string>> {
  const r = await git(dir, [
    "grep",
    "-I",
    "-h",
    "--no-color",
    "-F",
    "~",
    rev,
    "--",
  ]);
  const out = new Set<string>();
  if (r.code > 1) return out;
  for (const l of r.out.split("\n")) if (l.includes("~")) out.add(l);
  return out;
}

const hasMarkers = async (dir: string, rev: string): Promise<boolean> =>
  (await git(dir, ["grep", "-I", "-q", "-E", "^(<<<<<<<|>>>>>>>) ", rev, "--"]))
    .code === 0;

// ---------------------------------------------------------------------------
// Violations and the invariants

export interface Violation {
  /** The invariant that failed: the name of the function that checks it. */
  invariant: string;
  /** The invariant and, when known, the cause: what violations are counted by. */
  cls: string;
  step: number;
  pull?: number;
  message: string;
}

/** What is known about one landing, read after it happened. */
export interface Landing {
  pull: number;
  origin: "repo" | "fork";
  /** The pull's author as the forge names them in a commit. */
  author: { name: string; email: string };
  how: "merge" | "squash" | "queue" | "unknown";
  base: string;
  head: string;
  mergeBase: string;
  landed: string;
  baseTree: string;
  landedTree: string;
  before: ReadonlySet<string>;
  after: ReadonlySet<string>;
  added: readonly string[];
  removed: readonly string[];
  /** The commits the landing put on main: newest first. */
  commits: readonly {
    oid: string;
    name: string;
    email: string;
    body: string;
    parents: number;
  }[];
  /** Trees that were checked for this pull (its own check, the queue's gate). */
  checkedTrees: ReadonlySet<string>;
  approvedAtHead: boolean;
  greenAtHead: boolean;
  /** Mode changes the pull asked for that main did not already have. */
  modesLost: readonly string[];
}

const short = (s: string): string =>
  s.length > 90 ? `${s.slice(0, 87)}...` : s;
const list = (xs: readonly string[]): string =>
  xs
    .slice(0, 4)
    .map((x) => `\`${short(x)}\``)
    .join(", ") + (xs.length > 4 ? ` (+${xs.length - 4})` : "");

const keptTrailers = (l: Landing): string[] =>
  l.commits.flatMap((c) =>
    c.body.split("\n").filter((line) => line.startsWith("Combined-Kept: ")),
  );

/** Reviewed = landed: every line the pull added at its reviewed head is in main right after it lands, every line it removed is gone. */
export function reviewedIsLanded(l: Landing): Omit<Violation, "step">[] {
  const out: Omit<Violation, "step">[] = [];
  const dropped = l.added.filter((x) => !l.after.has(x));
  const kept = keptTrailers(l);
  if (dropped.length > 0)
    out.push({
      invariant: "reviewedIsLanded",
      cls:
        kept.length > 0
          ? "reviewedIsLanded/dropped-by-combine"
          : `reviewedIsLanded/dropped-${l.origin}-${l.how}`,
      pull: l.pull,
      message: `#${l.pull} landed without ${dropped.length} line(s) it added at the head that was reviewed: ${list(dropped)}${kept.length > 0 ? ` (${kept.join("; ")})` : ""}`,
    });
  const lingering = l.removed.filter((x) => l.after.has(x));
  if (lingering.length > 0)
    out.push({
      invariant: "reviewedIsLanded",
      cls: keptTrailers(l).length > 0 ? "reviewedIsLanded/removed-line-survives-by-combine" : `reviewedIsLanded/removed-line-survives-${l.origin}-${l.how}`,
      pull: l.pull,
      message: `#${l.pull} removed ${lingering.length} line(s) that are still in main after it landed: ${list(lingering)}`,
    });
  if (l.modesLost.length > 0)
    out.push({
      invariant: "reviewedIsLanded",
      cls: "reviewedIsLanded/mode-lost",
      pull: l.pull,
      message: `#${l.pull} changed the mode of ${l.modesLost.join(", ")} and main did not keep it`,
    });
  return out;
}

/** A tree with dropped blocks never lands: a `Combined-Kept` trailer on a landed commit is a violation. */
export function noDroppedBlocksLand(l: Landing): Omit<Violation, "step">[] {
  const kept = keptTrailers(l);
  return kept.length === 0
    ? []
    : [
        {
          invariant: "noDroppedBlocksLand",
          cls: "noDroppedBlocksLand/combined-kept",
          pull: l.pull,
          message: `#${l.pull} landed carrying ${kept.join("; ")}`,
        },
      ];
}

/** No silent loss: a line in main before the landing, that the pull did not remove, is in main after it. */
export function noSilentLoss(l: Landing): Omit<Violation, "step">[] {
  const removed = new Set(l.removed);
  const lost = [...l.before].filter((x) => !removed.has(x) && !l.after.has(x));
  return lost.length === 0
    ? []
    : [
        {
          invariant: "noSilentLoss",
          cls: `noSilentLoss/${keptTrailers(l).length > 0 ? "dropped-by-combine" : `${l.origin}-${l.how}`}`,
          pull: l.pull,
          message: `landing #${l.pull} deleted ${lost.length} line(s) main had that the pull did not remove: ${list(lost)}`,
        },
      ];
}

/** What was checked is what landed: the landed tree is a tree the check or the gate passed. */
export function checkedIsLanded(l: Landing): Omit<Violation, "step">[] {
  if (l.checkedTrees.has(l.landedTree)) return [];
  return [
    {
      invariant: "checkedIsLanded",
      cls: `checkedIsLanded/${l.origin}-${l.how}`,
      pull: l.pull,
      message: `#${l.pull} landed tree ${l.landedTree.slice(0, 10)}, which no check or gate ran on (${l.checkedTrees.size} checked tree(s))`,
    },
  ];
}

/** An approval and a green check are of the head that landed, never an earlier one. */
export function gateAttachesToHead(l: Landing): Omit<Violation, "step">[] {
  if (l.approvedAtHead && l.greenAtHead) return [];
  return [
    {
      invariant: "gateAttachesToHead",
      cls: "gateAttachesToHead",
      pull: l.pull,
      message: `#${l.pull} landed at ${l.head.slice(0, 10)} with approval=${l.approvedAtHead} and green check=${l.greenAtHead} on that head`,
    },
  ];
}

/** How the pull's author is credited on what landed: the commit's author, a trailer, a commit in the history it carries, or not at all. */
export function crediting(l: Landing): "author" | "co-author-trailer" | "in-history" | "placeholder" | "nobody" {
  const top = l.commits[0];
  if (top === undefined) return "nobody";
  if (top.email === "forge@localhost") return "placeholder";
  if (top.email === l.author.email) return "author";
  if (top.body.includes(`Co-authored-by: ${l.author.name} <${l.author.email}>`)) return "co-author-trailer";
  if (l.commits.some((c) => c.email === l.author.email)) return "in-history";
  return "nobody";
}

/** The landed commit's author is the pull's author, or credits them in a trailer or the history it carries. */
export function authorshipKept(l: Landing): Omit<Violation, "step">[] {
  const how = crediting(l);
  const top = l.commits[0];
  if (how === "placeholder")
    return [{ invariant: "authorshipKept", cls: "authorshipKept/placeholder", pull: l.pull, message: `#${l.pull} landed as the placeholder author ${top?.name} <${top?.email}>` }];
  if (how !== "nobody") return [];
  return [
    {
      invariant: "authorshipKept",
      cls: `authorshipKept/${l.origin}-${l.how}`,
      pull: l.pull,
      message: `#${l.pull} by ${l.author.name} landed as ${top?.name} <${top?.email}>, with no trailer or commit crediting ${l.author.email}`,
    },
  ];
}

export const landingInvariants = [
  reviewedIsLanded,
  noDroppedBlocksLand,
  noSilentLoss,
  checkedIsLanded,
  gateAttachesToHead,
  authorshipKept,
] as const;

// ---------------------------------------------------------------------------
// The world: one forge, shared by every scenario (a repository each)

export interface World {
  app: App;
  dataDir: string;
  alice: User;
  carol: User;
  dave: User;
  erin: User;
  /** Called as a gate starts: the hook that lets a scenario move main under a gate. */
  onGate: Map<string, () => Promise<void>>;
  gated: Map<string, Set<string>>;
  counter: number;
  close(): Promise<void>;
}

export async function createWorld(): Promise<World> {
  const dataDir = await mkdtemp(join(tmpdir(), "landsim-"));
  const app = createApp({ dataDir, port: 0 });
  const users: User[] = [];
  for (const username of ["alice", "carol", "dave", "erin"]) {
    const made = await signUpProven(app, {
      username,
      email: `${username}@forge.test`,
      password: "a-long-passphrase",
    });
    if (!made.ok) throw new Error(`sign-up of ${username} failed`);
    users.push(made.value);
  }
  const [alice, carol, dave, erin] = users as [User, User, User, User];
  promote(app.db, alice, carol, dave, erin);
  if (!createOrg(app, alice, "acme").ok) throw new Error("org");
  const acme = getOrg(app.db, "acme")!;
  const devs = createTeam(app, alice, acme, "devs", "write");
  if (!devs.ok) throw new Error("team");
  for (const name of ["carol", "dave"])
    if (!addTeamMember(app, alice, acme, devs.value, name).ok)
      throw new Error("member");
  const world: World = {
    app,
    dataDir,
    alice,
    carol,
    dave,
    erin,
    onGate: new Map(),
    gated: new Map(),
    counter: 0,
    async close() {
      // Forks follow their parent from the outbox, off the caller: let the last one finish before the database goes.
      await Bun.sleep(150);
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
  provideChecksForTest(app, {
    gate: async (repo: Repo, _pull: Pull, commitOid: string) => {
      const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
      const hook = world.onGate.get(repo.id);
      world.onGate.delete(repo.id);
      if (hook !== undefined) await hook();
      // The gate's verdict is a function of the tree: red on conflict markers.
      const trees = world.gated.get(repo.id) ?? new Set<string>();
      world.gated.set(repo.id, trees);
      const chain = await git(dir, [
        "rev-list",
        "--first-parent",
        "--format=%T",
        commitOid,
        "-n",
        "12",
      ]);
      for (const l of chain.out.split("\n"))
        if (/^[0-9a-f]{40}$/.test(l)) trees.add(l);
      if (process.env["LANDSIM_DEBUG"]) console.log("GATE", commitOid, JSON.stringify(chain.out), chain.err);
      const red = await hasMarkers(dir, commitOid);
      return red
        ? { ok: false, error: "red", lines: ["(fail) conflict markers"] }
        : { ok: true, error: "", lines: [] };
    },
  } as unknown as ChecksHandle);
  return world;
}

// ---------------------------------------------------------------------------
// The simulation

interface PullState {
  spec: PullSpec;
  number: number;
  branch: string;
  user: User;
  headRepo: Repo;
  opened: boolean;
  checks: { head: string; base: string; tree: string; ok: boolean }[];
  audited: boolean;
  how: Landing["how"];
  /** Why the last attempt of a person to land it was refused. */
  lastRefusal: string;
}

export interface Outcome {
  violations: Violation[];
  /** What the forge said when a step did not happen: reason -> count. */
  refusals: Map<string, number>;
  landed: number;
  /** Per landing, the shape it left in history: `origin/how/base` -> [commits added to main, ...]. */
  shapes: Map<string, number[]>;
  /** The history main ended with, without oids: for comparing two runs of one seed. */
  signature: string;
  /** The tree main ended at. */
  finalTree: string;
}

export class Sim {
  readonly outcome: Outcome = {
    violations: [],
    refusals: new Map(),
    landed: 0,
    shapes: new Map(),
    signature: "",
    finalTree: "",
  };
  private repo!: Repo;
  private dir!: string;
  private fork: Repo | undefined;
  private forkDir = "";
  private readonly pulls = new Map<number, PullState>();
  private tips: string[] = [];
  private stepNo = 0;
  private lastSeen = "";
  private readonly app: App;

  constructor(
    private readonly world: World,
    private readonly sc: Scenario,
  ) {
    this.app = world.app;
  }

  private refuse(why: string): void {
    this.outcome.refusals.set(why, (this.outcome.refusals.get(why) ?? 0) + 1);
  }

  private violate(v: Omit<Violation, "step">): void {
    this.outcome.violations.push({ ...v, step: this.stepNo });
  }

  private user(who: Who): User {
    return who === "dave"
      ? this.world.dave
      : who === "carol"
        ? this.world.carol
        : this.world.erin;
  }

  private async mainTip(): Promise<string> {
    return (await git(this.dir, ["rev-parse", "refs/heads/main"])).out.trim();
  }

  async setup(): Promise<void> {
    const { app, world } = this;
    const name = `r${++world.counter}`;
    const made = await createRepo(app, world.alice, {
      owner: "acme",
      name,
      visibility: "public",
    });
    if (!made.ok) throw new Error(`createRepo: ${String(made.error)}`);
    app.db
      .query(
        "UPDATE repo SET require_review = 1, require_checks = 1, autonomy = 'autonomous', autonomy_by = ?2 WHERE id = ?1",
      )
      .run(made.value.id, world.alice.id);
    this.repo = getRepoById(app.db, made.value.id)!;
    this.dir = repoDir(app.reposRoot, this.repo.ownerName, this.repo.name);
    const seeded = await commitToBranch(app, world.alice, this.repo, {
      message: "Start",
      // The check the queue gates on: declared, so the stub gate is asked.
      files: [
        { path: "forge.json", content: JSON.stringify({ check: { run: "true", fast: "true", full: "true" } }) },
        ...Object.entries(this.sc.files).map(([path, content]) => ({ path, content })),
      ],
    });
    if (!seeded.ok)
      throw new Error(`seed commit: ${JSON.stringify(seeded.error)}`);
    if (this.sc.pulls.some((p) => p.fork)) {
      // A person may fork five times a day; the simulator forks once per scenario.
      app.db.run("DELETE FROM fork_made");
      const forked = await forkRepo(app, world.erin, this.repo, `${name}-fork`);
      if (!forked.ok) throw new Error(`forkRepo: ${String(forked.error)}`);
      this.fork = forked.value;
      this.forkDir = repoDir(
        app.reposRoot,
        this.fork.ownerName,
        this.fork.name,
      );
    }
    this.tips = [await this.mainTip()];
    world.gated.set(this.repo.id, new Set());
  }

  /** The tip of main after `point` moves, as a branch of `dir` a pull can start from. */
  private async snapshot(dir: string, point: number): Promise<string> {
    const tip = this.tips[Math.min(point, this.tips.length - 1)]!;
    const name = `snap-${tip.slice(0, 12)}`;
    await git(dir, ["update-ref", `refs/heads/${name}`, tip]);
    return name;
  }

  private identity(user: User): { name: string; email: string } {
    return commitIdentity(this.app.config, user);
  }

  private async writeBranch(
    st: PullState,
    edits: readonly Edit[],
    opts: { base: string; force: boolean },
  ): Promise<boolean> {
    const dir = st.headRepo.id === this.repo.id ? this.dir : this.forkDir;
    const tree = await readTree(dir, `refs/heads/${opts.base}`);
    const writes = applyEdits(tree, edits);
    if (writes.length === 0) return false;
    if (opts.force)
      await git(dir, ["update-ref", "-d", `refs/heads/${st.branch}`]);
    const pushed = await commitToBranch(this.app, st.user, st.headRepo, {
      branch: st.branch,
      base: opts.base,
      message: `pull ${st.spec.id}`,
      files: writes,
    });
    if (!pushed.ok) {
      this.refuse(`push: ${JSON.stringify(pushed.error)}`);
      return false;
    }
    return true;
  }

  private async exec(step: Step): Promise<void> {
    const { app, world } = this;
    switch (step.op) {
      case "open": {
        const spec = this.sc.pulls.find((p) => p.id === step.p);
        if (spec === undefined) return;
        const user = this.user(spec.who);
        const headRepo = spec.fork ? this.fork! : this.repo;
        const dir = spec.fork ? this.forkDir : this.dir;
        const st: PullState = {
          spec,
          number: 0,
          branch: `p${spec.id}`,
          user,
          headRepo,
          opened: false,
          checks: [],
          audited: false,
          how: "unknown",
          lastRefusal: "",
        };
        const stacked =
          spec.stackedOn === undefined
            ? undefined
            : this.pulls.get(spec.stackedOn);
        let base: string;
        if (stacked?.opened === true && !spec.fork) base = stacked.branch;
        else base = await this.snapshot(dir, spec.point);
        if (!(await this.writeBranch(st, spec.edits, { base, force: false })))
          return;
        const opened = await openPull(app, user, this.repo, {
          title: `pull ${spec.id}`,
          baseBranch: "main",
          headBranch: st.branch,
          ...(spec.fork ? { headRepo: this.fork! } : {}),
        });
        if (!opened.ok) {
          this.refuse(`open: ${String(opened.error)}`);
          return;
        }
        st.number = opened.value.number;
        st.opened = true;
        this.pulls.set(spec.id, st);
        return;
      }
      case "main": {
        const tree = await readTree(this.dir, "refs/heads/main");
        const writes = applyEdits(tree, step.edits);
        if (writes.length === 0) return;
        const done = await commitToBranch(app, world.alice, this.repo, {
          branch: "main",
          message: `main moves ${this.tips.length}`,
          files: writes,
        });
        if (!done.ok) {
          this.refuse(`main: ${JSON.stringify(done.error)}`);
          return;
        }
        this.tips.push(await this.mainTip());
        // The post-receive hook of a push to main brings every kept-fork pull's combined branch up to date.
        await recombine(
          { db: app.db, reposRoot: app.reposRoot, log: app.log },
          this.repo.id,
        );
        return;
      }
      case "check":
        return this.check(step.p);
      case "approve": {
        const st = this.pulls.get(step.p);
        if (st === undefined || !this.isOpen(st)) return;
        const row = this.row(st);
        const done = await submitReview(app, world.alice, this.repo, row, {
          state: "approved",
        });
        if (!done.ok) this.refuse(`approve: ${String(done.error)}`);
        return;
      }
      case "contain": {
        const st = this.pulls.get(step.p);
        if (st === undefined || !this.isOpen(st)) return;
        const dir = st.headRepo.id === this.repo.id ? this.dir : this.forkDir;
        const head = (
          await git(dir, ["rev-parse", `refs/heads/${st.branch}`])
        ).out.trim();
        const main = await this.mainTip();
        const merged = await git(dir, [
          "merge-tree",
          "--write-tree",
          head,
          main,
        ]);
        if (merged.code !== 0) return; // the author would resolve by hand: not simulated
        const id = this.identity(st.user);
        const tree = merged.out.split("\n")[0]!.trim();
        const made = await runGitCapture(
          [
            "commit-tree",
            tree,
            "-p",
            head,
            "-p",
            main,
            "-m",
            `merge main into ${st.branch}`,
          ],
          {
            cwd: dir,
            env: {
              GIT_AUTHOR_NAME: id.name,
              GIT_AUTHOR_EMAIL: id.email,
              GIT_COMMITTER_NAME: id.name,
              GIT_COMMITTER_EMAIL: id.email,
            },
          },
        );
        const oid = made.stdout.trim();
        if (!/^[0-9a-f]{40}$/.test(oid)) return;
        await git(dir, ["update-ref", `refs/heads/${st.branch}`, oid, head]);
        await this.pushed(st, oid);
        return;
      }
      case "refresh": {
        const st = this.pulls.get(step.p);
        if (st === undefined || !this.isOpen(st)) return;
        const dir = st.headRepo.id === this.repo.id ? this.dir : this.forkDir;
        const base = step.rebase
          ? await this.snapshot(dir, this.tips.length - 1)
          : await this.snapshot(dir, st.spec.point);
        const edits = [...st.spec.edits, ...step.edits];
        if (
          !(await this.writeBranch(st, step.force ? edits : step.edits, {
            base: step.force ? base : st.branch,
            force: step.force,
          }))
        )
          return;
        await this.pushed(st);
        return;
      }
      case "land": {
        const st = this.pulls.get(step.p);
        if (st === undefined || !this.isOpen(st)) return;
        st.how = st.spec.fork ? "merge" : step.how;
        const merged = await mergePull(
          app,
          world.alice,
          this.repo,
          this.row(st),
          step.how,
        );
        if (!merged.ok)
          this.refuse(
            `land: ${typeof merged.error === "string" ? merged.error : merged.error.kind}`,
          );
        return;
      }
      case "sweep": {
        for (const st of this.pulls.values()) st.how = "queue";
        if (step.during !== undefined) {
          const during = step.during;
          world.onGate.set(this.repo.id, () => this.exec(during));
        }
        await sweepGreen(app, this.repo);
        world.onGate.delete(this.repo.id);
        return;
      }
      case "hook":
        await recombine({ db: app.db, reposRoot: app.reposRoot, log: app.log }, this.repo.id);
        return;
      case "settle":
        return this.settle();
    }
  }

  private row(st: PullState): Pull {
    return getPull(this.app.db, this.repo.id, st.number)!;
  }

  private isOpen(st: PullState): boolean {
    const row = this.row(st);
    return row.state === "open" && row.mergedAt === null;
  }

  /** A push to the author's branch reaches the forge as the hook would deliver it. */
  private async pushed(st: PullState, _oid?: string): Promise<void> {
    if (st.headRepo.id !== this.repo.id)
      await refreshPullHead(this.app, this.repo, this.row(st));
    else {
      const dir = this.dir;
      const tip = (
        await git(dir, ["rev-parse", `refs/heads/${st.branch}`])
      ).out.trim();
      this.app.db
        .query("UPDATE pull SET head_oid = ?2 WHERE issue_id = ?1")
        .run(this.row(st).id, tip);
    }
  }

  private async check(p: number): Promise<void> {
    const { app } = this;
    const st = this.pulls.get(p);
    if (st === undefined || !this.isOpen(st)) return;
    const row = this.row(st);
    const status = await pullStatus(this.dir, row);
    // As the checks service builds it: a kept fork's pull is checked on its combined commit,
    // as built on the base the combining named; any other pull is merged into the base tip.
    const combined = st.spec.fork ? await readCombined(this.dir, row.number, status.headOid) : undefined;
    let tree: string;
    let builtOn = status.baseOid;
    let source = status.headOid;
    let ok: boolean;
    if (combined !== undefined && combined.oid !== status.headOid) {
      source = combined.oid;
      builtOn = combined.baseOid === "" ? status.baseOid : combined.baseOid;
      tree = (await git(this.dir, ["rev-parse", `${source}^{tree}`])).out.trim();
      ok = !(await hasMarkers(this.dir, tree));
    } else {
      const merged = await mergeable(this.dir, status.baseOid, status.headOid);
      tree = merged.ok ? merged.value.treeOid : "";
      ok = merged.ok && !(await hasMarkers(this.dir, tree));
    }
    const run = createRun(app.db, {
      repoId: this.repo.id,
      kind: "check",
      issueId: row.id,
      env: `pull-${row.number}`,
      commitOid: status.headOid,
      reason: "pull",
    });
    claimRun(app.db, run.id);
    setRunBase(app.db, run.id, builtOn);
    if (source !== status.headOid) setRunCombined(app.db, run.id, source);
    finishRun(app.db, run.id, {
      state: ok ? "ok" : "failed",
      summary: ok ? "check passed" : "check failed",
    });
    st.checks.push({ head: status.headOid, base: builtOn, tree, ok });
  }

  /** The forge's own movers, and a person, run until nothing moves: then what is left must have someone who can move it. */
  private async settle(): Promise<void> {
    const order = [...this.pulls.values()];
    for (let round = 0; round < 2; round++) {
      // Main keeps being pushed to in a real forge: the post-receive hook combines every kept fork's pull again.
      await this.exec({ op: "hook" });
      for (const st of order) {
        if (!this.isOpen(st)) continue;
        await this.check(st.spec.id);
        const row = this.row(st);
        if (reviewSummary(this.app.db, row.id, row.headOid).approvals === 0)
          await this.exec({ op: "approve", p: st.spec.id });
        await this.audit();
        st.how = st.spec.fork || st.spec.id % 2 === 0 ? "merge" : "squash";
        const merged = await mergePull(
          this.app,
          this.world.alice,
          this.repo,
          this.row(st),
          st.how,
        );
        if (!merged.ok) {
          st.lastRefusal = typeof merged.error === "string" ? merged.error : merged.error.kind;
          this.refuse(`settle: ${st.lastRefusal}`);
        }
        await this.audit();
      }
      await this.exec({ op: "sweep" });
      await this.audit();
    }
    await this.liveness();
  }

  /** Liveness: an open pull that nothing can move is a state with no exit, and the forge must not name an actor who cannot act. */
  private async liveness(): Promise<void> {
    for (const st of this.pulls.values()) {
      if (!this.isOpen(st)) continue;
      const row = this.row(st);
      const status = await pullStatus(this.dir, row);
      const next = nextOfPull(
        this.app.db,
        row,
        { headOid: status.headOid, conflicts: status.conflicts.length },
        this.repo,
      );
      if (next === null) continue;
      if (next.who === "queue") {
        // Approved and green: the queue is named, and one more sweep must land it.
        await this.exec({ op: "sweep" });
        await this.audit();
        if (this.isOpen(st) && st.lastRefusal === "guarded")
          this.refuse("waits: a stranger's pull changes a guarded path: only a person who can write here can land that change (the pull page says so; nextActor says queue)");
        else if (this.isOpen(st))
          this.violate({
            invariant: "liveness",
            cls: `liveness/queue-named-never-lands-${st.spec.fork ? "fork" : "repo"}${st.lastRefusal === "" ? "" : `-${st.lastRefusal}`}`,
            pull: st.spec.id,
            message: `#${st.spec.id} is "${next.why}" (next actor: queue) but a sweep of the merge queue does not land it, and nobody else is named${st.spec.fork ? " (a fork's pull is a person's to land)" : ""}${st.lastRefusal === "" ? "" : `; a person's landing was refused: ${st.lastRefusal}`}`,
          });
      } else if (next.who === "builder") {
        // A person's own pull has its author to move it; the forge's builder only exists for a crew agent's.
        const crew = this.app.db
          .query<{ kind: string }, [string]>("SELECT kind FROM user WHERE id = ?1")
          .get(row.authorId)?.kind === "agent";
        if (crew && bringUpToDate(this.app, this.repo, row, status.conflicts) === undefined)
          this.violate({
            invariant: "liveness",
            cls: "liveness/builder-named-but-cannot-start",
            pull: st.spec.id,
            message: `#${st.spec.id} is "${next.why}" (next actor: builder) but no run can be started for it`,
          });
        else this.refuse(`waits: ${next.why} (${crew ? "crew" : "its human author"})`);
      } else this.refuse(`waits: ${next.who}: ${next.why}`);
    }
  }

  /** After a step: audit every pull that landed since, and look at main. */
  async audit(): Promise<void> {
    const { app } = this;
    for (const st of this.pulls.values()) {
      if (st.audited) continue;
      const row = this.row(st);
      if (row.mergedAt === null) continue;
      st.audited = true;
      this.outcome.landed++;
      const carried =
        app.db
          .query<
            { carried: number },
            [string]
          >("SELECT carried FROM pull WHERE issue_id = ?1")
          .get(row.id)?.carried === 1;
      if (carried || row.mergedOid === null) continue;
      await this.auditLanding(st, row);
    }
    const tip = await this.mainTip();
    if (tip === this.lastSeen) return;
    this.lastSeen = tip;
    if (await hasMarkers(this.dir, tip))
      this.violate({
        invariant: "noMarkersInMain",
        cls: "noMarkersInMain",
        message: `main at ${tip.slice(0, 10)} holds conflict markers`,
      });
  }

  private async auditLanding(st: PullState, row: Pull): Promise<void> {
    const dir = this.dir;
    const landed = row.mergedOid!;
    const base = (await git(dir, ["rev-parse", `${landed}^1`])).out.trim();
    const head = row.headOid;
    const mb = (await git(dir, ["merge-base", base, head])).out.trim();
    const [before, after, mbLines, headLines] = await Promise.all([
      trackedLines(dir, base),
      trackedLines(dir, landed),
      trackedLines(dir, mb),
      trackedLines(dir, head),
    ]);
    const added = [...headLines].filter((x) => !mbLines.has(x));
    const removed = [...mbLines].filter((x) => !headLines.has(x));
    const log = await git(dir, [
      "log",
      "--format=%H%x1f%an%x1f%ae%x1f%P%x1f%B%x1e",
      `${base}..${landed}`,
    ]);
    const commits = log.out
      .split("\x1e")
      .map((r) => r.replace(/^\n/, ""))
      .filter((r) => r.length > 0)
      .map((r) => {
        const [oid, name, email, parents, ...body] = r.split("\x1f");
        return {
          oid: oid!,
          name: name!,
          email: email!,
          body: body.join("\x1f"),
          parents: parents === "" ? 0 : parents!.split(" ").length,
        };
      });
    const baseTree = (
      await git(dir, ["rev-parse", `${base}^{tree}`])
    ).out.trim();
    const landedTree = (
      await git(dir, ["rev-parse", `${landed}^{tree}`])
    ).out.trim();
    const checked = new Set<string>(this.world.gated.get(this.repo.id));
    for (const c of st.checks) if (c.head === head && c.ok) checked.add(c.tree);
    // A mode a pull set, that main did not set first and the landing does not carry.
    const modesLost: string[] = [];
    if (st.spec.edits.some((e) => e.k === "mode")) {
      const [h, m, b, c] = await Promise.all([
        readModes(dir, head),
        readModes(dir, mb),
        readModes(dir, base),
        readModes(dir, landed),
      ]);
      for (const [path, mode] of h)
        if (
          mode === "100755" &&
          m.get(path) !== "100755" &&
          b.get(path) === m.get(path) &&
          c.has(path) &&
          c.get(path) !== "100755"
        )
          modesLost.push(path);
    }
    const landing: Landing = {
      pull: st.spec.id,
      origin: st.spec.fork ? "fork" : "repo",
      author: this.identity(st.user),
      how: st.how,
      base,
      head,
      mergeBase: mb,
      landed,
      baseTree,
      landedTree,
      before,
      after,
      added,
      removed,
      commits,
      checkedTrees: checked,
      approvedAtHead: reviewSummary(this.app.db, row.id, head).approvals > 0,
      greenAtHead:
        checkSummary(this.app.db, row.id, head).state === "ok" ||
        (this.world.gated.get(this.repo.id)?.has(landedTree) ?? false),
      modesLost,
    };
    for (const check of landingInvariants)
      for (const v of check(landing)) this.violate(v);
    this.refuse(`credit: ${landing.origin}/${landing.how}: ${crediting(landing)}`);
    // The shape it left: how many commits one landing put on main.
    const own = Number(
      (await git(dir, ["rev-list", "--count", `${mb}..${head}`])).out.trim(),
    );
    const key = `${landing.origin}/${commits[0]?.parents === 2 ? "merge-commit" : "single-parent"}/${base === mb ? "base-unmoved" : "base-moved"}/${own === 1 ? "one-commit" : "n-commits"}`;
    const sizes = this.outcome.shapes.get(key) ?? [];
    sizes.push(commits.length);
    this.outcome.shapes.set(key, sizes);
  }

  async run(): Promise<Outcome> {
    await this.setup();
    for (const [i, step] of this.sc.steps.entries()) {
      this.stepNo = i + 1;
      const began = performance.now();
      try {
        await this.exec(step);
        if (process.env["LANDSIM_TIMING"] !== undefined)
          console.log(
            `  step ${i + 1} ${step.op} ${Math.round(performance.now() - began)} ms`,
          );
      } catch (e) {
        this.violate({
          invariant: "noCrash",
          cls: `noCrash/${step.op}`,
          message: `step ${i + 1} (${step.op}) threw: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      await this.audit();
    }
    this.outcome.signature = await signature(this.dir);
    this.outcome.finalTree = (
      await git(this.dir, ["rev-parse", "refs/heads/main^{tree}"])
    ).out.trim();
    return this.outcome;
  }
}

async function readModes(
  dir: string,
  rev: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const r = await git(dir, ["ls-tree", "-r", rev]);
  for (const l of r.out.split("\n")) {
    const m = /^(\d+) blob [0-9a-f]+\t(.*)$/.exec(l);
    if (m !== null) out.set(m[2]!, m[1]!);
  }
  return out;
}

/** Main's history with oids replaced by their order: what two runs of one seed must share (commit times differ). */
async function signature(dir: string): Promise<string> {
  const r = await git(dir, [
    "log",
    "--topo-order",
    "--reverse",
    "--format=%H|%P|%T|%an|%ae|%s",
    "refs/heads/main",
  ]);
  const ordinal = new Map<string, number>();
  const rows: string[] = [];
  for (const l of r.out.split("\n").filter(Boolean)) {
    const [h, p, t, an, ae, ...s] = l.split("|");
    ordinal.set(h!, ordinal.size);
    rows.push(
      `${ordinal.get(h!)}|${(p ?? "")
        .split(" ")
        .filter(Boolean)
        .map((x) => ordinal.get(x))
        .join(",")}|${t}|${an}|${ae}|${s.join("|")}`,
    );
  }
  return rows.join("\n");
}

/** Run one scenario in a repository of its own. */
export async function runScenario(
  world: World,
  sc: Scenario,
): Promise<Outcome> {
  const sim = new Sim(world, sc);
  try {
    return await sim.run();
  } catch (e) {
    const out = sim.outcome;
    out.violations.push({
      invariant: "noCrash",
      cls: "noCrash/harness",
      step: 0,
      message: `scenario threw: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    });
    return out;
  }
}

// ---------------------------------------------------------------------------
// Properties over pairs of pulls (the order and the additive ones)

/** Two pulls built to touch nothing in common. */
export function disjointPair(seed: number): Scenario {
  const r = rng(seed);
  const files = seedFiles(r);
  const names = Object.keys(files).filter(
    (f) => f.endsWith(".ts") || f.endsWith(".md") || f.endsWith(".json"),
  );
  const a = names[0]!;
  const b = names.find((f) => f !== a) ?? a;
  const fork = r() < 0.5;
  const mk = (
    id: number,
    file: string,
    who: Who,
    isFork: boolean,
  ): PullSpec => ({
    id,
    who,
    fork: isFork,
    point: 0,
    edits: [{ k: "append", file, tag: `d${id}`, n: 1 + int(r, 2) }],
  });
  const pulls = [
    mk(1, a, fork ? "erin" : "dave", fork),
    mk(2, b, r() < 0.5 ? "carol" : "erin", false),
  ];
  if (pulls[1]!.who === "erin") pulls[1]!.fork = true;
  return pairScript(seed, files, pulls);
}

/** Two pulls that only add lines at the same place. */
export function additivePair(seed: number): Scenario {
  const r = rng(seed);
  const files = seedFiles(r);
  const file = pick(r, ["README.md", "test/core.test.ts", "src/core.ts", "deps.lock", "config.json"]);
  const where = r();
  const at = int(r, 8);
  const mk = (id: number, who: Who, fork: boolean): PullSpec => ({
    id,
    who,
    fork,
    point: 0,
    edits: [
      where < 0.34
        ? { k: "append", file, tag: `a${id}`, n: 1 + int(r, 2) }
        : where < 0.67
          ? { k: "list", file: "README.md", tag: `a${id}`, n: 1 }
          : { k: "anchor", file, tag: `a${id}`, n: 1, at },
    ],
  });
  const forkA = r() < 0.5;
  const forkB = r() < 0.5;
  return pairScript(seed, files, [
    mk(1, forkA ? "erin" : "dave", forkA),
    mk(2, forkB ? "erin" : "carol", forkB),
  ]);
}

/** Two pulls from one fork, each appending lines at the end of the same file: the case of #12104. */
export function additiveForkPair(): Scenario {
  const files = { "README.md": "# Project ~r0.h\n- item ~r0.0\n- item ~r0.1\n", "test/core.test.ts": 'test("seed", () => {}); // ~r1.0\n' };
  const mk = (id: number): PullSpec => ({ id, who: "erin", fork: true, point: 0, edits: [{ k: "append", file: "test/core.test.ts", tag: `a${id}`, n: 1 }] });
  return pairScript(1, files, [mk(1), mk(2)]);
}

function pairScript(
  seed: number,
  files: Record<string, string>,
  pulls: PullSpec[],
): Scenario {
  const steps: Step[] = [];
  for (const p of pulls) steps.push({ op: "open", p: p.id });
  for (const p of pulls)
    steps.push({ op: "check", p: p.id }, { op: "approve", p: p.id });
  return { seed, files, pulls, steps };
}

/** Land the pair's pulls one after the other, in the given order, the way a person would (each checked and approved just before). */
export async function landInOrder(
  world: World,
  sc: Scenario,
  order: readonly number[],
  how: "merge" | "squash",
): Promise<{ outcome: Outcome; refused: string[] }> {
  const steps: Step[] = [...sc.steps];
  for (const p of order)
    steps.push(
      { op: "check", p },
      { op: "approve", p },
      { op: "land", p, how },
      { op: "hook" },
    );
  const sim = new Sim(world, { ...sc, steps });
  const outcome = await sim.run();
  const refused = [...outcome.refusals.keys()].filter((k) =>
    k.startsWith("land:"),
  );
  return { outcome, refused };
}

export interface PairResult {
  violations: Violation[];
  /** The landed orders' final trees: equal when the two pulls commute. */
  trees: string[];
}

/** Non-overlapping pulls give the same final tree whichever lands first. */
export async function checkOrderIndependence(
  world: World,
  seed: number,
): Promise<PairResult> {
  const sc = disjointPair(seed);
  const how = seed % 2 === 0 ? "merge" : "squash";
  const ab = await landInOrder(world, sc, [1, 2], how);
  const ba = await landInOrder(world, sc, [2, 1], how);
  const violations = [...ab.outcome.violations, ...ba.outcome.violations];
  if (ab.refused.length + ba.refused.length > 0)
    violations.push({
      invariant: "orderIndependence",
      cls: "orderIndependence/refused",
      step: 0,
      message: `non-overlapping pulls were refused: ${[...ab.refused, ...ba.refused].join(", ")}`,
    });
  else if (ab.outcome.finalTree !== ba.outcome.finalTree)
    violations.push({
      invariant: "orderIndependence",
      cls: "orderIndependence/trees-differ",
      step: 0,
      message: `landing #1 then #2 gave tree ${ab.outcome.finalTree.slice(0, 10)}, #2 then #1 gave ${ba.outcome.finalTree.slice(0, 10)}`,
    });
  return { violations, trees: [ab.outcome.finalTree, ba.outcome.finalTree] };
}

/** Pulls that only add lines at one place both land, with both sides present, without a person. */
export async function checkAdditiveMerges(
  world: World,
  seed: number,
): Promise<PairResult> {
  const sc = additivePair(seed);
  const how = seed % 2 === 0 ? "merge" : "squash";
  const trees: string[] = [];
  const violations: Violation[] = [];
  for (const order of [
    [1, 2],
    [2, 1],
  ] as const) {
    const done = await landInOrder(world, sc, order, how);
    trees.push(done.outcome.finalTree);
    violations.push(...done.outcome.violations);
    if (done.refused.length > 0)
      violations.push({
        invariant: "additiveMergesCommute",
        cls: `additiveMergesCommute/needs-a-person-${sc.pulls.map((p) => (p.fork ? "fork" : "repo")).join("+")}`,
        step: 0,
        message: `two pulls that only add lines at one place (${sc.pulls.map((p) => (p.fork ? "fork" : "repo")).join("+")}, order ${order.join(",")}) did not both land: ${done.refused.join(", ")}`,
      });
  }
  return { violations, trees };
}

// ---------------------------------------------------------------------------
// Determinism, shrinking and the corpus

/** One seed twice: the history main ends with must be the same, up to commit times. */
export async function checkDeterminism(
  world: World,
  seed: number,
): Promise<Violation[]> {
  const a = await runScenario(world, generate(seed));
  const b = await runScenario(world, generate(seed));
  return a.signature === b.signature && a.finalTree === b.finalTree
    ? []
    : [
        {
          invariant: "determinism",
          cls: "determinism/history-differs",
          step: 0,
          message: `seed ${seed} landed differently on a second run:\n${a.signature}\n----\n${b.signature}`,
        },
      ];
}

/** A violation class an open issue already owns: the suite lists it, stays green, and flips when the class stops appearing in its own reproducer. */
export const KNOWN_VIOLATIONS: readonly { prefix: string; issue: string; why: string }[] = [
  { prefix: "reviewedIsLanded/dropped-by-combine", issue: "#12104", why: "a kept fork's conflicting block lands with main's side only; the reviewed lines are gone" },
  { prefix: "reviewedIsLanded/removed-line-survives-by-combine", issue: "#12104", why: "the same, for a line the pull removed or rewrote" },
  { prefix: "noSilentLoss/dropped-by-combine", issue: "#12104", why: "the same, seen from main's side" },
  { prefix: "noDroppedBlocksLand/combined-kept", issue: "#12104", why: "a tree with Combined-Kept blocks lands" },
  { prefix: "liveness/queue-named-never-lands-fork", issue: "unfiled", why: "after one pull lands, the other kept forks' combined/N are stale and landing fires no hook: the check is stale (checks_required), the pull says queue, and neither the queue nor a person can land it until something else pushes to main" },
  { prefix: "reviewedIsLanded/removed-line-survives", issue: "unfiled", why: "a kept fork's delete or rename that conflicts with main lands through combine with the file kept or under both names, so a line the pull removed survives (or a later pull's edit reaches one copy of it)" },
  { prefix: "reviewedIsLanded/mode-lost", issue: "unfiled", why: "a kept fork's chmod on a file main deleted lands through combine with the file back at the old mode" },
  { prefix: "authorshipKept/repo", issue: "unfiled", why: "a pull whose commits already landed inside a stacked pull lands again as an empty squash by the lander, crediting nobody" },
  { prefix: "additiveMergesCommute/needs-a-person", issue: "#12104", why: "two in-repo pulls that only add lines at one place do not merge: git conflicts, and the pull waits for a crew run or a person" },
];

/** The issue that owns a violation class, when one does. */
export const knownIssue = (cls: string): string | undefined => KNOWN_VIOLATIONS.find((k) => cls.startsWith(k.prefix))?.issue;

const sameClass = (out: Outcome, cls: string): boolean =>
  out.violations.some((v) => v.cls === cls);

/** Cut a failing scenario down: drop steps, pulls, edits and lines while the same class of violation remains. */
export const shrink = (world: World, sc: Scenario, cls: string, budget = 80): Promise<Scenario> =>
  shrinkBy(async (c) => sameClass(await runScenario(world, c), cls), sc, budget);

/** The shrinker over any test of "still fails": at most `budget` runs of it. */
export async function shrinkBy(
  fails: (sc: Scenario) => Promise<boolean>,
  sc: Scenario,
  budget = 80,
): Promise<Scenario> {
  let best = sc;
  let tries = 0;
  const holds = async (c: Scenario): Promise<boolean> => {
    if (tries++ >= budget) return false;
    return fails(c);
  };
  const withoutPull = (c: Scenario, id: number): Scenario => ({
    ...c,
    pulls: c.pulls
      .filter((p) => p.id !== id)
      .map((p) =>
        p.stackedOn === id ? (({ stackedOn: _gone, ...rest }) => rest)(p) : p,
      ),
    steps: c.steps.filter((s) => !("p" in s && s.p === id)),
  });
  for (let progress = true; progress && tries < budget; ) {
    progress = false;
    for (const p of [...best.pulls]) {
      const trial = withoutPull(best, p.id);
      if (trial.pulls.length >= 1 && (await holds(trial))) {
        best = trial;
        progress = true;
      }
    }
    for (let i = best.steps.length - 1; i >= 0; i--) {
      if (best.steps[i]!.op === "settle") continue;
      const trial = { ...best, steps: best.steps.filter((_, j) => j !== i) };
      if (await holds(trial)) {
        best = trial;
        progress = true;
      }
    }
    for (const p of best.pulls) {
      for (let e = p.edits.length - 1; e >= 0 && p.edits.length > 1; e--) {
        const trial: Scenario = {
          ...best,
          pulls: best.pulls.map((q) =>
            q.id === p.id
              ? { ...q, edits: q.edits.filter((_, j) => j !== e) }
              : q,
          ),
        };
        if (await holds(trial)) {
          best = trial;
          progress = true;
          break;
        }
      }
    }
    for (const name of Object.keys(best.files)) {
      if (Object.keys(best.files).length <= 1) break;
      const { [name]: _dropped, ...rest } = best.files;
      const trial = { ...best, files: rest };
      if (await holds(trial)) {
        best = trial;
        progress = true;
      }
    }
  }
  return best;
}

/** A failure the way a person should read it: the seed, the script, then what broke. */
export function report(sc: Scenario, violations: readonly Violation[]): string {
  return [
    `landsim: ${violations.length} violation(s), seed ${sc.seed}`,
    script(sc),
    ...violations.map(
      (v) => `  VIOLATION [${v.cls}] at step ${v.step}: ${v.message}`,
    ),
  ].join("\n");
}

export interface Corpus {
  seeds: number;
  /** class -> seeds that showed it. */
  classes: Map<string, number[]>;
  messages: Map<string, string>;
  refusals: Map<string, number>;
  shapes: Map<string, number[]>;
  landed: number;
  /** The first seed of each class: where its reproducer comes from. */
  first: Map<string, number>;
}

/** Run seeds `from..from+count-1`, plus the pair properties on a share of them, and gather what failed. */
export async function runCorpus(
  world: World,
  from: number,
  count: number,
  jobs = 1,
  into?: Corpus,
): Promise<Corpus> {
  const c: Corpus = into ?? {
    seeds: 0,
    classes: new Map(),
    messages: new Map(),
    refusals: new Map(),
    shapes: new Map(),
    landed: 0,
    first: new Map(),
  };
  c.seeds += count;
  const note = (seed: number, vs: readonly Violation[]): void => {
    for (const v of vs) {
      const seen = c.classes.get(v.cls) ?? [];
      if (!seen.includes(seed)) seen.push(seed);
      c.classes.set(v.cls, seen);
      if (!c.messages.has(v.cls)) c.messages.set(v.cls, v.message);
      if (!c.first.has(v.cls)) c.first.set(v.cls, seed);
    }
  };
  const one = async (seed: number): Promise<void> => {
    const out = await runScenario(world, generate(seed));
    note(seed, out.violations);
    c.landed += out.landed;
    for (const [k, n] of out.refusals) c.refusals.set(k, (c.refusals.get(k) ?? 0) + n);
    for (const [k, v] of out.shapes) c.shapes.set(k, [...(c.shapes.get(k) ?? []), ...v]);
    if (seed % 4 === 0) note(seed, (await checkOrderIndependence(world, seed)).violations);
    if (seed % 4 === 1) note(seed, (await checkAdditiveMerges(world, seed)).violations);
    if (seed % 16 === 2) note(seed, await checkDeterminism(world, seed));
  };
  // A few scenarios at once, each in a repository of its own: what runs is the same whatever the order.
  let next = from;
  const worker = async (): Promise<void> => {
    while (next < from + count) await one(next++);
  };
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
  return c;
}

export const seedCount = (fallback: number): number => {
  const n = Number(process.env["LANDSIM_SEEDS"] ?? fallback);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback: number): number => {
    const i = args.indexOf(name);
    return i === -1 ? fallback : Number(args[i + 1]);
  };
  const count = flag("--seeds", 50);
  const from = flag("--from", 1);
  const keep = args.includes("--shrink");
  // A repository keeps a git reader open for as long as its forge does: a long run takes a fresh forge every so often.
  process.on("unhandledRejection", (e) => console.error("landsim: unhandled rejection:", String(e)));
  const started = performance.now();
  const chunk = flag("--chunk", 40);
  const corpus: Corpus = {
    seeds: 0,
    classes: new Map(),
    messages: new Map(),
    refusals: new Map(),
    shapes: new Map(),
    landed: 0,
    first: new Map(),
  };
  // Cumulative after every chunk, so a run cut short still says what it saw.
  const emit = (): void => {
    if (!args.includes("--json")) return;
    const hist = (v: number[]): Record<number, number> => {
      const h: Record<number, number> = {};
      for (const n of v) h[n] = (h[n] ?? 0) + 1;
      return h;
    };
    console.log(
      `LANDSIM_JSON ${JSON.stringify({
        from,
        seeds: corpus.seeds,
        landed: corpus.landed,
        classes: Object.fromEntries(corpus.classes),
        messages: Object.fromEntries(corpus.messages),
        refusals: Object.fromEntries(corpus.refusals),
        shapes: Object.fromEntries([...corpus.shapes].map(([k, v]) => [k, hist(v)])),
      })}`,
    );
  };
  let world = await createWorld();
  for (let at = from; at < from + count; at += chunk) {
    await runCorpus(world, at, Math.min(chunk, from + count - at), flag("--jobs", 1), corpus);
    emit();
    await world.close();
    world = await createWorld();
  }
  const ms = Math.round(performance.now() - started);
  console.log(
    `landsim: ${count} seeds from ${from} in ${ms} ms; ${corpus.landed} pulls landed`,
  );
  for (const [cls, seeds] of [...corpus.classes].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    console.log(
      `\n${seeds.length} seed(s)  ${cls}\n  first seed ${corpus.first.get(cls)}: ${corpus.messages.get(cls)}`,
    );
    if (
      keep &&
      !cls.startsWith("orderIndependence") &&
      !cls.startsWith("additive") &&
      !cls.startsWith("determinism")
    ) {
      const sc = generate(corpus.first.get(cls)!);
      const small = await shrink(world, sc, cls);
      console.log(
        report(
          small,
          (await runScenario(world, small)).violations.filter(
            (v) => v.cls === cls,
          ),
        ),
      );
    }
  }
  console.log("\nrefusals the forge gave:");
  for (const [k, n] of [...corpus.refusals].sort((a, b) => b[1] - a[1]))
    console.log(`  ${n}  ${k}`);
  console.log("\nhistory shapes (commits one landing put on main):");
  for (const [k, v] of [...corpus.shapes].sort()) {
    const hist = new Map<number, number>();
    for (const n of v) hist.set(n, (hist.get(n) ?? 0) + 1);
    console.log(
      `  ${k}: ${[...hist]
        .sort((a, b) => a[0] - b[0])
        .map(([n, c]) => `${c}x${n}`)
        .join(" ")}`,
    );
  }
  await world.close();
  process.exit(0);
}
