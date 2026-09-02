/**
 * Issue actions. Pulls are issues too (`kind: "pull"`), so commenting and
 * state changes here serve both — the event kind follows the record's kind.
 */

import type { App } from "../app.ts";
import {
  addComment as insertComment,
  createIssue,
  getIssueById,
  getLabel,
  labelsFor,
  setIssueLabels as writeLabels,
  setIssueState as writeState,
  type Comment,
  type Issue,
  type IssueState,
  type Label,
  type BodyError,
  type TitleError,
} from "../core/issues.ts";
import { getPull } from "../core/pulls.ts";
import { canWrite, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import {
  requireParticipant,
  requireWriter,
  type AccessError,
} from "./access.ts";

export function openIssue(
  app: App,
  actor: User | undefined,
  repo: Repo,
  input: { title: string; body?: string },
): Result<Issue, "not_found" | "unauthorized" | TitleError | "body_too_long"> {
  const user = requireParticipant(app, actor, repo);
  if (!user.ok) return user;
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

/** Comment on an issue or a pull; anyone who can see it may speak. */
export function addComment(
  app: App,
  actor: User | undefined,
  repo: Repo,
  issue: Issue,
  body: string,
): Result<Comment, "not_found" | "unauthorized" | BodyError> {
  const user = requireParticipant(app, actor, repo);
  if (!user.ok) return user;
  if (issue.repoId !== repo.id) return err("not_found");
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
    payload: { number: issue.number },
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
): Result<Issue, AccessError | "already_merged"> {
  const user = requireParticipant(app, actor, repo);
  if (!user.ok) return user;
  if (issue.repoId !== repo.id) return err("not_found");
  const mayModerate =
    user.value.id === issue.authorId || canWrite(app.db, repo, user.value);
  if (!mayModerate) return err("forbidden");
  if (
    issue.kind === "pull" &&
    state === "open" &&
    getPull(app.db, repo.id, issue.number)?.mergedAt != null
  )
    return err("already_merged");
  const changed = writeState(app.db, issue.id, state);
  if (!changed) return ok(getIssueById(app.db, issue.id) ?? issue);
  app.bus.append({
    kind: `${issue.kind}.${state === "closed" ? "closed" : "reopened"}`,
    repoId: repo.id,
    actorId: user.value.id,
    payload: { number: issue.number },
  });
  return ok(changed);
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
): Result<Label[], AccessError | "unknown_label"> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  if (issue.repoId !== repo.id) return err("not_found");
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
