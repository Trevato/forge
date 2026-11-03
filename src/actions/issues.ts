/**
 * Issue actions. Pulls are issues too (`kind: "pull"`), so commenting and
 * state changes here serve both — the event kind follows the record's kind.
 *
 * Every mutation comes in two shapes, and the pairing is deliberate.
 *
 * The plain function is the **native** path: synchronous, unchanged, and it
 * refuses a mirrored repo with `"mirrored"`. That refusal is mechanical, not
 * advisory — for a mirror the origin is truth, and a local-only write would
 * be a row that diverges from it the moment it is made. No surface can
 * bypass it by forgetting to check.
 *
 * The `…Through` function is the **general** path: it writes to the origin
 * first, reflects the origin's own answer into the local rows, and then
 * appends the event; for a native repo it simply delegates to its sync twin,
 * so one call site serves both kinds of repo. The API uses these. A surface
 * that has not adopted them yet keeps working on native repos and says
 * "mirrored" on the others, which is honest rather than silently wrong.
 */

import { mayView, setSealed } from "../core/sealed.ts";
import { requireVerified } from "./verify.ts";
import { requireAbility } from "./roles.ts";
import type { App } from "../app.ts";
import { crewRole, isCrew } from "../core/agents.ts";
import { moveBlockersToChildren } from "../core/dependencies.ts";
import {
  addComment as insertComment,
  createIssue,
  CLOSE_REASONS,
  getIssue,
  getIssueById,
  getLabel,
  labelsFor,
  listComments,
  setAssignee,
  setIssueLabels as writeLabels,
  setIssueState as writeState,
  updateIssueText,
  type CloseReason,
  type Comment,
  type Issue,
  type IssueState,
  type Label,
  type BodyError,
  type TitleError,
  standsForPerson,
} from "../core/issues.ts";
import { isStructural, pillarsOf } from "../core/pillars.ts";
import { closesFromBody, getPull } from "../core/pulls.ts";
import { canRead, canWrite, type Repo } from "../core/repos.ts";
import { getUserById, type User } from "../core/users.ts";
import {
  directorsAmong,
  mayDirectCrew,
  unadoptedAmong,
} from "../crew/direct.ts";
import { laterGate } from "../crew/later.ts";
import { replanSince } from "../core/limb_replan.ts";
import { handedOver } from "../crew/parks.ts";
import { alreadyDone, CLOSED_NOTE } from "../core/done_on_main.ts";
import { listReviews } from "../core/reviews.ts";
import {
  applyLabelNames,
  commentByRemoteId,
  importComments,
  importIssue,
} from "../origins/import.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { clearFirst } from "../core/first.ts";
import { clearRank } from "../core/rank.ts";
import { followLabel } from "./gate.ts";
import { inheritPillar } from "./pillars.ts";
import {
  requireParticipant,
  requireWriter,
  type AccessError,
} from "./access.ts";
import {
  isMirror,
  refusal,
  writeThroughFor,
  type WriteThroughError,
} from "../origins/write-through.ts";

/** A repo whose truth lives on an origin cannot take a local-only write. */
export type MirrorError = "mirrored";

export function openIssue(
  app: App,
  actor: User | undefined,
  repo: Repo,
  input: { title: string; body?: string; sealed?: boolean },
): Result<
  Issue,
  "not_found" | "unauthorized" | TitleError | "body_too_long" | MirrorError
> {
  const user = requireParticipant(app, actor, repo);
  if (!user.ok) return user;
  if (isMirror(app, repo)) return err("mirrored");
  // Anyone who may open an issue may seal it: a reader reporting a hole
  // seals it too, and from then on only writers and the crew see it
  // (`core/sealed.ts`).
  const created = createIssue(app.db, {
    repoId: repo.id,
    authorId: user.value.id,
    title: input.title,
    body: input.body ?? "",
    sealed: input.sealed === true,
  });
  if (!created.ok) return created;
  app.bus.append({
    kind: "issue.opened",
    repoId: repo.id,
    actorId: user.value.id,
    payload: { number: created.value.number },
  });
  return created;
}

export type EditError =
  | AccessError
  | MirrorError
  | TitleError
  | "body_too_long"
  | "nothing_to_change"
  | "taken_up";

/** The sentence a refused author reads: someone who directs the crew acted. */
export const TAKEN_UP = "a writer has taken this up: comment instead";

/**
 * Whose words these are to change, and the one word why not.
 *
 * A person who writes the repository may change anyone's. The author may
 * change their own — while they are still only theirs. Someone who may
 * not direct the crew (a reader on a public repository, an outside
 * contributor) keeps that right only until a person who directs the crew
 * has acted on the words: adopted the issue (assigned it, or linked it into
 * the map), or reviewed the pull. After that the words are what was
 * adopted or reviewed, and a rewrite would put new work in the crew's
 * hands, or a new `Closes #N` under an approval, with nobody who directs
 * the crew having seen it (#619). They comment instead. Acted is acted:
 * an assignment taken back later does not hand the words back, since the
 * next assignment would hand the crew whatever they say by then. An agent edits only what it wrote,
 * and its own pull only until a person approved it: what the merge closes
 * is what the approval saw.
 *
 * The pages ask this before offering the form, so nobody is shown one the
 * server would refuse. A mirror is refused separately, with its own words.
 */
export function mayEditIssue(
  app: App,
  repo: Repo,
  issue: Issue,
  user: User | undefined,
): Result<true, "forbidden" | "taken_up"> {
  if (user === undefined || !canRead(app.db, repo, user))
    return err("forbidden");
  if (!mayView(app.db, repo, issue, user)) return err("forbidden");
  if (user.id !== issue.authorId)
    return user.kind !== "agent" && canWrite(app.db, repo, user)
      ? ok(true)
      : err("forbidden");
  // Asked of the row as it is now, not as the caller last read it: an
  // assignment or a review made since is what this clock turns on.
  const now = getIssueById(app.db, issue.id) ?? issue;
  if (user.kind === "agent") {
    if (now.kind === "issue") return ok(true);
    const approved = listReviews(app.db, now.id).some(
      (r) =>
        r.state === "approved" &&
        getUserById(app.db, r.authorId)?.kind === "user",
    );
    return approved ? err("taken_up") : ok(true);
  }
  if (mayDirectCrew(app.db, repo, user)) return ok(true);
  const untouched =
    now.kind === "pull"
      ? !reviewedByDirector(app, repo, now)
      : !everAdopted(app, repo, now) &&
        unadoptedAmong(app.db, repo, [now]).has(now.id);
  return untouched ? ok(true) : err("taken_up");
}

/**
 * Whether a person who directs the crew has ever assigned this issue or
 * linked it into the map — read from the outbox, which keeps what the row
 * forgets when an assignment is taken back. A link the crew's planner made
 * is not adoption, as `unadoptedAmong` says.
 */
function everAdopted(app: App, repo: Repo, issue: Issue): boolean {
  const actors = app.db
    .query<{ actor: string }, [string, number]>(
      `SELECT DISTINCT actor_id AS actor FROM event
        WHERE repo_id = ?1 AND actor_id IS NOT NULL
          AND kind IN ('issue.assigned', 'issue.blocked')
          AND (json_extract(payload, '$.number') = ?2
            OR json_extract(payload, '$.blockedBy') = ?2)`,
    )
    .all(repo.id, issue.number)
    .map((r) => r.actor);
  return directorsAmong(app.db, repo, actors).length > 0;
}

/** Whether a person who directs the crew has reviewed this pull, in any state. */
function reviewedByDirector(app: App, repo: Repo, pull: Issue): boolean {
  return (
    directorsAmong(
      app.db,
      repo,
      listReviews(app.db, pull.id).map((r) => r.authorId),
    ).length > 0
  );
}

/**
 * Change the title or the body of an issue or a pull after it was opened:
 * the pull whose body still says "work in progress", the issue whose title
 * no longer says what it asks. Its author's say over their own words, any
 * author's; a person who writes the repository may edit anyone's. An agent
 * that did not write it may not: the crew lands, labels and closes, but a
 * person's words are the person's. A mirror's words belong to its origin.
 *
 * What a pull closes, who it answers, and the map are all read from the
 * body on every read, so they follow the edit with no column to drift. The
 * event says that an edit happened and to what, never the words: the page
 * has them, and a sealed pull's words stay where its seal keeps them.
 */
export function editIssue(
  app: App,
  actor: User | undefined,
  repo: Repo,
  issue: Issue,
  input: { title?: string | undefined; body?: string | undefined },
): Result<Issue, EditError> {
  const user = requireParticipant(app, actor, repo);
  if (!user.ok) return user;
  if (issue.repoId !== repo.id) return err("not_found");
  // A sealed issue is, to anyone it is sealed from, not there.
  if (!mayView(app.db, repo, issue, user.value)) return err("not_found");
  const may = mayEditIssue(app, repo, issue, user.value);
  if (!may.ok) return may;
  if (isMirror(app, repo)) return err("mirrored");
  if (input.title === undefined && input.body === undefined)
    return err("nothing_to_change");
  const changed = (["title", "body"] as const).filter(
    (field) => input[field] !== undefined && input[field] !== issue[field],
  );
  if (changed.length === 0) return ok(issue);
  const updated = updateIssueText(app.db, issue.id, input);
  if (!updated.ok) return updated;
  app.bus.append({
    kind: `${issue.kind}.edited`,
    repoId: repo.id,
    actorId: user.value.id,
    payload: { number: issue.number, changed },
  });
  return updated;
}

/**
 * Seal or unseal an issue or a pull (`core/sealed.ts`). A writer's call,
 * deliberate and recorded: unsealing publishes a security report and its
 * fix to everyone who can read the repository.
 */
export function setIssueSealed(
  app: App,
  actor: User | undefined,
  repo: Repo,
  issue: Issue,
  sealed: boolean,
): Result<Issue, AccessError | MirrorError> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  if (issue.repoId !== repo.id) return err("not_found");
  if (sealed && isMirror(app, repo)) return err("mirrored");
  if (setSealed(app.db, issue.id, sealed))
    app.bus.append({
      kind: sealed ? "issue.sealed" : "issue.unsealed",
      repoId: repo.id,
      actorId: writer.value.id,
      payload: { number: issue.number },
    });
  return ok(getIssueById(app.db, issue.id) ?? issue);
}

/**
 * Put someone on an issue or a pull, or take them off (`null`). A writer's
 * call. The assignee must be able to see the repository, and an agent must
 * be able to write it — assigning an agent is what starts it working
 * (docs/APPS.md), and an agent that cannot push has nothing to start.
 */
export function assignIssue(
  app: App,
  actor: User | undefined,
  repo: Repo,
  issue: Issue,
  assignee: User | null,
  variantGroup?: string,
  /** The crew's own pick under the operator's name: the pace holds it (`week_hold.ts`). */
  pick = false,
): Result<
  Issue,
  AccessError | "assignee_cannot_read" | "agent_not_on_crew" | "unverified" | "not_member" | "archived"
> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  if (issue.repoId !== repo.id) return err("not_found");
  // Assigning an agent starts a run that costs money; only a person may
  // do that. An agent that could assign agents could start a chain of them.
  if (writer.value.kind === "agent") return err("forbidden");
  if (assignee !== null) {
    if (assignee.kind === "org") return err("assignee_cannot_read");
    if (!canRead(app.db, repo, assignee)) return err("assignee_cannot_read");
    // An agent is assignable when it is on the crew: it reads the
    // repository and works from its own fork, so write is not the test.
    if (assignee.kind === "agent" && !isCrew(app.db, repo.id, assignee.id))
      return err("agent_not_on_crew");
    // A run costs: only a proven account may start one.
    if (assignee.kind === "agent" && !requireVerified(app, writer.value).ok)
      return err("unverified");
    // ...and only a member's allowance pays for it.
    if (assignee.kind === "agent" && !requireAbility(app, writer.value, "run_crew").ok)
      return err("not_member");
    // Assigning an agent starts a run, and an archived repository starts none.
    if (assignee.kind === "agent" && repo.archivedAt !== null) return err("archived");
  }
  const updated = setAssignee(app.db, issue.id, assignee?.id ?? null);
  if (!updated) return ok(issue);
  app.bus.append({
    kind: `${issue.kind}.assigned`,
    repoId: repo.id,
    actorId: writer.value.id,
    payload: {
      number: issue.number,
      assignee: assignee?.username ?? null,
      agent: assignee?.kind === "agent",
      ...(variantGroup ? { variantGroup } : {}),
      // A person's assignment says so; an event without it (queued before the mark) is a pick.
      ...(pick ? { pick: true } : { person: true }),
    },
  });
  return ok(updated);
}

/** Comment on an issue or a pull; anyone who can see it may speak. */
export function addComment(
  app: App,
  actor: User | undefined,
  repo: Repo,
  issue: Issue,
  body: string,
): Result<Comment, "not_found" | "unauthorized" | BodyError | MirrorError> {
  const user = requireParticipant(app, actor, repo);
  if (!user.ok) return user;
  if (issue.repoId !== repo.id) return err("not_found");
  if (isMirror(app, repo)) return err("mirrored");
  const added = insertComment(app.db, {
    issueId: issue.id,
    authorId: user.value.id,
    body,
  });
  if (!added.ok) return added;
  app.bus.append({
    kind: `${issue.kind}.commented`,
    repoId: repo.id,
    actorId: user.value.id,
    payload: { number: issue.number, body, commentId: added.value.id },
  });
  return added;
}

/**
 * Close or reopen an issue or a pull. The author or a repo writer may; the
 * change is a CAS, so a no-op transition records nothing and returns the
 * record as it stands. A merged pull is closed for good.
 */
export function setIssueState(
  app: App,
  actor: User | undefined,
  repo: Repo,
  issue: Issue,
  state: IssueState,
  closing: Closing = {},
): Result<
  Issue,
  AccessError | CloseError | MirrorError
> {
  const user = requireParticipant(app, actor, repo);
  if (!user.ok) return user;
  if (issue.repoId !== repo.id) return err("not_found");
  if (isMirror(app, repo)) return err("mirrored");
  // An author's say over their own issue is a person's. An agent closes an
  // issue by landing a pull for it, or by the planner's grant below, and
  // reopens nothing: otherwise what it opened to replace a person's ask
  // would be its own to close, and the ask gone with no person deciding.
  // A sealed report's author follows it and speaks on it, but its state is
  // the writers' (`core/sealed.ts`).
  const ownSay =
    user.value.kind !== "agent" &&
    user.value.id === issue.authorId &&
    !issue.sealed;
  // The one close an agent has on a pull: its own proposal, withdrawn when
  // its run declines or fails (`crew/early.ts`). A person can reopen it.
  const withdrawsOwn =
    state === "closed" &&
    issue.kind === "pull" &&
    user.value.kind === "agent" &&
    user.value.id === issue.authorId;
  const plannerClosesPull =
    state === "closed" &&
    plannerMayClosePull(app, repo, issue, user.value, closing);
  const mayModerate =
    ownSay ||
    withdrawsOwn ||
    canWrite(app.db, repo, user.value) ||
    (state === "closed" &&
      handedToPlanner(app, repo, issue, user.value, closing)) ||
    plannerClosesPull;
  if (!mayModerate) return err("forbidden");
  // The plan's own issues — a pillar's umbrella, the Later umbrella, the
  // Later gate — are a person's to close, whatever access an agent holds:
  // closing the gate opens everything deferred.
  if (
    state === "closed" &&
    user.value.kind === "agent" &&
    isStructural(pillarsOf(app.db, repo), issue.id)
  )
    return err("forbidden");
  if (
    issue.kind === "pull" &&
    state === "open" &&
    getPull(app.db, repo.id, issue.number)?.mergedAt != null
  )
    return err("already_merged");
  const reason = state === "closed" ? (closing.reason ?? "done") : undefined;
  const children: Issue[] = [];
  if (closing.reason !== undefined || closing.into !== undefined) {
    // A reason is how an issue closes; a pull or a reopen has none.
    if (
      state !== "closed" ||
      issue.kind !== (reason === "parked" ? "pull" : "issue") ||
      (reason === "parked" && closing.into !== undefined)
    )
      return err("invalid_reason");
    if (reason === "split") {
      for (const number of closing.into ?? []) {
        const child = getIssue(app.db, repo.id, number);
        if (!child || child.kind !== "issue" || child.id === issue.id)
          return err("invalid_reason");
        if (!children.some((c) => c.id === child.id)) children.push(child);
      }
      if (children.length === 0) return err("invalid_reason");
    } else if (closing.into !== undefined) return err("invalid_reason");
  }
  // Done on main already, by the commits the crew named: the close keeps
  // them, whichever door it comes through. The note goes in with the
  // state change or not at all.
  const doneBy =
    state === "closed" && issue.kind === "issue"
      ? (alreadyDone(app.db, [issue.id]).get(issue.id) ?? [])
      : [];
  // A bug closed with no fix behind it (no commit on main, no split) says
  // why; the crew's own live triage and stale sweeps note it themselves.
  if (closing.note !== undefined && typeof closing.note !== "string") return err("invalid_note");
  const note = (closing.note ?? "").trim();
  if (note.length > MAX_NOTE) return err("invalid_note");
  if (
    state === "closed" &&
    issue.kind === "issue" &&
    reason !== "split" &&
    doneBy.length === 0 &&
    note === "" &&
    !closing.triage &&
    !closing.stale &&
    !closing.system &&
    labelsFor(app.db, issue.id).some((l) => l.name === "bug")
  )
    return err("reason_required");
  const changed = app.db.transaction(() => {
    const written = writeState(app.db, issue.id, state, reason);
    if (written && state === "closed") {
      clearFirst(app.db, issue.id);
      clearRank(app.db, issue.id);
    }
    if (written && state === "closed" && note !== "")
      insertComment(app.db, {
        issueId: issue.id,
        authorId: user.value.id,
        body: `Closed${reason === "dropped" ? " as won't fix" : ""}: ${note}`,
      });
    if (written && doneBy.length > 0)
      insertComment(app.db, {
        issueId: issue.id,
        authorId: user.value.id,
        body: `${CLOSED_NOTE}${doneBy
          .map((o) => `[\`${o.slice(0, 7)}\`](/${repo.ownerName}/${repo.name}/commit/${o})`)
          .join(", ")}.${
          closing.triage
            ? " Closed by the crew's live triage; reopen it to undo, and it stays open."
            : ""
        }`,
      });
    // The planner's close of a pull is logged on its thread, with the why.
    if (written && plannerClosesPull && !canWrite(app.db, repo, user.value))
      insertComment(app.db, {
        issueId: issue.id,
        authorId: user.value.id,
        body: PLANNER_CLOSED_PULL_NOTE,
      });
    return written;
  })();
  if (!changed) return ok(getIssueById(app.db, issue.id) ?? issue);
  if (children.length > 0)
    moveBlockersToChildren(app.db, issue, children, user.value.id);
  app.bus.append({
    kind: `${issue.kind}.${state === "closed" ? "closed" : "reopened"}`,
    repoId: repo.id,
    actorId: user.value.id,
    payload: {
      number: issue.number,
      ...(reason !== undefined && (issue.kind === "issue" || reason === "parked")
        ? { reason }
        : {}),
      ...(children.length > 0 ? { into: children.map((c) => c.number) } : {}),
      ...(closing.stale === true && issue.kind === "pull" ? { stale: true } : {}),
    },
  });
  // The parts serve what the whole served.
  inheritPillar(app, user.value, repo, issue, children);
  return ok(changed);
}

export const PLANNER_CLOSED_PULL_NOTE =
  "Closed by the planner: the issue this pull was built for is closed.";

/**
 * The one close the planner has on a pull: an open, unmerged pull an agent
 * wrote, whose description names the issue(s) it was built for and every
 * one of them is closed. A person's pull, a merge, and a reopen stay with
 * the people who can write here.
 */
function plannerMayClosePull(
  app: App,
  repo: Repo,
  issue: Issue,
  actor: User,
  closing: Closing,
): boolean {
  if (issue.kind !== "pull" || issue.state !== "open") return false;
  if (actor.kind !== "agent" || crewRole(app.db, repo.id, actor.id) !== "planner")
    return false;
  if (closing.reason !== undefined || closing.into !== undefined) return false;
  if (!issue.authorIsAgent) return false;
  if (getPull(app.db, repo.id, issue.number)?.mergedAt != null) return false;
  const built = closesFromBody(issue.body)
    .map((n) => getIssue(app.db, repo.id, n))
    .filter((i): i is Issue => i !== undefined && i.kind === "issue");
  return built.length > 0 && built.every((i) => i.state === "closed");
}

/**
 * The one close a crew member may make on an issue it did not write: the
 * repository's planner, on an open issue it is re-planning — one the crew
 * parked twice and handed to it (`crew/parks.ts`), or any other. Nothing a
 * person asked for is lost by it:
 *
 * - split, only into what replaces it — every issue named must be an open
 *   issue made since the hand-over, not the issue itself and not the Later
 *   gate, so a closed or an old issue cannot stand in for a drop. Or, once
 *   every piece has landed, into issues of this repository that all closed as
 *   done since the hand-over, so old unrelated work cannot stand in either;
 * - dropped, only when an agent wrote the issue. A person's ask is dropped
 *   by a person.
 *
 * - done, only when commits on main already name the issue (`alreadyDone`).
 *
 * A reopen and any other close stay with the people who can write here; the
 * one close of a pull is `plannerMayClosePull`'s.
 */
function handedToPlanner(
  app: App,
  repo: Repo,
  issue: Issue,
  actor: User,
  closing: Closing,
): boolean {
  return (
    crewRole(app.db, repo.id, actor.id) === "planner" &&
    plannerCloseRefusal(app, repo, issue, actor, closing) === undefined
  );
}

export const PLANNER_REFUSALS = {
  done: 'a planner closes as done only an issue with an "already done on main" note naming commits on main; none name this one',
  dropped:
    "a planner does not drop an issue a person's ask stands in; split it into open issues, replace it, or defer it",
  splitSince: (since: string) =>
    `a planner splits an issue only into open issues, other than itself and the Later gate, opened after ${since}`,
  pull: "a planner may close only an agent's pull whose issue is closed",
  other:
    "a planner closes only an open issue (done already on main, dropped, or split); any other close is not the planner's",
} as const;

/**
 * Why the planner may not close this issue as asked: the message naming the
 * rule, or undefined when the close is the planner's (see `handedToPlanner`
 * above). Undefined too for anyone who is not the repository's planner, whose
 * refusal is about credentials.
 */
export function plannerCloseRefusal(
  app: App,
  repo: Repo,
  issue: Issue,
  actor: User,
  closing: Closing,
): string | undefined {
  if (crewRole(app.db, repo.id, actor.id) !== "planner") return undefined;
  if (issue.kind === "pull") return PLANNER_REFUSALS.pull;
  if (issue.state !== "open") return PLANNER_REFUSALS.other;
  // Replacements must be newer than the hand-over when the crew handed the
  // issue over, and newer than the issue itself when the planner re-plans it
  // on its own pass.
  // A limb a person handed over (`core/limb_replan.ts`): newer than that
  // hand-over, and only as a split — a person's issue beneath it is not dropped.
  const limbSince = replanSince(app.db, repo, issue);
  const own = handedOver(app.db, repo, issue.id) ?? {
    at: issue.createdAt,
    id: issue.id,
  };
  const since = limbSince !== undefined && limbSince > own.at ? { at: limbSince, id: "" } : own;
  // Done on main: only when commits already name the issue, as the close
  // note keeps them.
  if (closing.reason === undefined || closing.reason === "done")
    return (alreadyDone(app.db, [issue.id]).get(issue.id) ?? []).length > 0
      ? undefined
      : PLANNER_REFUSALS.done;
  // Dropped only when no person's ask stands in it — not one the planner
  // wrote to replace a person's, however many times it was split since.
  if (closing.reason === "dropped")
    return limbSince === undefined && !standsForPerson(app.db, issue)
      ? undefined
      : PLANNER_REFUSALS.dropped;
  // What is left is a split: a request names no other reason (`CLOSE_REASONS`).
  const refused = PLANNER_REFUSALS.splitSince(since.at);
  const into = closing.into ?? [];
  if (into.length === 0) return refused;
  const gate = laterGate(app.db, repo.id);
  const found = into.map((number) => getIssue(app.db, repo.id, number));
  const parts: Issue[] = [];
  for (const part of found) {
    if (
      part === undefined ||
      part.kind !== "issue" ||
      part.id === issue.id ||
      part.number === gate
    )
      return refused;
    parts.push(part);
  }
  // Every piece landed since: closed as done at or after the hand-over.
  if (
    parts.every(
      (part) =>
        part.state === "closed" &&
        part.closeReason === "done" &&
        (part.closedAt ?? "") >= since.at,
    )
  )
    return undefined;
  // Opened since: in the same millisecond, the id says which came first.
  return parts.every(
    (part) =>
      part.state === "open" &&
      (part.createdAt > since.at ||
        (part.createdAt === since.at && part.id > since.id)),
  )
    ? undefined
    : refused;
}

/** What a close can be refused for beyond access: a merged pull, a bad reason or note, a bug with no why. */
export type CloseError =
  | "already_merged"
  | "invalid_reason"
  | "invalid_note"
  | "reason_required";

/** The longest note a close takes: one sentence. */
export const MAX_NOTE = 300;

/** How an issue closes: done unless said otherwise; split names its children. */
export interface Closing {
  readonly reason?: CloseReason;
  /** Issue numbers a split issue became. */
  readonly into?: readonly number[];
  /** The crew's live triage closed it, not the person whose name it carries. */
  readonly triage?: boolean;
  /** Why, in a sentence: a bug closed with no fix behind it needs one. */
  readonly note?: string;
  /** The forge's own close: it says why itself, so a bug needs no note. */
  readonly system?: boolean;
  /** A crew pull closed for staying conflicted 72 hours (`crew/stale_pulls.ts`). */
  readonly stale?: boolean;
}

/**
 * `reason` and `into` of a close request, or undefined when they are not
 * the shapes they must be (a bad reason word, `into` not a list of numbers).
 */
export function closingFrom(input: Record<string, unknown>): Closing | undefined {
  const reason = input.reason;
  if (reason !== undefined && !CLOSE_REASONS.includes(reason as CloseReason))
    return undefined;
  let into: number[] | undefined;
  if (input.into !== undefined) {
    if (
      !Array.isArray(input.into) ||
      input.into.length > 50 ||
      !input.into.every((n) => Number.isInteger(n) && n > 0)
    )
      return undefined;
    into = input.into as number[];
  }
  // A note's shape is judged where it is used (`invalid_note`), not here.
  const note = input.note as string | undefined;
  return {
    ...(note === undefined ? {} : { note }),
    ...(reason === undefined ? {} : { reason: reason as CloseReason }),
    ...(into === undefined ? {} : { into }),
  };
}

/**
 * Replace an issue's (or pull's) label set. Writers only — labels are the
 * work queue. Labels may be named by id or by name; an unknown one rejects
 * the whole set, so a typo never silently drops a label.
 */
export function setIssueLabels(
  app: App,
  actor: User | undefined,
  repo: Repo,
  issue: Issue,
  labels: string[],
): Result<Label[], AccessError | "unknown_label" | MirrorError> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  if (issue.repoId !== repo.id) return err("not_found");
  if (isMirror(app, repo)) return err("mirrored");
  const resolved: Label[] = [];
  for (const ref of labels) {
    const label = getLabel(app.db, repo.id, ref);
    if (!label) return err("unknown_label");
    if (!resolved.some((l) => l.id === label.id)) resolved.push(label);
  }
  const before = labelsFor(app.db, issue.id);
  writeLabels(
    app.db,
    issue.id,
    resolved.map((l) => l.id),
  );
  app.bus.append({
    kind: `${issue.kind}.labeled`,
    repoId: repo.id,
    actorId: writer.value.id,
    payload: { number: issue.number, labels: resolved.map((l) => l.name) },
  });
  // `Later` is the Later gate made visible: changing the label changes the gate.
  const followed = followLabel(app, writer.value, repo, issue, before, resolved);
  if (!followed.ok) {
    // The label and the gate move together or not at all.
    writeLabels(app.db, issue.id, before.map((l) => l.id));
    return err("forbidden");
  }
  return ok(labelsFor(app.db, issue.id));
}

// ---- write-through: the same four mutations, for any repo ----

export type ThroughError<E> = E | MirrorError | WriteThroughError;

/**
 * Open an issue. On a mirror the origin creates it — so the number, the
 * timestamps and the id are all the origin's, and the local row is a
 * reflection of what came back rather than something we invented and hope
 * matches.
 */
export async function openIssueThrough(
  app: App,
  actor: User | undefined,
  repo: Repo,
  input: {
    title: string;
    body?: string;
    labels?: readonly string[];
    sealed?: boolean;
  },
): Promise<
  Result<
    Issue,
    ThroughError<"not_found" | "unauthorized" | TitleError | "body_too_long">
  >
> {
  const user = requireParticipant(app, actor, repo);
  if (!user.ok) return user;
  const through = writeThroughFor(app, user.value, repo);
  if (!through.ok) return through;
  if (through.value === undefined) return openIssue(app, actor, repo, input);
  // A mirror's issues are written on its origin, in the open: a sealed
  // report has no place there.
  if (input.sealed === true) return err("mirrored");

  const title = input.title.trim();
  if (title === "") return err("empty_title");
  const created = await through.value.provider.createIssue(
    through.value.fullName,
    {
      title,
      body: input.body ?? "",
      ...(input.labels === undefined ? {} : { labels: input.labels }),
    },
  );
  if (!created.ok) return err(refusal(created.error.error));

  const imported = importIssue(
    { db: app.db, repoId: repo.id, actorId: user.value.id },
    created.value,
  );
  app.bus.append({
    kind: "issue.opened",
    repoId: repo.id,
    actorId: user.value.id,
    payload: { number: created.value.number, via: "origin" },
  });
  return ok(getIssueById(app.db, imported.issueId)!);
}

export async function addCommentThrough(
  app: App,
  actor: User | undefined,
  repo: Repo,
  issue: Issue,
  body: string,
): Promise<
  Result<Comment, ThroughError<"not_found" | "unauthorized" | BodyError>>
> {
  const user = requireParticipant(app, actor, repo);
  if (!user.ok) return user;
  if (issue.repoId !== repo.id) return err("not_found");
  const through = writeThroughFor(app, user.value, repo);
  if (!through.ok) return through;
  if (through.value === undefined)
    return addComment(app, actor, repo, issue, body);

  const trimmed = body.trim();
  if (trimmed === "") return err("empty_body");
  const posted = await through.value.provider.createComment(
    through.value.fullName,
    issue.number,
    trimmed,
  );
  if (!posted.ok) return err(refusal(posted.error.error));

  const ctx = { db: app.db, repoId: repo.id, actorId: user.value.id };
  importComments(ctx, issue.id, [posted.value]);
  const localId = commentByRemoteId(app.db, issue.id, posted.value.remoteId);
  if (localId === undefined) return err("origin_unreachable");
  app.bus.append({
    kind: `${issue.kind}.commented`,
    repoId: repo.id,
    actorId: user.value.id,
    payload: { number: issue.number, via: "origin" },
  });
  return ok(
    listComments(app.db, issue.id).find((c) => c.id === localId) ??
      (() => {
        throw new Error("unreachable");
      })(),
  );
}

export async function setIssueStateThrough(
  app: App,
  actor: User | undefined,
  repo: Repo,
  issue: Issue,
  state: IssueState,
  closing: Closing = {},
): Promise<
  Result<Issue, ThroughError<AccessError | CloseError>>
> {
  const user = requireParticipant(app, actor, repo);
  if (!user.ok) return user;
  if (issue.repoId !== repo.id) return err("not_found");
  const through = writeThroughFor(app, user.value, repo);
  if (!through.ok) return through;
  if (through.value === undefined)
    return setIssueState(app, actor, repo, issue, state, closing);

  // Same "author or writer" rule as a native issue: mirroring is not a
  // permission bypass, and the origin will have its own opinion too.
  if (!(user.value.id === issue.authorId || canWrite(app.db, repo, user.value)))
    return err("forbidden");

  const changed = await through.value.provider.setState(
    through.value.fullName,
    issue.number,
    state,
  );
  if (!changed.ok) return err(refusal(changed.error.error));
  const imported = importIssue(
    { db: app.db, repoId: repo.id, actorId: user.value.id },
    changed.value,
  );
  if (imported.changed) {
    app.bus.append({
      kind: `${issue.kind}.${state === "closed" ? "closed" : "reopened"}`,
      repoId: repo.id,
      actorId: user.value.id,
      payload: { number: issue.number, via: "origin" },
    });
  }
  return ok(getIssueById(app.db, imported.issueId)!);
}

export async function setIssueLabelsThrough(
  app: App,
  actor: User | undefined,
  repo: Repo,
  issue: Issue,
  labels: string[],
): Promise<Result<Label[], ThroughError<AccessError | "unknown_label">>> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  if (issue.repoId !== repo.id) return err("not_found");
  const through = writeThroughFor(app, writer.value, repo);
  if (!through.ok) return through;
  if (through.value === undefined)
    return setIssueLabels(app, actor, repo, issue, labels);

  // On a mirror the origin owns the label vocabulary, so names go up as the
  // user typed them and whatever comes back is what the issue now carries.
  const applied = await through.value.provider.setLabels(
    through.value.fullName,
    issue.number,
    labels,
  );
  if (!applied.ok) return err(refusal(applied.error.error));
  const names = applied.value.map((l) => l.name);
  applyLabelNames(app.db, repo.id, issue.id, names);
  app.bus.append({
    kind: `${issue.kind}.labeled`,
    repoId: repo.id,
    actorId: writer.value.id,
    payload: { number: issue.number, labels: names, via: "origin" },
  });
  return ok(labelsFor(app.db, issue.id));
}

export { refusal };
