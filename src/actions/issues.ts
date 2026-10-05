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

import type { App } from "../app.ts";
import { crewRole, isCrew } from "../core/agents.ts";
import { moveBlockersToChildren } from "../core/dependencies.ts";
import {
  addComment as insertComment,
  createIssue,
  getIssue,
  getIssueById,
  getLabel,
  labelsFor,
  listComments,
  setAssignee,
  setIssueLabels as writeLabels,
  setIssueState as writeState,
  type CloseReason,
  type Comment,
  type Issue,
  type IssueState,
  type Label,
  type BodyError,
  type TitleError,
} from "../core/issues.ts";
import { getPull } from "../core/pulls.ts";
import { canRead, canWrite, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { struckOut } from "../crew/parks.ts";
import {
  applyLabelNames,
  commentByRemoteId,
  importComments,
  importIssue,
} from "../origins/import.ts";
import { err, ok, type Result } from "../kernel/result.ts";
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
  input: { title: string; body?: string },
): Result<
  Issue,
  "not_found" | "unauthorized" | TitleError | "body_too_long" | MirrorError
> {
  const user = requireParticipant(app, actor, repo);
  if (!user.ok) return user;
  if (isMirror(app, repo)) return err("mirrored");
  const created = createIssue(app.db, {
    repoId: repo.id,
    authorId: user.value.id,
    title: input.title,
    body: input.body ?? "",
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
): Result<Issue, AccessError | "assignee_cannot_read" | "agent_not_on_crew"> {
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
    payload: { number: issue.number, body },
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
  AccessError | "already_merged" | MirrorError | "invalid_reason"
> {
  const user = requireParticipant(app, actor, repo);
  if (!user.ok) return user;
  if (issue.repoId !== repo.id) return err("not_found");
  if (isMirror(app, repo)) return err("mirrored");
  const mayModerate =
    user.value.id === issue.authorId ||
    canWrite(app.db, repo, user.value) ||
    (state === "closed" &&
      handedToPlanner(app, repo, issue, user.value, closing));
  if (!mayModerate) return err("forbidden");
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
    if (state !== "closed" || issue.kind !== "issue")
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
  const changed = writeState(app.db, issue.id, state, reason);
  if (!changed) return ok(getIssueById(app.db, issue.id) ?? issue);
  if (children.length > 0)
    moveBlockersToChildren(app.db, issue, children, user.value.id);
  app.bus.append({
    kind: `${issue.kind}.${state === "closed" ? "closed" : "reopened"}`,
    repoId: repo.id,
    actorId: user.value.id,
    payload: {
      number: issue.number,
      ...(issue.kind === "issue" && reason !== undefined ? { reason } : {}),
      ...(children.length > 0 ? { into: children.map((c) => c.number) } : {}),
    },
  });
  return ok(changed);
}

/**
 * The one close a crew member may make on an issue it did not write: the
 * repository's planner, on an open issue the crew parked twice and handed
 * to it (`crew/parks.ts`), and only as split or dropped. Done is what a
 * landed pull or a person says; a pull, a reopen, and every other issue
 * stay with the people who can write here.
 */
function handedToPlanner(
  app: App,
  repo: Repo,
  issue: Issue,
  actor: User,
  closing: Closing,
): boolean {
  return (
    issue.kind === "issue" &&
    issue.state === "open" &&
    (closing.reason === "split" || closing.reason === "dropped") &&
    crewRole(app.db, repo.id, actor.id) === "planner" &&
    struckOut(app.db, [issue.id]).has(issue.id)
  );
}

/** How an issue closes: done unless said otherwise; split names its children. */
export interface Closing {
  readonly reason?: CloseReason;
  /** Issue numbers a split issue became. */
  readonly into?: readonly number[];
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
  input: { title: string; body?: string; labels?: readonly string[] },
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
  Result<Issue, ThroughError<AccessError | "already_merged" | "invalid_reason">>
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
