/**
 * The full tier on land (#1198): before a green pull is merged, the whole
 * gate runs once on what the merge would be — the pull with its base — so
 * what the fast tier left out is judged at last. Green lands; red names the
 * tests (`landVerdict`) and teaches the pull's next fast run.
 */

import type { App } from "../app.ts";
import { parseCheck } from "../apps/manifest.ts";
import { readFileAt } from "../apps/checkout.ts";
import { addComment } from "../actions/issues.ts";
import type { User } from "../core/users.ts";
import { getIssueById } from "../core/issues.ts";
import { repoDir } from "../git/repos.ts";
import {
  checkoutRelease,
  DEFAULT_KEEP,
  preflightRelease,
  type Verdict,
  pruneReleases,
} from "../release/checkout.ts";
import { beginSwap, endSwap, handover, startRelease } from "../release/swap.ts";
import { running } from "../kernel/version.ts";
import { recordRelease, type Release } from "../release/record.ts";
import { scanHold } from "../release/scan_hold.ts";
import type { Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { failuresOf } from "./failures.ts";
import { keepForgeGate } from "./gate_last.ts";
import { gateReason } from "./gate_reason.ts";
import { gateTests } from "./gate_tests.ts";
import { keepGateLog } from "./gate_log.ts";
import { GATE_DEADLINE_MS, type GateRecord } from "./queue.ts";
import { gateRecorded, gateRunning, recordedVerdict } from "./queue_store.ts";
import { checksFor, type GateDone } from "./service.ts";
import { landVerdict, type LandVerdict } from "./tiers.ts";
import { ownProbeHeaders } from "../kernel/probe.ts";

/**
 * The full gate, once, on a commit that is what main would become — one
 * pull with its base, or the merge queue's candidate of several (#2036).
 * `pull` is the one the gate is asked for: where the objects are and which
 * base branch's check is run. The manifest is the candidate's own.
 * `signal` is the queue abandoning the gate at its deadline (#3430).
 */
export async function gateCandidate(
  app: App,
  repo: Repo,
  pull: Pull,
  dir: string,
  commitOid: string,
  signal?: AbortSignal,
): Promise<LandVerdict> {
  const checks = checksFor(app);
  if (checks === undefined) return { lands: true };
  const [forgeJson, packageJson] = await Promise.all([
    readFileAt(dir, commitOid, "forge.json"),
    readFileAt(dir, commitOid, "package.json"),
  ]);
  const declared = parseCheck(forgeJson, packageJson);
  if (!declared.ok || declared.value === undefined || declared.value.fast === null)
    return { lands: true };
  return gateVerdict(app, repo, commitOid, await checks.gate(repo, pull, commitOid, signal));
}

/** How long the queue waits between reads of a gate another forge runs (#6611). */
export const ADOPT_POLL_MS = 5_000;

/**
 * A recorded merge-queue gate the check lane still runs (#6611), adopted:
 * this forge's own run of its tip, waited on; or the forge before this one
 * still draining it, whose verdict comes into the record. Undefined when
 * the run is gone and the queue must gate the candidate again.
 */
export async function adoptGate(
  app: App,
  repo: Repo,
  record: GateRecord,
  signal: AbortSignal,
  pollMs = ADOPT_POLL_MS,
): Promise<LandVerdict | undefined> {
  const here = checksFor(app)?.adopt?.(record.tipOid);
  if (here !== undefined) {
    const done = await here;
    return done.interrupted === true ? undefined : gateVerdict(app, repo, record.tipOid, done);
  }
  // The trace closes a moment before the verdict is kept: read once more after it.
  let open = gateRunning(app.db, record.tipOid, GATE_DEADLINE_MS);
  if (!open) return undefined;
  while (!signal.aborted) {
    await Bun.sleep(pollMs);
    // The record gone: the forge that ran it acted on its verdict itself
    // (its queue was not stopped). No verdict here, and nothing to gate again.
    if (!gateRecorded(app.db, record.id)) return { lands: false, interrupted: true };
    const verdict = recordedVerdict(app.db, record.id);
    if (verdict !== undefined || !open) return verdict;
    open = gateRunning(app.db, record.tipOid, GATE_DEADLINE_MS);
  }
  return undefined;
}

/** What the lane's answer on `commitOid` decides: its log kept, its red named. */
function gateVerdict(app: App, repo: Repo, commitOid: string, done: GateDone, last = true): LandVerdict {
  // Cut off, not judged: no verdict, and not the gate log a red reads (#3155).
  if (done.interrupted === true) return { lands: false, interrupted: true };
  if (last) keepForgeGate(app.config.dataDir, app.config.forgeRepo, `${repo.ownerName}/${repo.name}`, done.lines);
  const slug = `${repo.ownerName}/${repo.name}`;
  const kept = keepGateLog(app.config.dataDir, slug, commitOid, done.ok, done.lines, Date.now());
  const failed = failuresOf(done.lines);
  const link = kept === undefined ? undefined : `/api/v1/repos/${slug}/gates/${kept}/log`;
  // Why it went red, said in the queue's log and read by its search (#5276).
  const reason = done.ok ? undefined : gateReason(done.stage ?? "check", done.error, done.lines, failed.tests.length);
  return landVerdict(done.ok, failed.tests, failed.files, link, reason, done.ok ? undefined : gateTests(done.lines));
}

/**
 * A pull landed on the forge's own repository (`FORGE_REPO`): write the
 * landed tree to `releases/<sha>/`, preflight it, record the verdict. A red
 * preflight is one line in the log and a comment on the landed pull. Any
 * other repository is untouched (`undefined`). Nothing is swapped.
 */
export function releaseOnLand(
  app: App,
  by: User,
  repo: Repo,
  pull: Pull,
  sha: string,
): Promise<Release | undefined> {
  const run = turn.then(() => cut(app, by, repo, pull, sha));
  turn = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * The preflight copies the live database while the crew writes, so a torn copy
 * can read red. A red is asked again once; only a second red is believed.
 */
async function preflightTrusted(dir: string, dataDir: string): Promise<Verdict> {
  const first = await preflightRelease(dir, dataDir);
  return first.ok ? first : preflightRelease(dir, dataDir);
}

/** Landings queue behind one another: two checkouts never share releases/. */
let turn: Promise<void> = Promise.resolve();

async function cut(
  app: App,
  by: User,
  repo: Repo,
  pull: Pull,
  sha: string,
): Promise<Release | undefined> {
  if (app.config.forgeRepo !== `${repo.ownerName}/${repo.name}`) return undefined;
  const dataDir = app.config.dataDir;
  const out = await checkoutRelease(
    dataDir,
    repoDir(app.reposRoot, repo.ownerName, repo.name),
    sha,
  );
  const verdict = out.ok
    ? await preflightTrusted(out.value, dataDir)
    : { ok: false, line: `checkout failed: ${out.error}` };
  const release = recordRelease(app.db, {
    sha,
    repoId: repo.id,
    pullNumber: pull.number,
    ok: verdict.ok,
    line: verdict.line,
  });
  pruneReleases(dataDir, app.config.releasesKeep ?? DEFAULT_KEEP, sha);
  if (!verdict.ok) {
    app.log.warn("release preflight failed", {
      sha: sha.slice(0, 12),
      pull: pull.number,
      line: verdict.line,
    });
    const landed = getIssueById(app.db, pull.id) ?? pull;
    addComment(
      app,
      by,
      repo,
      landed,
      `The landed tree ${sha.slice(0, 12)} failed its preflight, so it will not be released: ${verdict.line}`,
    );
  }
  // A new high finding holds the release until a person accepts it (#9593).
  const hold = verdict.ok && out.ok ? await scanHold(app, repo, sha) : { held: false as const };
  if (hold.held) {
    app.log.warn("release held by code scanning", { sha: sha.slice(0, 12), pull: pull.number, findings: hold.count });
    addComment(app, by, repo, getIssueById(app.db, pull.id) ?? pull, `The landed tree ${sha.slice(0, 12)} is not released: ${hold.line}.`);
  }
  if (verdict.ok && out.ok && !hold.held) await swapIn(app, by, repo, pull, sha, out.value);
  return release;
}

/**
 * Hand the port to a green release and drain this process, once the new one
 * has read healthy. Off unless `FORGE_SELF_SWAP=1`. A release that does not
 * come up is stopped, the old keeps serving, and the lane and the landed pull
 * are told.
 */
async function swapIn(
  app: App,
  by: User,
  repo: Repo,
  pull: Pull,
  sha: string,
  dir: string,
): Promise<void> {
  const drain = handover.drain;
  const port = app.config.port ?? 0;
  if (app.config.selfSwap !== true || drain === undefined || port <= 0) return;
  if (running().commit === sha) return;
  const turn = beginSwap();
  if (!turn.ok) {
    app.log.warn("release not swapped in", { sha: sha.slice(0, 12), line: turn.line });
    if (turn.tell)
      addComment(
        app,
        by,
        repo,
        getIssueById(app.db, pull.id) ?? pull,
        `The landed tree ${sha.slice(0, 12)} did not swap in: ${turn.line}. The running process keeps serving.`,
      );
    return;
  }
  const swapped = await startRelease({ dir, sha, port, env: process.env, probe: ownProbeHeaders(app.config.dataDir),
    ...(app.config.swapBudgetMs === undefined ? {} : { budgetMs: app.config.swapBudgetMs }),
  });
  endSwap(swapped.ok);
  if (swapped.ok) {
    app.log.info("release swapped in; draining this process", { sha: sha.slice(0, 12), pid: swapped.pid });
    drain();
    return;
  }
  app.log.error("release swap failed; the old process keeps serving", {
    sha: sha.slice(0, 12),
    pull: pull.number,
    line: swapped.line,
  });
  addComment(
    app,
    by,
    repo,
    getIssueById(app.db, pull.id) ?? pull,
    `The landed tree ${sha.slice(0, 12)} did not swap in: ${swapped.line}. The running process keeps serving.`,
  );
}
