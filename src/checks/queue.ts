/**
 * The merge queue (#2036): per repository, one line of pulls that are green
 * and approved. The line is built into ONE candidate — the base's tip, then
 * each queued pull's squash on top of the one before, in queue order, for
 * every pull that merges cleanly — and that candidate is gated once. Green
 * lands every step in order, each landing guarded so the squash it writes
 * is the step's tree on the base the step was built on: main ends at
 * exactly the tree that was gated. Red bisects: the first half is gated on
 * its own; green lands it and the culprit is in the rest, red keeps the
 * search in the first half while the rest waits for the next candidate. A
 * single red step is the culprit and is handed back. A gate cut off by the
 * forge stopping is no verdict: nothing is handed back, and the forge that
 * carries on admits the line again (#3155). A gate that has not answered
 * by `GATE_DEADLINE_MS` is abandoned the same way: cut off, logged, and the
 * line re-formed by the next sweep, so one gate that never returns cannot
 * hold the queue for good (#3430).
 *
 * What is queued is not stored: it is the pulls `landIfGreen` admitted, and
 * every sweep admits them again. The queue only orders them and remembers
 * how many there are, for the flow panel on /boards.
 */

import type { Pull } from "../core/pulls.ts";
import { runGit } from "../git/env.ts";
import { mergeable, resolveOid, treeOf } from "../git/merge.ts";
import { createLog } from "../kernel/log.ts";
import type { LandVerdict } from "./tiers.ts";

/** The base a step must land on, and the tree it must write. */
export interface Expect {
  readonly baseOid: string;
  readonly treeOid: string;
}

/** A red verdict: what the culprit is told. */
export type Red = Extract<LandVerdict, { reopen: true }>;

/** One pull in the line, and what landing or handing it back does. */
export interface Queued {
  readonly pull: Pull;
  /** Where the pull's objects are (`pullDir`): a candidate is built in one place. */
  readonly dir: string;
  /**
   * Land this pull as the step was gated: the new tip of the base, or
   * undefined when it did not land.
   */
  land(expect: Expect): Promise<string | undefined>;
  /**
   * This pull was the last step of its candidate to land, and the base is
   * now at `tip`: called once per candidate that landed anything.
   */
  release(tip: string): void;
  /** The gate found this pull to be the red one, on this base. */
  handBack(red: Red, baseOid: string): void;
}

/** One pull's squash on top of the steps before it. */
export interface Step {
  readonly entry: Queued;
  readonly baseOid: string;
  readonly treeOid: string;
}

/** What is gated: a chain of steps on the base, ending at `tipOid`. */
export interface Candidate {
  readonly dir: string;
  readonly baseOid: string;
  readonly steps: readonly Step[];
  readonly tipOid: string;
  readonly treeOid: string;
}

/**
 * Gate a candidate: the full tier on its tip. `signal` aborts when the
 * queue abandons the gate at its deadline: what it started should stop.
 */
export type GateCandidate = (candidate: Candidate, signal: AbortSignal) => Promise<LandVerdict>;

/**
 * How long a candidate's gate may run before the queue abandons it (#3430):
 * twice the forge's full tier. Past it the gate is no verdict, as a gate the
 * forge stopping cut off is not (#3155).
 */
export const GATE_DEADLINE_MS = 15 * 60_000;

let deadlineMs = GATE_DEADLINE_MS;

/**
 * The most pulls one candidate carries (#3430): eight keep a gate near one
 * full tier and a red's bisection three gates deep. The rest of the line
 * waits for the next candidate, in order.
 */
export const MAX_CANDIDATE = 8;

/** Tests shorten the deadline; the answer puts it back. */
export function gateDeadlineForTest(ms: number): () => void {
  deadlineMs = ms;
  return () => {
    deadlineMs = GATE_DEADLINE_MS;
  };
}

/** The gate as a round asks it: the deadline is the line's own. */
type Gated = (candidate: Candidate) => Promise<LandVerdict>;

interface Waiting {
  readonly entry: Queued;
  readonly settle: (landed: boolean) => void;
}

interface Line {
  readonly repoId: string;
  waiting: Waiting[];
  /** Pull ids in the queue or its candidate: a pull is in the line once. */
  readonly holds: Set<string>;
  /** How many pulls the candidate at the gate now carries. */
  gating: number;
  /** When the candidate at the gate started, epoch ms; 0 when none is. */
  since: number;
  /** The gate runs this line has made, for a test and the log. */
  gates: number;
  draining: boolean;
}

const log = createLog("queue");

const lines = new Map<string, Line>();

const IDENTITY = {
  GIT_AUTHOR_NAME: "forge",
  GIT_AUTHOR_EMAIL: "forge@localhost",
  GIT_COMMITTER_NAME: "forge",
  GIT_COMMITTER_EMAIL: "forge@localhost",
};

function lineOf(repoId: string): Line {
  let line = lines.get(repoId);
  if (line === undefined) {
    line = { repoId, waiting: [], holds: new Set(), gating: 0, since: 0, gates: 0, draining: false };
    lines.set(repoId, line);
  }
  return line;
}

/**
 * Join the repository's line, in this order. Each answer is whether that
 * pull landed. A pull already in the line is answered `false` at once: the
 * entry already there carries it.
 */
export function enqueue(
  repoId: string,
  entries: readonly Queued[],
  gate: GateCandidate,
): Promise<boolean[]> {
  const line = lineOf(repoId);
  const answers = entries.map((entry) => {
    if (line.holds.has(entry.pull.id)) return Promise.resolve(false);
    line.holds.add(entry.pull.id);
    return new Promise<boolean>((resolve) =>
      line.waiting.push({
        entry,
        settle: (landed) => {
          line.holds.delete(entry.pull.id);
          resolve(landed);
        },
      }),
    );
  });
  if (!line.draining) void drain(line, gate);
  return Promise.all(answers);
}

/** What the flow panel shows of each repository's line. */
export interface QueueStatus {
  readonly repoId: string;
  readonly queued: number;
  readonly gating: number;
  /** When the candidate at the gate started, epoch ms; 0 when none is. */
  readonly since: number;
}

export function queueStatus(): QueueStatus[] {
  return [...lines.entries()]
    .map(([repoId, line]) => ({
      repoId,
      queued: line.waiting.length,
      gating: line.gating,
      since: line.since,
    }))
    .filter((s) => s.queued > 0 || s.gating > 0);
}

/**
 * The repository's line in a few words, for the tick line (#3430):
 * `gating 4 pulls since 18:54` (UTC), `2 waiting`, both, or `idle`.
 */
export function queueWords(repoId: string): string {
  const line = lines.get(repoId);
  if (line === undefined) return "idle";
  const waiting = line.waiting.length === 0 ? "" : `${line.waiting.length} waiting`;
  if (line.gating === 0) return waiting === "" ? "idle" : waiting;
  return `gating ${pullsWord(line.gating)} since ${hhmm(line.since)}${waiting === "" ? "" : `, ${waiting}`}`;
}

/** `1 pull`, `8 pulls`. */
function pullsWord(n: number): string {
  return n === 1 ? "1 pull" : `${n} pulls`;
}

/** An epoch-ms instant as `HH:MM`, UTC as the log is. */
function hhmm(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

/** A gate's verdict in a word, for the log. */
function outcome(verdict: LandVerdict): string {
  if (verdict.lands) return "green";
  return "interrupted" in verdict ? "cut off" : "red";
}

/** Gate runs a repository's line has made since boot. */
export function gateRuns(repoId: string): number {
  return lines.get(repoId)?.gates ?? 0;
}

/**
 * One candidate at a time, until the line is empty. A batch is the front
 * of the line that shares one place and one base branch; a sealed pull
 * whose objects live elsewhere is a batch of its own. A batch carries at
 * most `MAX_CANDIDATE` pulls.
 */
async function drain(line: Line, gate: GateCandidate): Promise<void> {
  line.draining = true;
  try {
    while (line.waiting.length > 0) {
      const first = line.waiting[0]!.entry;
      const batch = line.waiting
        .filter((w) => w.entry.dir === first.dir && w.entry.pull.baseBranch === first.pull.baseBranch)
        .slice(0, MAX_CANDIDATE);
      line.waiting = line.waiting.filter((w) => !batch.includes(w));
      const counted: Gated = async (candidate) => {
        line.gates++;
        line.gating = candidate.steps.length;
        line.since = Date.now();
        const pulls = candidate.steps.map((s) => `#${s.entry.pull.number}`).join(",");
        // Said as it starts and as it ends: a gate takes minutes (#3430).
        log.info(`gating ${pullsWord(line.gating)} since ${hhmm(line.since)}`, {
          repo: line.repoId,
          pulls,
          waiting: line.waiting.length,
        });
        const abandon = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        // A gate that never answers is abandoned at the deadline: no
        // verdict, and the next sweep forms the line again (#3430).
        const deadline = new Promise<LandVerdict>((resolve) => {
          timer = setTimeout(() => {
            log.warn("candidate abandoned", {
              repo: line.repoId,
              pulls,
              since: new Date(line.since).toISOString(),
              deadline: `${Math.round(deadlineMs / 1000)}s`,
            });
            abandon.abort();
            resolve({ lands: false, interrupted: true });
          }, deadlineMs);
        });
        try {
          const verdict = await Promise.race([gate(candidate, abandon.signal), deadline]);
          log.info(`gated ${pullsWord(line.gating)}: ${outcome(verdict)}`, {
            repo: line.repoId,
            pulls,
            took: `${Math.round((Date.now() - line.since) / 1000)}s`,
          });
          return verdict;
        } finally {
          clearTimeout(timer);
          line.gating = 0;
          line.since = 0;
        }
      };
      let left: Waiting[];
      try {
        left = await round(batch, counted);
      } catch (error) {
        log.warn("merge queue round failed", { error: String(error) });
        for (const w of batch) w.settle(false);
        left = [];
      }
      // What waits for the next candidate goes back to the front.
      line.waiting = [...left, ...line.waiting];
    }
  } finally {
    line.draining = false;
  }
}

/**
 * Build, gate and land one candidate of `batch`. `known` is a red verdict
 * already read for a tree: a candidate that builds to that same tree is
 * not gated again. Returns what waits for the next candidate.
 */
async function round(
  batch: readonly Waiting[],
  gate: Gated,
  known?: { treeOid: string; red: Red },
): Promise<Waiting[]> {
  const candidate = await build(batch);
  if (candidate === undefined || candidate.steps.length === 0) {
    for (const w of batch) w.settle(false);
    return [];
  }
  const inIt = new Set(candidate.steps.map((s) => s.entry));
  // Conflicts with the base or an earlier step, or nothing left to land
  // once the steps before it did: not this candidate's; the next sweep
  // brings it up to date or closes it as carried.
  for (const w of batch) if (!inIt.has(w.entry)) w.settle(false);
  const steps = batch.filter((w) => inIt.has(w.entry));
  const verdict: LandVerdict =
    known !== undefined && known.treeOid === candidate.treeOid
      ? known.red
      : await gate(candidate);
  if (verdict.lands) {
    await land(candidate, steps);
    return [];
  }
  // The gate was cut off (the forge stopping, the Job lost): nothing is
  // decided and no one is handed back; the next sweep admits them again (#3155).
  if ("interrupted" in verdict) {
    for (const w of steps) w.settle(false);
    return [];
  }
  if (steps.length === 1) {
    steps[0]!.entry.handBack(verdict, candidate.baseOid);
    steps[0]!.settle(false);
    return [];
  }
  const red = { treeOid: candidate.treeOid, red: verdict };
  const half = Math.ceil(steps.length / 2);
  const front = steps.slice(0, half);
  const rest = steps.slice(half);
  const part = await build(front);
  if (part === undefined || part.steps.length < front.length) {
    // The base moved under the search: nothing here is decided, and the
    // next sweep admits these again onto the base as it is now.
    for (const w of steps) w.settle(false);
    return [];
  }
  const frontVerdict = await gate(part);
  if (frontVerdict.lands) {
    await land(part, front);
    // The front was green, the whole red: the culprit is in the rest, and
    // the rest on the new base is the red tree again.
    return round(rest, gate, red);
  }
  if ("interrupted" in frontVerdict) {
    for (const w of steps) w.settle(false);
    return [];
  }
  const left = await round(front, gate, { treeOid: part.treeOid, red: frontVerdict });
  return [...left, ...rest];
}

/**
 * Land each step in order; a step that does not land leaves the rest for
 * the line. The last step that did land is released, so a prefix that
 * reached the base is never left without one.
 */
async function land(candidate: Candidate, steps: readonly Waiting[]): Promise<void> {
  let at = candidate.baseOid;
  let landed: Queued | undefined;
  try {
    for (const [i, step] of candidate.steps.entries()) {
      const w = steps[i]!;
      const tip = await step.entry.land({ baseOid: at, treeOid: step.treeOid });
      if (tip === undefined) {
        log.warn("merge queue: a gated step did not land", {
          pull: step.entry.pull.number,
          landed: i,
          of: candidate.steps.length,
        });
        for (const rest of steps.slice(i)) rest.settle(false);
        return;
      }
      w.settle(true);
      at = tip;
      landed = step.entry;
    }
  } finally {
    landed?.release(at);
  }
}

/**
 * The candidate of `batch` on its base's tip now: each pull's squash on the
 * step before it. A pull that conflicts, or whose squash changes nothing,
 * is left out. Undefined when the base cannot be read.
 */
async function build(batch: readonly Waiting[]): Promise<Candidate | undefined> {
  const first = batch[0]?.entry;
  if (first === undefined) return undefined;
  const dir = first.dir;
  const baseOid = await resolveOid(dir, `refs/heads/${first.pull.baseBranch}`);
  if (baseOid === undefined) return undefined;
  let tipOid = baseOid;
  let treeOid = await treeOf(dir, baseOid);
  if (treeOid === undefined) return undefined;
  const steps: Step[] = [];
  for (const { entry } of batch) {
    const merged = await mergeable(dir, tipOid, entry.pull.headOid);
    if (!merged.ok || merged.value.treeOid === treeOid) continue;
    const commit = await runGit(
      ["commit-tree", merged.value.treeOid, "-p", tipOid, "-m", `merge queue: #${entry.pull.number}`],
      { cwd: dir, env: IDENTITY },
    );
    if (!commit.ok) continue;
    steps.push({ entry, baseOid: tipOid, treeOid: merged.value.treeOid });
    tipOid = commit.value.trim();
    treeOid = merged.value.treeOid;
  }
  return { dir, baseOid, steps, tipOid, treeOid };
}
