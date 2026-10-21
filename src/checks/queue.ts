/**
 * The merge queue (#2036): per repository, one line of pulls that are green
 * and approved. The line is built into candidates — the base's tip, then
 * each queued pull's squash on top of the one before, in queue order, for
 * every pull that merges cleanly — and each candidate is gated once. Green
 * lands every step in order, each landing guarded so the squash it writes
 * is the step's tree on the base the step was built on: main ends at
 * exactly the tree that was gated.
 *
 * The line gates in parallel where check slots are free (#4053). While a
 * candidate gates on main, the next gates on top of it (`depth` deep): if
 * the first lands whole, the next lands right after on the tree it was
 * gated on; if not, the next is discarded and formed again on main. A red
 * candidate is searched by gating several of its prefixes at once, one per
 * free slot: the longest green prefix lands, the culprit is in the steps up
 * to the first red prefix, and the steps after it wait for the next
 * candidate. With no slot free that is one prefix, the front half: plain
 * bisection. A single red step is the culprit and is handed back.
 *
 * A gate cut off by the forge stopping is no verdict: nothing is handed
 * back, and the forge that carries on admits the line again (#3155). A gate
 * that has not answered by `GATE_DEADLINE_MS` is abandoned the same way:
 * cut off, logged, and the line re-formed by the next sweep, so one gate
 * that never returns cannot hold the queue for good (#3430).
 *
 * What is queued is not stored: it is the pulls `landIfGreen` admitted, and
 * every sweep admits them again. The queue only orders them and remembers
 * what is at the gate, for the flow panel on /boards.
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
  /** The chain's commit once this step is on it: the tip of its prefix. */
  readonly commitOid: string;
}

/** What is gated: a chain of steps on the base, ending at `tipOid`. */
export interface Candidate {
  readonly dir: string;
  readonly baseOid: string;
  readonly baseTreeOid: string;
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

/** Candidates gating at once by default: one on main, the next on top of it. */
export const DEFAULT_DEPTH = 2;

/** How the line may use the forge's check slots (#4053). */
export interface QueueOptions {
  /** How many candidates may gate at once, each on the one before. */
  readonly depth?: number;
  /**
   * Check slots free now for a gate beyond a line's first, the pull
   * checks' reserve already kept back; none when not said.
   */
  readonly room?: () => number;
}

/** Tests shorten the deadline; the answer puts it back. */
export function gateDeadlineForTest(ms: number): () => void {
  deadlineMs = ms;
  return () => {
    deadlineMs = GATE_DEADLINE_MS;
  };
}

/** The gate as the line asks it: the deadline is the line's own. */
type Gated = (candidate: Candidate, signal?: AbortSignal) => Promise<LandVerdict>;

/** Check slots free now for one more gate beyond a line's first. */
type Room = () => number;

interface Waiting {
  readonly entry: Queued;
  readonly settle: (landed: boolean) => void;
}

/** One gate in flight: the pulls its candidate carries, and since when. */
interface InFlight {
  readonly pulls: readonly string[];
  readonly since: number;
}

interface Line {
  readonly repoId: string;
  waiting: Waiting[];
  /** Pull ids in the queue or a candidate: a pull is in the line once. */
  readonly holds: Set<string>;
  /** The gates this line has in flight now. */
  readonly flights: Set<InFlight>;
  /** The gate runs this line has made, for a test and the log. */
  gates: number;
  draining: boolean;
  /** Wakes a drain waiting on a gate when pulls join the line. */
  wake: (() => void) | undefined;
}

/** A candidate at the gate in the pipeline, and the pulls it took from the line. */
interface Flight {
  readonly steps: readonly Waiting[];
  readonly candidate: Candidate;
  /** Built on the flight before it, not on the base's tip. */
  readonly speculative: boolean;
  readonly branch: string;
  readonly verdict: Promise<LandVerdict>;
  readonly abort: AbortController;
}

const log = createLog("queue");

const lines = new Map<string, Line>();

/** Gates in flight beyond each line's first, every line together. */
let extra = 0;

/**
 * Gates the queue has in flight beyond each line's first: each holds a
 * check slot a pull check does not take (`checks/service.ts`).
 */
export function extraGates(): number {
  return extra;
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "forge",
  GIT_AUTHOR_EMAIL: "forge@localhost",
  GIT_COMMITTER_NAME: "forge",
  GIT_COMMITTER_EMAIL: "forge@localhost",
};

const UNDECIDED: LandVerdict = { lands: false, interrupted: true };

function lineOf(repoId: string): Line {
  let line = lines.get(repoId);
  if (line === undefined) {
    line = { repoId, waiting: [], holds: new Set(), flights: new Set(), gates: 0, draining: false, wake: undefined };
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
  options: QueueOptions = {},
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
  if (!line.draining) void drain(line, gate, options);
  else {
    line.wake?.();
    line.wake = undefined;
  }
  return Promise.all(answers);
}

/** What the flow panel shows of each repository's line. */
export interface QueueStatus {
  readonly repoId: string;
  readonly queued: number;
  /** Pulls in a candidate at the gate, each counted once. */
  readonly gating: number;
  /** Gates in flight. */
  readonly gates: number;
  /** When the oldest gate in flight started, epoch ms; 0 when none is. */
  readonly since: number;
}

function statusOf(repoId: string, line: Line): QueueStatus {
  const pulls = new Set<string>();
  let since = 0;
  for (const f of line.flights) {
    for (const id of f.pulls) pulls.add(id);
    if (since === 0 || f.since < since) since = f.since;
  }
  return { repoId, queued: line.waiting.length, gating: pulls.size, gates: line.flights.size, since };
}

export function queueStatus(): QueueStatus[] {
  return [...lines.entries()]
    .map(([repoId, line]) => statusOf(repoId, line))
    .filter((s) => s.queued > 0 || s.gating > 0);
}

/**
 * The repository's line in a few words, for the tick line (#3430):
 * `gating 4 pulls since 18:54` (UTC), `in 2 gates` when more than one is
 * in flight, `2 waiting`, or `idle`.
 */
export function queueWords(repoId: string): string {
  const line = lines.get(repoId);
  if (line === undefined) return "idle";
  const s = statusOf(repoId, line);
  const waiting = s.queued === 0 ? "" : `${s.queued} waiting`;
  if (s.gating === 0) return waiting === "" ? "idle" : waiting;
  const gates = s.gates > 1 ? ` in ${s.gates} gates` : "";
  return `gating ${pullsWord(s.gating)} since ${hhmm(s.since)}${gates}${waiting === "" ? "" : `, ${waiting}`}`;
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
 * The line's gate: counted, logged as it starts and ends (a gate takes
 * minutes, #3430), and abandoned at the deadline or when `signal` aborts —
 * a speculative candidate discarded. Abandoned is no verdict.
 */
function counted(line: Line, gate: GateCandidate): Gated {
  return async (candidate, signal) => {
    const beyond = line.flights.size > 0;
    const flight: InFlight = { pulls: candidate.steps.map((s) => s.entry.pull.id), since: Date.now() };
    line.flights.add(flight);
    line.gates++;
    if (beyond) extra++;
    const n = candidate.steps.length;
    const pulls = candidate.steps.map((s) => `#${s.entry.pull.number}`).join(",");
    log.info(`gating ${pullsWord(n)} since ${hhmm(flight.since)}`, {
      repo: line.repoId,
      pulls,
      waiting: line.waiting.length,
    });
    const abandon = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dropped: (() => void) | undefined;
    // A gate that never answers is abandoned at the deadline: no verdict,
    // and the next sweep forms the line again (#3430).
    const cut = new Promise<LandVerdict>((resolve) => {
      timer = setTimeout(() => {
        log.warn("candidate abandoned", {
          repo: line.repoId,
          pulls,
          since: new Date(flight.since).toISOString(),
          deadline: `${Math.round(deadlineMs / 1000)}s`,
        });
        abandon.abort();
        resolve(UNDECIDED);
      }, deadlineMs);
      dropped = () => {
        abandon.abort();
        resolve(UNDECIDED);
      };
      if (signal?.aborted === true) dropped();
      else signal?.addEventListener("abort", dropped, { once: true });
    });
    try {
      const verdict = await Promise.race([gate(candidate, abandon.signal), cut]);
      log.info(`gated ${pullsWord(n)}: ${outcome(verdict)}`, {
        repo: line.repoId,
        pulls,
        took: `${Math.round((Date.now() - flight.since) / 1000)}s`,
      });
      return verdict;
    } finally {
      clearTimeout(timer);
      if (dropped !== undefined) signal?.removeEventListener("abort", dropped);
      line.flights.delete(flight);
      if (beyond) extra--;
    }
  };
}

/** A drain waiting on its gate, woken by pulls joining the line. */
const ARRIVED = Symbol("arrived");

/**
 * Until the line is empty: keep up to `depth` candidates at the gate, the
 * first on the base's tip and each next on the one before, and settle the
 * first as its verdict comes. A batch is the front of the line that shares
 * one place and one base branch; a sealed pull whose objects live
 * elsewhere is a batch of its own, and is not stacked on another. A batch
 * carries at most `MAX_CANDIDATE` pulls. A gate beyond the line's first
 * starts only on a free check slot (`room`).
 */
async function drain(line: Line, gate: GateCandidate, options: QueueOptions): Promise<void> {
  line.draining = true;
  const gated = counted(line, gate);
  const depth = Math.max(1, Math.floor(options.depth ?? DEFAULT_DEPTH));
  const room: Room = options.room ?? (() => 0);
  const ahead: Flight[] = [];
  try {
    while (line.waiting.length > 0 || ahead.length > 0) {
      while (ahead.length < depth && line.waiting.length > 0 && (ahead.length === 0 || room() > 0)) {
        const flight = await launch(line, gated, ahead.at(-1));
        if (flight === "apart") break;
        if (flight !== undefined) ahead.push(flight);
      }
      const head = ahead[0];
      if (head === undefined) continue;
      const arrived =
        ahead.length < depth && line.waiting.length === 0
          ? new Promise<typeof ARRIVED>((resolve) => (line.wake = () => resolve(ARRIVED)))
          : undefined;
      const verdict = arrived === undefined ? await head.verdict : await Promise.race([head.verdict, arrived]);
      line.wake = undefined;
      if (verdict === ARRIVED) continue;
      ahead.shift();
      let left: Waiting[];
      try {
        left = await settleHead(head, verdict, ahead, gated, room);
      } catch (error) {
        log.warn("merge queue round failed", { error: String(error) });
        for (const w of head.steps) w.settle(false);
        left = await discard(ahead);
      }
      // What waits for the next candidate goes back to the front.
      line.waiting = [...left, ...line.waiting];
    }
  } finally {
    line.draining = false;
  }
}

/**
 * Take the next batch from the front of the line, build it — on `on`'s tip
 * when there is a flight to stack on — and start its gate. `apart` when
 * the front of the line cannot stack on `on`; undefined when nothing of
 * the batch could be built.
 */
async function launch(line: Line, gated: Gated, on: Flight | undefined): Promise<Flight | undefined | "apart"> {
  const first = line.waiting[0]!.entry;
  const branch = first.pull.baseBranch;
  if (on !== undefined && (first.dir !== on.candidate.dir || branch !== on.branch)) return "apart";
  const batch = line.waiting
    .filter((w) => w.entry.dir === first.dir && w.entry.pull.baseBranch === branch)
    .slice(0, MAX_CANDIDATE);
  line.waiting = line.waiting.filter((w) => !batch.includes(w));
  let candidate: Candidate | undefined;
  try {
    candidate = await build(batch, on?.candidate);
  } catch (error) {
    log.warn("merge queue round failed", { error: String(error) });
  }
  if (candidate === undefined || candidate.steps.length === 0) {
    for (const w of batch) w.settle(false);
    return undefined;
  }
  const steps = inCandidate(batch, candidate);
  const abort = new AbortController();
  const verdict = gated(candidate, abort.signal).catch((error: unknown) => {
    log.warn("merge queue round failed", { error: String(error) });
    return UNDECIDED;
  });
  return { steps, candidate, speculative: on !== undefined, branch, verdict, abort };
}

/**
 * The pulls of `batch` the candidate carries. The rest — a conflict with
 * the base or an earlier step, or nothing left to land once the steps
 * before it did — are not this candidate's; the next sweep brings them up
 * to date or closes them as carried.
 */
function inCandidate(batch: readonly Waiting[], candidate: Candidate): Waiting[] {
  const inIt = new Set(candidate.steps.map((s) => s.entry));
  for (const w of batch) if (!inIt.has(w.entry)) w.settle(false);
  return batch.filter((w) => inIt.has(w.entry));
}

/**
 * The first flight's verdict, acted on: green lands it and keeps the
 * flights behind it, anything else discards them back to the line. A
 * speculative flight is settled on the base's tip only when that tip is
 * the tree it was built on — the flight before it landed whole. Returns
 * what waits for the next candidate.
 */
async function settleHead(
  head: Flight,
  verdict: LandVerdict,
  ahead: Flight[],
  gated: Gated,
  room: Room,
): Promise<Waiting[]> {
  let candidate = head.candidate;
  if (head.speculative) {
    const tip = await onTip(candidate, head.branch);
    if (tip === undefined) {
      // What it was stacked on did not land as gated: formed again on main.
      return [...head.steps, ...(await discard(ahead))];
    }
    candidate = { ...candidate, baseOid: tip };
  }
  if (verdict.lands) {
    if (await land(candidate, head.steps)) return [];
    return discard(ahead);
  }
  const behind = await discard(ahead);
  // The gate was cut off (the forge stopping, the Job lost): nothing is
  // decided and no one is handed back; the next sweep admits them again (#3155).
  if ("interrupted" in verdict) {
    for (const w of head.steps) w.settle(false);
    return behind;
  }
  return [...(await judged(candidate, head.steps, verdict, gated, room)), ...behind];
}

/**
 * The base's tip, when its tree is the one `candidate` was built on:
 * undefined when the base moved elsewhere.
 */
async function onTip(candidate: Candidate, branch: string): Promise<string | undefined> {
  const tip = await resolveOid(candidate.dir, `refs/heads/${branch}`);
  if (tip === undefined) return undefined;
  if (tip === candidate.baseOid) return tip;
  return (await treeOf(candidate.dir, tip)) === candidate.baseTreeOid ? tip : undefined;
}

/**
 * Stop the flights in `ahead` — what they were stacked on did not land —
 * and hand their pulls back for the next candidate, in order.
 */
async function discard(ahead: Flight[]): Promise<Waiting[]> {
  const gone = ahead.splice(0);
  if (gone.length === 0) return [];
  for (const f of gone) f.abort.abort();
  await Promise.all(gone.map((f) => f.verdict));
  log.info("speculative candidates re-formed", {
    pulls: gone.flatMap((f) => f.steps.map((w) => `#${w.entry.pull.number}`)).join(","),
  });
  return gone.flatMap((f) => [...f.steps]);
}

/**
 * Build, gate and land one candidate of `batch` on the base's tip. `known`
 * is a red verdict already read for a tree: a candidate that builds to
 * that same tree is not gated again. Returns what waits for the next
 * candidate.
 */
async function round(
  batch: readonly Waiting[],
  gated: Gated,
  room: Room,
  known?: { treeOid: string; red: Red },
): Promise<Waiting[]> {
  const candidate = await build(batch);
  if (candidate === undefined || candidate.steps.length === 0) {
    for (const w of batch) w.settle(false);
    return [];
  }
  const steps = inCandidate(batch, candidate);
  const verdict: LandVerdict =
    known !== undefined && known.treeOid === candidate.treeOid ? known.red : await gated(candidate);
  if (verdict.lands) {
    await land(candidate, steps);
    return [];
  }
  if ("interrupted" in verdict) {
    for (const w of steps) w.settle(false);
    return [];
  }
  return judged(candidate, steps, verdict, gated, room);
}

/**
 * A red candidate: one step is the culprit, handed back on the base it was
 * red on. More are searched (#4053): the candidate is built again on the
 * base's tip and `k` of its prefixes are gated at once — one, the front
 * half, plus one per free check slot, evenly cut. The longest green prefix
 * before the first red one lands; the culprit is among the steps up to the
 * first red prefix (or, all green, the rest of the candidate, whose whole
 * tree is the red one), searched again; the steps after wait for the next
 * candidate.
 */
async function judged(
  candidate: Candidate,
  steps: readonly Waiting[],
  red: Red,
  gated: Gated,
  room: Room,
): Promise<Waiting[]> {
  if (steps.length === 1) {
    steps[0]!.entry.handBack(red, candidate.baseOid);
    steps[0]!.settle(false);
    return [];
  }
  const n = steps.length;
  const k = Math.min(n - 1, 1 + Math.max(0, room()));
  const cuts = [...new Set(Array.from({ length: k }, (_, j) => Math.ceil(((j + 1) * n) / (k + 1))))].filter(
    (c) => c >= 1 && c < n,
  );
  const last = cuts.at(-1)!;
  const whole = await build(steps);
  if (whole === undefined || whole.steps.slice(0, last).some((s, i) => s.entry !== steps[i]!.entry) || whole.steps.length < last) {
    // The base moved under the search: nothing here is decided, and the
    // next sweep admits these again onto the base as it is now.
    for (const w of steps) w.settle(false);
    return [];
  }
  const prefix = (c: number): Candidate => {
    const end = whole.steps[c - 1]!;
    return { ...whole, steps: whole.steps.slice(0, c), tipOid: end.commitOid, treeOid: end.treeOid };
  };
  const verdicts = await Promise.all(cuts.map((c) => gated(prefix(c))));
  let green = 0;
  let stop: Exclude<LandVerdict, { lands: true }> | undefined;
  let stopAt = n;
  for (const [j, c] of cuts.entries()) {
    const v = verdicts[j]!;
    if (v.lands) {
      green = c;
      continue;
    }
    stop = v;
    stopAt = c;
    break;
  }
  if (green > 0) await land(prefix(green), steps.slice(0, green));
  if (stop !== undefined && "interrupted" in stop) {
    for (const w of steps.slice(green)) w.settle(false);
    return [];
  }
  const known = stop === undefined ? { treeOid: candidate.treeOid, red } : { treeOid: prefix(stopAt).treeOid, red: stop };
  const left = await round(steps.slice(green, stopAt), gated, room, known);
  return [...left, ...steps.slice(stopAt)];
}

/**
 * Land each step in order, from the candidate's base; a step that does not
 * land leaves the rest for the line. The last step that did land is
 * released, so a prefix that reached the base is never left without one.
 * Whether every step landed.
 */
async function land(candidate: Candidate, steps: readonly Waiting[]): Promise<boolean> {
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
        return false;
      }
      w.settle(true);
      at = tip;
      landed = step.entry;
    }
    return true;
  } finally {
    landed?.release(at);
  }
}

/**
 * The candidate of `batch` on its base's tip now — or on `on`'s tip, to
 * gate it ahead of `on` landing: each pull's squash on the step before it.
 * A pull that conflicts, or whose squash changes nothing, is left out.
 * Undefined when the base cannot be read.
 */
async function build(batch: readonly Waiting[], on?: Candidate): Promise<Candidate | undefined> {
  const first = batch[0]?.entry;
  if (first === undefined) return undefined;
  const dir = first.dir;
  const baseOid = on?.tipOid ?? (await resolveOid(dir, `refs/heads/${first.pull.baseBranch}`));
  if (baseOid === undefined) return undefined;
  let tipOid = baseOid;
  const baseTreeOid = on?.treeOid ?? (await treeOf(dir, baseOid));
  if (baseTreeOid === undefined) return undefined;
  let treeOid = baseTreeOid;
  const steps: Step[] = [];
  for (const { entry } of batch) {
    const merged = await mergeable(dir, tipOid, entry.pull.headOid);
    if (!merged.ok || merged.value.treeOid === treeOid) continue;
    const commit = await runGit(
      ["commit-tree", merged.value.treeOid, "-p", tipOid, "-m", `merge queue: #${entry.pull.number}`],
      { cwd: dir, env: IDENTITY },
    );
    if (!commit.ok) continue;
    const commitOid = commit.value.trim();
    steps.push({ entry, baseOid: tipOid, treeOid: merged.value.treeOid, commitOid });
    tipOid = commitOid;
    treeOid = merged.value.treeOid;
  }
  return { dir, baseOid, baseTreeOid, steps, tipOid, treeOid };
}
