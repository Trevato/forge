/**
 * The proof before the line (#7616). A pull's own check is the fast tier —
 * the tests its change reaches — while the merge queue's gate runs every
 * test, so a pull that broke a test its change never reached was found in
 * the queue, where one red costs a batch of up to eight. Before a pull
 * joins the line it is proved: the full gate (the same command,
 * environment and sharding — `ChecksHandle.prove` is the gate's own run)
 * on its head squashed onto the base's tip, the tree a batch of one would
 * gate. Green is kept in the decision ledger as a `proof` row with the head
 * and the base it was proved on, and admits the pull; red is told to the
 * pull with its failing tests named and holds it, at no cost to any batch.
 *
 * A proof goes stale once the base has moved more than `STALE_LANDINGS`
 * first-parent commits past the base it was proved on, or off it: the pull
 * is proved again before it joins, and one already waiting in the line is
 * left out of its next batch (`Queued.proven`) and proved again. A red
 * proof stands for its head until a push, or until the base has moved that
 * far — a red that was main's may be gone from a newer main.
 *
 * A proof is a run (#7706, `core/proof_runs.ts`, kind `proof`): waiting for
 * a check slot, running, then green, red or cut off. A proof that cannot
 * start (no slot spare, the head does not merge onto the base tip) says why
 * on the pull, once per head. A proof cut off (the forge stopping, the Job
 * lost) is no verdict: its run ends cut off, the pull is told, and the next
 * sweep proves it again. One that has not answered by the gate's own
 * deadline (`GATE_DEADLINE_MS`, #3430) is cut off the same way, its run
 * aborted, so a hung proof never holds its pull or a check slot for good.
 * One proof runs at a time per pull, and only one beyond the first while no
 * check slot is spare.
 */

import type { Database } from "bun:sqlite";
import { latestDecision, recordDecision } from "../core/decisions.ts";
import { cutOffBefore, cutSummary, endedBefore, endProofRun, latestProofRun, openProofRun, startProofRun } from "../core/proof_runs.ts";
import type { Pull } from "../core/pulls.ts";
import { STOPPED_SUMMARY } from "../core/runs.ts";
import { runGit } from "../git/env.ts";
import { mergeable } from "../git/merge.ts";
import { GATE_DEADLINE_MS } from "./queue.ts";
import type { LandVerdict } from "./tiers.ts";

/**
 * How far the base may move past a proof before it is proved again: two
 * full batches (`MAX_CANDIDATE` is 8), so a pull proved as it joined is
 * still proved while the two batches ahead of it land, and one that waited
 * longer than that is proved on what main has become.
 */
export const STALE_LANDINGS = 16;

/** A red proof is tried again this long after it, in case what failed was not the pull. */
export const RED_PROOF_RETRY_MS = 30 * 60_000;

/** What a proof found: the head it ran on, the base tip it was squashed onto, and whether it was green. */
export interface Proof {
  readonly head: string;
  readonly base: string;
  readonly green: boolean;
  /** When the ledger kept it. */
  readonly at?: string;
}

/** Where a pull stands before the line. */
export type Standing = "proved" | "proving" | "red" | "unproved";

/** The proofs running now: pull id → the head being proved. */
const proving = new Map<string, string>();

/** How many proofs are running on this forge: they hold check slots as gates do. */
export function proofsInFlight(): number {
  return proving.size;
}

/** The newest proof of a pull, read off the ledger; undefined when it has none. */
export function proofOf(db: Database, pullId: string): Proof | undefined {
  const row = latestDecision(db, pullId, "proof");
  if (row === undefined) return undefined;
  const state = row.state;
  if (typeof state !== "object" || state === null) return undefined;
  const { head, base } = state as Record<string, unknown>;
  if (typeof head !== "string" || typeof base !== "string") return undefined;
  return { head, base, green: row.answer === "green", at: row.createdAt };
}

/** Keep a proof's verdict on the ledger. */
export function keepProof(db: Database, repoId: string, pullId: string, proof: Proof): void {
  recordDecision(db, {
    kind: "proof",
    repoId,
    issueId: pullId,
    state: { head: proof.head, base: proof.base },
    answer: proof.green ? "green" : "red",
    p: 1,
    by: "rule",
    ms: 0,
  });
}

/**
 * First-parent commits from `from` to `to`: the landings since a proof.
 * Undefined when `from` is not behind `to` (the base was rewritten) or git
 * cannot say.
 */
export async function landingsSince(dir: string, from: string, to: string): Promise<number | undefined> {
  if (from === to) return 0;
  const behind = await runGit(["merge-base", "--is-ancestor", from, to], { cwd: dir });
  if (!behind.ok) return undefined;
  const count = await runGit(["rev-list", "--count", "--first-parent", `${from}..${to}`], { cwd: dir });
  if (!count.ok) return undefined;
  const n = Number(count.value.trim());
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/** A proof still holds on `tip`: the base has moved no more than `STALE_LANDINGS` past it. */
export async function current(dir: string, proof: Proof, tip: string): Promise<boolean> {
  const moved = await landingsSince(dir, proof.base, tip);
  return moved !== undefined && moved <= STALE_LANDINGS;
}

/** Where `pull` at its head stands on the base tip `tip`. */
export async function standing(
  db: Database,
  dir: string,
  pull: Pull,
  tip: string,
  now: number = Date.now(),
): Promise<Standing> {
  if (proving.get(pull.id) === pull.headOid) return "proving";
  const proof = proofOf(db, pull.id);
  if (proof === undefined || proof.head !== pull.headOid) return "unproved";
  if (!(await current(dir, proof, tip))) return "unproved";
  if (proof.green) return "proved";
  // A red says something only about the main it ran on, and for a while: a flake or a
  // broken gate must not strand a pull until its next push.
  const fresh = proof.at !== undefined && now - Date.parse(proof.at) < RED_PROOF_RETRY_MS;
  return proof.base === tip && fresh ? "red" : "unproved";
}

/** The pull's head squashed onto `tip`, as a commit the gate can run on; undefined when it does not merge. */
export async function proofCommit(dir: string, tip: string, pull: Pull): Promise<string | undefined> {
  const merged = await mergeable(dir, tip, pull.headOid);
  if (!merged.ok) return undefined;
  const commit = await runGit(
    ["commit-tree", merged.value.treeOid, "-p", tip, "-m", `proof: #${pull.number}`],
    { cwd: dir, env: IDENTITY },
  );
  return commit.ok ? commit.value.trim() : undefined;
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "forge",
  GIT_AUTHOR_EMAIL: "forge@localhost",
  GIT_COMMITTER_NAME: "forge",
  GIT_COMMITTER_EMAIL: "forge@localhost",
};

/** What starting a proof needs: where, on what, how to run the gate, and what to do with its answer. */
export interface ProofRun {
  readonly db: Database;
  readonly repoId: string;
  readonly pull: Pull;
  readonly dir: string;
  readonly tip: string;
  /** The full gate on a commit; `signal` aborts at the deadline, and the run should stop. */
  readonly run: (commitOid: string, signal: AbortSignal) => Promise<LandVerdict>;
  /** Check slots spare now; a second proof starts only on one. */
  readonly room: () => number;
  /** The proof was judged and kept. */
  readonly done: (proof: Proof, verdict: LandVerdict) => void;
  /** Said to the pull: a proof that cannot start, or was cut off. Once per head and reason. */
  readonly told?: (words: string) => void;
  /** How long the proof may run before it is cut off; the gate's deadline unless a test shortens it. */
  readonly deadlineMs?: number;
}

/** Why a proof waits or cannot start: the run's summary, and what the pull is told. */
export const WAIT_SLOT = "no check slot is spare";
export const WAIT_MERGE = "cannot start: the head does not merge onto the base tip";

/**
 * Say once per head why the proof has not started: a waiting run (`queued`)
 * for no slot, a failed one for a head that does not merge.
 */
function refuse(x: ProofRun, summary: string, words: string): void {
  const last = latestProofRun(x.db, x.pull.id);
  // Once per head: any run of it that already waited or failed for this reason was told.
  const state = summary === WAIT_SLOT ? "queued" : "failed";
  const told = endedBefore(x.db, x.pull.id, x.pull.headOid, state, summary);
  if (told && last?.commitOid === x.pull.headOid && last.summary === summary) return;
  if (summary === WAIT_SLOT) {
    openProofRun(x.db, { repoId: x.repoId, pullId: x.pull.id, head: x.pull.headOid, base: x.tip, state: "queued", summary });
  } else if (last !== undefined && last.state === "queued" && last.commitOid === x.pull.headOid) {
    endProofRun(x.db, last.id, "failed", summary);
  } else {
    const run = openProofRun(x.db, { repoId: x.repoId, pullId: x.pull.id, head: x.pull.headOid, base: x.tip, state: "running", summary });
    endProofRun(x.db, run.id, "failed", summary);
  }
  if (!told) x.told?.(words);
}

/** End a proof run cut off for `reason`, and tell the pull once per head and reason. */
function cutOff(x: ProofRun, runId: string, head: string, reason: string): void {
  const told = cutOffBefore(x.db, x.pull.id, head, reason, runId);
  endProofRun(x.db, runId, "cancelled", cutSummary(reason));
  if (!told && head === x.pull.headOid) x.told?.(cutWords(reason));
}

/** What a pull is told when its proof was cut off. */
const cutWords = (why: string): string =>
  `The full-suite proof of this head was cut off (${why}), so it has no verdict. It is proved again on the next sweep.`;

/**
 * Start proving `pull` on `tip` beside the caller, which does not wait.
 * False when it did not start: a proof of this head runs already, no slot
 * is free, or the head does not merge onto the tip. The last two are kept
 * as a run and told to the pull, once per head.
 */
export async function startProof(x: ProofRun): Promise<boolean> {
  if (proving.has(x.pull.id)) return false;
  // A run still `running` that this process does not hold was cut off by a restart.
  const orphan = latestProofRun(x.db, x.pull.id);
  if (orphan?.state === "running") {
    cutOff(x, orphan.id, orphan.commitOid, STOPPED_SUMMARY);
  }
  if (proving.size > 0 && x.room() <= 0) {
    refuse(
      x,
      WAIT_SLOT,
      `The full-suite proof of this head is waiting: ${WAIT_SLOT}. It starts when one frees.`,
    );
    return false;
  }
  proving.set(x.pull.id, x.pull.headOid);
  let commit: string | undefined;
  try {
    commit = await proofCommit(x.dir, x.tip, x.pull);
  } catch {
    commit = undefined;
  }
  if (commit === undefined) {
    proving.delete(x.pull.id);
    refuse(
      x,
      WAIT_MERGE,
      `The full-suite proof cannot start: this head does not merge onto ${x.pull.baseBranch} (${x.tip.slice(0, 7)}). Bring the pull up to date with the base and push; it is proved then.`,
    );
    return false;
  }
  const waiting = latestProofRun(x.db, x.pull.id);
  let runId: string;
  if (waiting?.state === "queued" && waiting.commitOid === x.pull.headOid) {
    runId = waiting.id;
    startProofRun(x.db, runId, x.tip);
  } else {
    runId = openProofRun(x.db, { repoId: x.repoId, pullId: x.pull.id, head: x.pull.headOid, base: x.tip, state: "running", summary: "" }).id;
  }
  const abandon = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline = false;
  // A proof that never answers is cut off at the deadline: no verdict (#3430).
  const cut = new Promise<LandVerdict>((resolve) => {
    timer = setTimeout(() => {
      deadline = true;
      abandon.abort();
      resolve({ lands: false, interrupted: true });
    }, x.deadlineMs ?? GATE_DEADLINE_MS);
  });
  void Promise.race([x.run(commit, abandon.signal), cut])
    .then(
      (verdict) => {
        // Released before the answer is acted on: `done` may sweep, and must not read it as running.
        clearTimeout(timer);
        proving.delete(x.pull.id);
        if ("interrupted" in verdict) {
          cutOff(x, runId, x.pull.headOid, deadline ? "at the deadline" : "the gate was interrupted");
          return;
        }
        const proof: Proof = { head: x.pull.headOid, base: x.tip, green: verdict.lands };
        keepProof(x.db, x.repoId, x.pull.id, proof);
        endProofRun(x.db, runId, verdict.lands ? "ok" : "failed", verdict.lands ? "green" : "red");
        x.done(proof, verdict);
      },
      () => {
        clearTimeout(timer);
        proving.delete(x.pull.id);
        cutOff(x, runId, x.pull.headOid, "the gate failed to answer");
      },
    );
  return true;
}

/** Forget the proofs running: a test's reset. */
export function resetProofsForTest(): void {
  proving.clear();
}

/** What a red proof tells the pull: the base it was squashed onto, the tests that failed, and the gate's log. */
export function proofRedWords(branch: string, base: string, red: Extract<LandVerdict, { reopen: true }>): string {
  const names = (red.tests?.failing ?? []).map((t) => `- ${t.name}`);
  const more = (red.tests?.failed ?? names.length) - names.length;
  const log = /The gate's log: (\S+)/.exec(red.comment)?.[1];
  return [
    `The full suite on this head squashed onto ${branch} (${base.slice(0, 7)}) was red, so the pull has not joined the merge queue.`,
    names.length === 0 ? "It named no test (a type error, a timeout, a setup step)." : `Red tests:\n${names.join("\n")}${more > 0 ? `\n- and ${more} more` : ""}`,
    ...(log === undefined ? [] : [`The gate's log: ${log}`]),
    "It is proved again on a push.",
  ].join("\n\n");
}
