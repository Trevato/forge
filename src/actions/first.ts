/**
 * "This first" as a person does it (#7808): the issue by number, the writer
 * gate and the words of a refusal, one for the map page and the terminal.
 * The rank itself is `putFirst` (core/first.ts).
 */
import type { App } from "../app.ts";
import { putFirst } from "../core/first.ts";
import { getIssue, type Issue } from "../core/issues.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export const FIRST_FORBIDDEN = "Only someone with write access can put an issue first.";
export const FIRST_INVALID = "Only an open issue that nothing waits in front of can go first.";

export function putIssueFirst(
  app: App,
  actor: User,
  repo: Repo,
  number: number,
): Result<Issue, { kind: "not_found" | "forbidden" | "invalid"; message: string }> {
  const issue = Number.isInteger(number) && number > 0 ? getIssue(app.db, repo.id, number) : undefined;
  if (!issue) return err({ kind: "not_found", message: "No such issue." });
  const put = putFirst(app, actor, repo, issue);
  if (put.ok) return ok(issue);
  if (put.error === "forbidden") return err({ kind: "forbidden", message: FIRST_FORBIDDEN });
  if (put.error === "not_found") return err({ kind: "not_found", message: "No such issue." });
  return err({ kind: "invalid", message: FIRST_INVALID });
}
