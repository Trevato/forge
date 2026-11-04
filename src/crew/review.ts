/**
 * Who reviews a pull, and sending it to them.
 *
 * A crew may carry more than one reviewer: one who reads for the
 * experience, one who reads for security. A pull that touches the
 * security-bearing paths goes to the second; every other pull goes to the
 * first. Which reviewer watches security is read from what the agent says
 * it is — the first paragraph of its brief, before the rules every brief
 * shares — so naming a reviewer is all it takes to give it the job.
 *
 * Every green head of a pull an agent wrote is sent, whatever the
 * repository's autonomy: the event sends it the moment its checks pass,
 * and the tick sweeps up any head the event missed. A review that does
 * not come back is sent once more; after that it has lapsed (`reviewStage`).
 * An agent's pull never ships by lapse, nor in a repository with no
 * reviewer: it waits for a person, and says so where a person looks
 * (`waitsForPerson`, the asks). A person's own pull is not held for it.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { crewWithRole, type Agent } from "../core/agents.ts";
import { getHold, holdsFor, lastReleasesFor } from "../core/holds.ts";
import { getIssueById, LIST_LIMIT_MAX } from "../core/issues.ts";
import { listPulls, pullDiff, type Pull, pullDir} from "../core/pulls.ts";
import { getRepoById, PILLAR_MAX, type Repo } from "../core/repos.ts";
import { teamsOfPull, teamVerdicts } from "../core/issue_teams.ts";
import { reviewSummariesFor, reviewSummary } from "../core/reviews.ts";
import { checksForHead } from "../core/runs.ts";
import { getTeam } from "../core/teams.ts";
import { createLog } from "../kernel/log.ts";
import { guestWaits } from "../origins/guest.ts";
import { reviewerPaused } from "./reviewer_paused.ts";
import { queueAgentRun } from "./dispatch.ts";
import { type Handover, handoverOf, handoversOf } from "./guard.ts";

const log = createLog("crew");

/** Paths whose change is the security reviewer's to read: sign-in, tokens, secrets, the sandbox, the HTTP edge. */
const SECURITY_PATH = /auth|token|secret|sandbox|http/i;

export const touchesSecurity = (paths: readonly string[]): boolean =>
  paths.some((p) => SECURITY_PATH.test(p));

/** Paths whose change is a page's look: a page, the ui vocabulary or the style. */
export const touchesDesign = (paths: readonly string[]): boolean =>
  paths.some((p) => p.startsWith("src/web/"));

/** What an agent says it is: its brief's first paragraph. */
const focusOf = (brief: string): string =>
  brief.trim().split(/\n\s*\n/)[0] ?? "";

/** Whether this reviewer says it reads for security. */
export const watchesSecurity = (agent: Agent): boolean =>
  /\bsecurity\b/i.test(focusOf(agent.brief));

/** Review runs a design reviewer holds in flight before a `src/web/` pull spills to the least busy. */
export const REVIEW_DESIGN_INFLIGHT = 2;

/** Review runs in flight (queued or running) on one repository: what the reviewer's slots bound. */
export function reviewsInFlight(db: Database, repoId: string): number {
  return (
    db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM run WHERE repo_id = ?1 AND kind = 'agent'
           AND reason = 'review' AND state IN ('queued','running')`,
      )
      .get(repoId)?.n ?? 0
  );
}

/**
 * Review runs in flight (queued or running) per reviewer, by user id; an idle
 * reviewer is absent. `publicOnly` counts only runs on public repositories,
 * for a reader who must not learn what runs on a private one; routing leaves
 * it off.
 */
export function reviewLoad(db: Database, publicOnly = false): Map<string, number> {
  const load = new Map<string, number>();
  for (const r of db
    .query<{ actor_id: string; n: number }, []>(
      `SELECT run.actor_id, COUNT(*) AS n FROM run
        ${publicOnly ? "JOIN issue ON issue.id = run.issue_id JOIN repo ON repo.id = issue.repo_id" : ""}
        WHERE run.kind = 'agent' AND run.reason = 'review' AND run.actor_id IS NOT NULL
          AND run.state IN ('queued','running')
          ${publicOnly ? "AND repo.visibility = 'public'" : ""}
        GROUP BY run.actor_id`,
    )
    .all())
    load.set(r.actor_id, r.n);
  return load;
}

/**
 * The reviewer for a change to these paths, the least busy by `load`
 * (`reviewLoad`). A security change goes only to a security reviewer
 * (least busy among them) when the crew has one. Any other goes to the
 * least busy reviewer, a tie to the experience reviewer, then crew order.
 * A change to `src/web/` that is not security's goes first to a reviewer
 * on the design team (`design`, user ids) while it has fewer than
 * `REVIEW_DESIGN_INFLIGHT` in flight, then spills to the least busy.
 */
export function pickReviewer(
  reviewers: readonly Agent[],
  paths: readonly string[],
  design: readonly string[] = [],
  load: ReadonlyMap<string, number> = new Map(),
): Agent | undefined {
  const busy = (r: Agent) => load.get(r.user.id) ?? 0;
  const leastBusy = (from: readonly Agent[]): Agent | undefined =>
    from.reduce<Agent | undefined>(
      (best, r) =>
        best === undefined ||
        busy(r) < busy(best) ||
        (busy(r) === busy(best) && watchesSecurity(best) && !watchesSecurity(r))
          ? r
          : best,
      undefined,
    );
  const security = reviewers.filter(watchesSecurity);
  if (touchesSecurity(paths)) return leastBusy(security) ?? leastBusy(reviewers);
  if (touchesDesign(paths)) {
    const member = leastBusy(
      reviewers.filter((r) => design.includes(r.user.id) && busy(r) < REVIEW_DESIGN_INFLIGHT),
    );
    if (member !== undefined) return member;
  }
  return leastBusy(reviewers);
}

/** The crew's reviewers on a repository. */
export const reviewersOf = (db: Database, repoId: string): Agent[] =>
  reviewersForRepos(db, [repoId]).get(repoId) ?? [];

/** `reviewersOf` for many repositories at once, by repo; one with none is absent. */
export const reviewersForRepos = (db: Database, repoIds: readonly string[]): Map<string, Agent[]> =>
  crewWithRole(db, repoIds, "reviewer");

/** Whether every check on the pull's head ran and passed. */
export function greenHead(db: Database, pull: Pull): boolean {
  const checks = checksForHead(db, pull.id, pull.headOid);
  return checks.length > 0 && checks.every((c) => c.state === "ok");
}

/** How long a review may take from being queued before it is sent again. */
export const REVIEW_WAIT_MS = 20 * 60_000;
/** How long a green head waits for a verdict at most, however the attempts went. */
export const REVIEW_LAPSE_MS = 60 * 60_000;
/** Review runs one head gets: the first, and one more. */
const REVIEW_TRIES = 2;

/** One review run sent for a head: when it was queued, and whether it is still out. */
export interface ReviewAttempt {
  readonly createdAt: string;
  readonly active: boolean;
  /** The reviewer the run was sent to. */
  readonly reviewerId?: string | null;
}

/**
 * A head that went green this long after the lapse, with no review yet,
 * is still sent once, late; past it, nothing was ever going to send.
 */
const LATE_SEND_MS = REVIEW_LAPSE_MS;

/**
 * Where review stands on a green head that has no verdict: `send` a
 * review run (the first, or the one retry), `wait` for the one that is
 * out, or `lapsed` — two runs came back with nothing, or the head has
 * waited past the lapse — and the pull goes on without one. A missing
 * reviewer must never hold a pull silently.
 */
export function reviewStage(
  greenAt: string,
  attempts: readonly ReviewAttempt[],
  now: Date,
): "send" | "wait" | "lapsed" {
  const at = now.getTime();
  if (at - Date.parse(greenAt) >= REVIEW_LAPSE_MS) return "lapsed";
  const last = attempts.at(-1);
  if (last === undefined) return "send";
  const fresh = at - Date.parse(last.createdAt) < REVIEW_WAIT_MS;
  if (last.active && fresh) return "wait";
  return attempts.length < REVIEW_TRIES ? "send" : "lapsed";
}

/**
 * When the pull's head first went green, and the review runs sent for it
 * since — read from the run table, so a restart forgets nothing.
 *
 * A hold stops this clock. Review is owed from when the head went green or
 * from when the pull was last let go, whichever is later, and only runs
 * sent since then count: a pull held past the lapse and then released is
 * sent to review like any newly green one, never landed as "lapsed".
 */
export function reviewAttempts(
  db: Database,
  pull: Pull,
): ReviewHistory | undefined {
  return reviewAttemptsFor(db, [pull]).get(pull.id);
}

/**
 * `reviewAttempts` for many pulls at once, by pull: each head's checks and
 * deploys, the releases and the review runs are one query per chunk each.
 * A pull whose head has not gone green is absent.
 */
export function reviewAttemptsFor(
  db: Database,
  pulls: readonly Pull[],
): Map<string, ReviewHistory> {
  const out = new Map<string, ReviewHistory>();
  const CHUNK = 400;
  for (let i = 0; i < pulls.length; i += CHUNK) {
    const batch = pulls.slice(i, i + CHUNK);
    const ids = batch.map((p) => p.id);
    const heads = db
      .query<
        { issue_id: string; kind: string; state: string; finished_at: string | null; created_at: string },
        string[]
      >(
        `WITH head (issue_id, oid) AS (VALUES ${batch.map((_, n) => `(?${2 * n + 1}, ?${2 * n + 2})`).join(",")})
         SELECT run.issue_id, run.kind, run.state, run.finished_at, run.created_at
           FROM run JOIN head ON head.issue_id = run.issue_id AND head.oid = run.commit_oid
          WHERE run.kind IN ('check','deploy')`,
      )
      .all(...batch.flatMap((p) => [p.id, p.headOid]));
    const released = lastReleasesFor(db, ids);
    const reviews = new Map<string, { createdAt: string; active: boolean; reviewerId: string | null }[]>();
    for (const r of db
      .query<{ issue_id: string; created_at: string; state: string; actor_id: string | null }, string[]>(
        `SELECT issue_id, created_at, state, actor_id FROM run
          WHERE kind = 'agent' AND reason = 'review'
            AND issue_id IN (${ids.map((_, n) => `?${n + 1}`).join(",")})
          ORDER BY created_at, id`,
      )
      .all(...ids)) {
      const attempt = {
        createdAt: r.created_at,
        active: r.state === "queued" || r.state === "running",
        reviewerId: r.actor_id,
      };
      const list = reviews.get(r.issue_id);
      if (list) list.push(attempt);
      else reviews.set(r.issue_id, [attempt]);
    }
    for (const pull of batch) {
      const runs = heads.filter((r) => r.issue_id === pull.id);
      // Review is owed from the check's green: a preview deploy finishes in
      // seconds, a check may queue for an hour. A deploy counts only where the
      // head has no check at all.
      const hasCheck = runs.some((r) => r.kind === "check");
      const greenRun = runs
        .filter((r) => r.kind === (hasCheck ? "check" : "deploy") && r.state === "ok" && r.finished_at !== null)
        .reduce<(typeof runs)[number] | undefined>(
          (first, r) => (first === undefined || r.finished_at! < first.finished_at! ? r : first),
          undefined,
        );
      if (greenRun === undefined) continue;
      const green = greenRun.finished_at!;
      const checkMs = hasCheck ? Date.parse(green) - Date.parse(greenRun.created_at) : 0;
      const release = released.get(pull.id);
      const since = release !== undefined && release > green ? release : green;
      const attempts = (reviews.get(pull.id) ?? []).filter((a) => a.createdAt >= since);
      const first = attempts[0];
      const lateAt =
        first !== undefined && Date.parse(first.createdAt) - Date.parse(since) >= REVIEW_LAPSE_MS
          ? first.createdAt
          : undefined;
      out.set(pull.id, { greenAt: since, attempts, lateAt, checkMinutes: Math.round(checkMs / 60_000) });
    }
  }
  return out;
}

/** What the run table says about review on a head. */
export interface ReviewHistory {
  readonly greenAt: string;
  readonly attempts: ReviewAttempt[];
  /** When the first review was sent, if it was sent past the lapse: the lapse clock restarts there. */
  readonly lateAt: string | undefined;
  /** How long the check took, from queued to green. */
  readonly checkMinutes: number;
}

/**
 * `reviewStage` for a history: a head that went green and was never sent
 * is sent once, late, before it lapses to a person; a review sent late
 * has the lapse counted from its sending.
 */
export function stageOf(
  history: ReviewHistory,
  now: Date,
): "send" | "wait" | "lapsed" | "late" {
  const age = now.getTime() - Date.parse(history.greenAt);
  if (history.attempts.length === 0 && age >= REVIEW_LAPSE_MS)
    return age < REVIEW_LAPSE_MS + LATE_SEND_MS ? "late" : "lapsed";
  return reviewStage(history.lateAt ?? history.greenAt, history.attempts, now);
}

/** Why an agent's green pull waits for a person, and since when. */
export interface ReviewWait {
  readonly why: "no reviewer" | "lapsed" | "rounds";
  /** When review became owed: the head went green, or the pull was let go. */
  readonly since: string;
  /** Minutes the check took, when the review was sent late because of it. */
  readonly lateCheckMinutes?: number;
}

/** Where review stands on an agent's green pull: who it waits for, if anyone, and its history. */
export interface ReviewWaits {
  /** The crew reviewer it waits for, by name (`waitsForReviewer`). */
  readonly reviewer: string | undefined;
  /** Why it waits for a person, and since when (`waitsForPerson`). */
  readonly person: ReviewWait | undefined;
  /** The review runs sent for its head (`reviewAttempts`). */
  readonly history: ReviewHistory | undefined;
}

/**
 * Whether this agent's green pull now waits for a person's review: its
 * crew has no reviewer, or the review it was sent lapsed (asked twice, or
 * past the lapse). Undefined while a review is out or due, once a verdict
 * is on the head, while a person holds it, or for a person's own pull —
 * which is never held for review. One rule for the landing gate and for
 * what needs you, read from the tables alone.
 */
export function waitsForPerson(
  db: Database,
  repoId: string,
  pull: Pull,
  now = new Date(),
): ReviewWait | undefined {
  return waitsOne(db, repoId, pull, now)?.person;
}

/**
 * The reviewer an agent's green pull is waiting for, by name: a reviewer is
 * on the crew, no verdict is on the head, and the review is neither lapsed
 * nor handed over (`waitsForPerson` is exactly the rest). Undefined once a
 * verdict lands, while a person holds it, or for a person's own pull — so
 * the pull is the crew's to wait on, and becomes the owner's the moment
 * this goes undefined.
 */
export function waitsForReviewer(
  db: Database,
  repoId: string,
  pull: Pull,
  now = new Date(),
): string | undefined {
  return waitsOne(db, repoId, pull, now)?.reviewer;
}

function waitsOne(db: Database, repoId: string, pull: Pull, now: Date): ReviewWaits | undefined {
  if (!pull.authorIsAgent) return undefined;
  const repo = getRepoById(db, repoId);
  return repo ? reviewWaitsFor(db, [{ repo, pull }], now).get(pull.id) : undefined;
}

/**
 * `waitsForPerson`, `waitsForReviewer` and `reviewAttempts` for many pulls
 * at once, by pull, by the one rule: holds, verdicts, hand-overs, review
 * runs and reviewers are each read once for the set, and only for the
 * pulls still in question after the read before. A person's pull, a held
 * one, or one with a verdict on its head waits for nobody, and is absent.
 * A caller that has already read these pulls' hand-overs (`handoversOf`)
 * hands them in, and they are not read again.
 */
export function reviewWaitsFor(
  db: Database,
  pulls: readonly { readonly repo: Repo; readonly pull: Pull }[],
  now = new Date(),
  handovers?: ReadonlyMap<string, Handover>,
): Map<string, ReviewWaits> {
  const out = new Map<string, ReviewWaits>();
  const agents = pulls.filter((p) => p.pull.authorIsAgent);
  const held = holdsFor(db, agents.map((p) => p.pull.id));
  const unheld = agents.filter((p) => !held.has(p.pull.id));
  const seen = reviewSummariesFor(db, unheld.map((p) => p.pull));
  // A verdict on the head is the gate's answer: nobody waits.
  const open = unheld.filter((p) => {
    const s = seen.get(p.pull.id)!;
    return s.approvals === 0 && s.changesRequested === 0;
  });
  // The crew's review loop is spent: the one rule is `handoverOf`
  // (`guard.ts`), so the card, the thread note and the held state cannot
  // answer differently.
  const over = handovers ?? handoversOf(db, open.map((p) => ({ id: p.pull.id, repo: p.repo })));
  const histories = reviewAttemptsFor(db, open.map((p) => p.pull));
  const reviewers = reviewersForRepos(db, open.map((p) => p.repo.id));
  for (const { repo, pull } of open) {
    const handover = over.get(pull.id);
    const history = histories.get(pull.id);
    const crew = reviewers.get(repo.id) ?? [];
    const stage = history === undefined ? undefined : stageOf(history, now);
    const person: ReviewWait | undefined =
      handover !== undefined
        ? { why: "rounds", since: handover.at }
        : history === undefined
          ? undefined
          : crew.length === 0
            ? { why: "no reviewer", since: history.greenAt }
            : stage === "lapsed"
              ? {
                  why: "lapsed",
                  since: history.greenAt,
                  ...(history.lateAt === undefined
                    ? {}
                    : { lateCheckMinutes: history.checkMinutes }),
                }
              : undefined;
    const sent = history?.attempts.at(-1)?.reviewerId;
    const reviewer =
      crew.length === 0 || handover !== undefined || history === undefined || stage === "lapsed"
        ? undefined
        : (crew.find((r) => r.user.id === sent) ?? crew[0]!).user.username;
    out.set(pull.id, { reviewer, person, history });
  }
  return out;
}

/**
 * Whether the crew's review loop on this agent pull is spent: the one rule
 * is `handoverOf` (`guard.ts`), so the card, the thread note and the held
 * state cannot answer differently.
 */
function handedOver(db: Database, repoId: string, pull: Pull): Handover | undefined {
  if (!pull.authorIsAgent) return undefined;
  const repo = getRepoById(db, repoId);
  return repo ? handoverOf(db, repo, pull.id) : undefined;
}

/**
 * Move review along on this green head: send it to the right reviewer
 * when it is due (`reviewStage`), and say where it stands. `none` when
 * there is nothing to wait for — no reviewer on the crew — and `done`
 * when a verdict is on the head. A run the pull's builder still has open
 * does not stop a send — the review queues behind it. `held` when a person
 * holds the pull: nothing is sent, whoever asks. A head pushed over a
 * stale "changes requested" (`stale`) is owed its review however long it
 * has been green: one that was never sent is sent, as in an autonomous
 * repository (#2172).
 */
export async function sendToReview(
  app: App,
  repo: Repo,
  pull: Pull,
  now = new Date(),
  { stale = false }: { readonly stale?: boolean } = {},
): Promise<"none" | "done" | "sent" | "wait" | "lapsed" | "held"> {
  if (getHold(app.db, pull.id) !== undefined) return "held";
  const reviewers = reviewersOf(app.db, repo.id);
  // A paused reviewer reads like an empty seat: the pull waits for a person, and says so.
  if (reviewers.length === 0 || reviewerPaused(repo)) return "none";
  // A guest from another forge waits for a person's word before the crew
  // touches it (`origins/guest.ts`).
  if (guestWaits(app.db, pull)) return "held";
  // The reviewer's slots bound every route, the teams' too. The most (PILLAR_MAX) is no cap: the sweep already bounds what it sends.
  if (repo.reviewerSlots < PILLAR_MAX && reviewsInFlight(app.db, repo.id) >= repo.reviewerSlots) return "wait";
  if (teamsOfPull(app.db, pull).length > 0) {
    const sent = await sendToTeams(app, repo, reviewers, pull, now);
    if (sent !== undefined) return sent;
  }
  const seen = reviewSummary(app.db, pull.id, pull.headOid);
  if (seen.approvals > 0 || seen.changesRequested > 0) return "done";
  if (handedOver(app.db, repo.id, pull) !== undefined) return "held";
  const history = reviewAttempts(app.db, pull);
  if (history === undefined) return "wait";
  const stage = stageOf(history, now);
  // An autonomous repository sends a pull nobody reviewed whatever its age,
  // and so does any repository whose reviewer's verdict this head answers.
  const unreviewed =
    stage === "lapsed" &&
    history.attempts.length === 0 &&
    (repo.autonomy === "autonomous" || stale);
  if (stage === "wait" || (stage === "lapsed" && !unreviewed)) return stage;
  const late = stage === "late" || unreviewed;
  const issue = getIssueById(app.db, pull.id);
  if (!issue) return "wait";
  const { diff } = await pullDiff(
    await pullDir(app.db, app.reposRoot, repo, pull),
    pull,
  );
  // A review that came back with no verdict is sent to the other reviewer
  // when the crew has one; with only one, the same reviewer tries again.
  const failed = history.attempts.at(-1)?.reviewerId;
  const others = reviewers.filter((r) => r.user.id !== failed);
  const reviewer = pickReviewer(
    others.length > 0 ? others : reviewers,
    diff.files.map((f) => f.path),
    getTeam(app.db, "design")?.members,
    reviewLoad(app.db),
  );
  if (reviewer === undefined) return "wait";
  if (queueAgentRun(app, repo, issue, reviewer, "review") === undefined)
    return "wait";
  log.info("green; queued for review", {
    repo: `${repo.ownerName}/${repo.name}`,
    pull: pull.number,
    reviewer: reviewer.user.username,
    attempt: history.attempts.length + 1,
    ...(late ? { late: true, checkMinutes: history.checkMinutes } : {}),
  });
  return "sent";
}

/**
 * A pull whose issue names teams (#2681) is read once per team: each team
 * without a current verdict gets a review run for one of its members who
 * is a reviewer on the crew. A reviewer on both teams is sent one run, and
 * their verdict answers both. When no named team has a reviewer on this
 * crew (teams start empty) there is nobody to ask by team, and this answers
 * undefined: the ordinary single review goes ahead. A team that cannot be
 * asked while another can waits, and lapses to a person only with the
 * hour (`REVIEW_LAPSE_MS`), never at the first sweep.
 */
async function sendToTeams(
  app: App,
  repo: Repo,
  reviewers: readonly Agent[],
  pull: Pull,
  now: Date,
): Promise<"done" | "sent" | "wait" | "lapsed" | "held" | undefined> {
  const named = teamVerdicts(app.db, pull);
  const asks = (team: string): Agent[] => {
    const members = getTeam(app.db, team)?.members ?? [];
    return reviewers.filter((r) => members.includes(r.user.id));
  };
  if (!named.some((v) => asks(v.team).length > 0)) return undefined;
  const pending = named.filter((v) => v.state === undefined || v.stale);
  if (pending.length === 0) return "done";
  if (handedOver(app.db, repo.id, pull) !== undefined) return "held";
  const history = reviewAttempts(app.db, pull);
  const issue = getIssueById(app.db, pull.id);
  if (history === undefined || !issue) return "wait";
  if (now.getTime() - Date.parse(history.greenAt) >= REVIEW_LAPSE_MS) return "lapsed";
  let sent = false;
  // A reviewer on two pending teams is asked once: their verdict answers both.
  const asked = new Set<string>();
  for (const v of pending) {
    const mine = asks(v.team);
    if (mine.some((r) => asked.has(r.user.id))) continue;
    const tries = (r: Agent) => history.attempts.filter((a) => a.reviewerId === r.user.id);
    const open = mine.some((r) => {
      const last = tries(r).at(-1);
      return last?.active === true && now.getTime() - Date.parse(last.createdAt) < REVIEW_WAIT_MS;
    });
    if (open) continue;
    const reviewer = mine.find((r) => tries(r).length < REVIEW_TRIES);
    if (reviewer === undefined) continue;
    if (queueAgentRun(app, repo, issue, reviewer, "review", undefined, undefined, undefined, false, true) !== undefined) {
      sent = true;
      asked.add(reviewer.user.id);
      log.info("green; queued for team review", {
        repo: `${repo.ownerName}/${repo.name}`,
        pull: pull.number,
        team: v.team,
        reviewer: reviewer.user.username,
      });
    }
  }
  return sent ? "sent" : "wait";
}

/** Review runs one sweep pass sends at most: the tick stays bounded by sends, never by which pulls it looks at. */
export const SWEEP_SENDS = 10;

/** The last skip line said for a pull, so a stall is said once, not every tick. */
const said = new Map<string, string>();

/** Every open pull of a repository, oldest first, paged past the list cap. */
function openPullsOldestFirst(db: Database, repoId: string): Pull[] {
  const all: Pull[] = [];
  let cursor: number | undefined;
  for (;;) {
    const page = listPulls(db, repoId, {
      sealed: true,
      state: "open",
      limit: LIST_LIMIT_MAX,
      ...(cursor === undefined ? {} : { cursor }),
    });
    all.push(...page);
    if (page.length < LIST_LIMIT_MAX) break;
    cursor = page[page.length - 1]!.number;
  }
  return all.reverse();
}

/**
 * Every open, green pull an agent wrote that has no verdict on its head,
 * in every repository with a reviewer on its crew, sent to review, oldest
 * first — the pull that has waited longest is reached first. At most
 * `SWEEP_SENDS` go per pass; the rest wait for the next, never unseen. A
 * pull passed over for a reason gets one line saying why. The tick's net
 * under the check event; returns how many went.
 */
export async function sweepReviews(app: App): Promise<number> {
  const repoIds = app.db
    .query<{ repo_id: string }, []>(
      "SELECT DISTINCT repo_id FROM repo_crew WHERE role = 'reviewer'",
    )
    .all()
    .map((r) => r.repo_id);
  let queued = 0;
  const stalled = new Set<string>();
  for (const id of repoIds) {
    const repo = getRepoById(app.db, id);
    if (!repo) continue;
    for (const pull of openPullsOldestFirst(app.db, repo.id)) {
      if (queued >= SWEEP_SENDS) return forgetSettled(stalled, queued);
      if (!pull.authorIsAgent || !greenHead(app.db, pull)) continue;
      const result = await sendToReview(app, repo, pull);
      if (result === "sent") queued++;
      else if (result === "lapsed" || result === "wait") {
        stalled.add(pull.id);
        const key = `${pull.headOid}:${result}`;
        if (said.get(pull.id) === key) continue;
        said.set(pull.id, key);
        const since = reviewAttempts(app.db, pull)?.greenAt;
        log.info(
          result === "lapsed"
            ? `review: lapsed since ${since}`
            : "review: not sent yet",
          { repo: `${repo.ownerName}/${repo.name}`, pull: pull.number },
        );
      }
    }
  }
  return forgetSettled(stalled, queued);
}

/** Drop the said-lines of pulls that no longer stall, so the map stays the size of the stall. */
function forgetSettled(stalled: Set<string>, queued: number): number {
  for (const id of said.keys()) if (!stalled.has(id)) said.delete(id);
  return queued;
}
