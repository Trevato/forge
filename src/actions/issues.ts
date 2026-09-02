/**
 * Issue actions. Pulls are issues too (`kind: "pull"`), so commenting and
 * state changes here serve both — the event kind follows the record's kind.
 */

import type { App } from "../app.ts";
import {
  addComment as insertComment,
  createIssue,
  getIssueById,
  setIssueLabels as writeLabels,
  setIssueState as writeState,
  type Comment,
  type Issue,
  type IssueState,
} from "../core/issues.ts";
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
): Result<Issue, "not_found" | "unauthorized" | "empty_title"> {
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
): Result<Comment, "not_found" | "unauthorized" | "empty_body"> {
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
 * Close or reopen. The author or a repo writer may; the change is a CAS, so
 * a no-op transition records nothing and returns the record as it stands.
 */
export function setIssueState(
  app: App,
  actor: User | undefined,
  repo: Repo,
  issue: Issue,
  state: IssueState,
): Result<Issue, AccessError> {
  const user = requireParticipant(app, actor, repo);
  if (!user.ok) return user;
  if (issue.repoId !== repo.id) return err("not_found");
  const mayModerate =
    user.value.id === issue.authorId || canWrite(app.db, repo, user.value);
  if (!mayModerate) return err("forbidden");
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

/** Replace an issue's label set. Writers only — labels are the work queue. */
export function setIssueLabels(
  app: App,
  actor: User | undefined,
  repo: Repo,
  issue: Issue,
  labelIds: string[],
): Result<void, AccessError> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  if (issue.repoId !== repo.id) return err("not_found");
  writeLabels(app.db, issue.id, labelIds);
  app.bus.append({
    kind: `${issue.kind}.labeled`,
    repoId: repo.id,
    actorId: writer.value.id,
    payload: { number: issue.number, labels: labelIds },
  });
  return ok();
}
