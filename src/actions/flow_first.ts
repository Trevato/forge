/**
 * Putting an issue first, or taking it back: the `flow` label, one click.
 * The label is the whole mechanism (`core/flow_label.ts`): ready work that
 * carries it goes first, and nothing is held by a mode.
 */

import type { App } from "../app.ts";
import { createLabel, getLabel, labelsFor, type Issue, type Label } from "../core/issues.ts";
import { FLOW_LABEL } from "../core/flow_label.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { ok, type Result } from "../kernel/result.ts";
import { setIssueLabelsThrough, type ThroughError } from "./issues.ts";
import { requireWriter, type AccessError } from "./access.ts";

const FLOW_COLOR = "d29922";

/** The repository's `flow` label, made the first time a writer wants it; a reader is refused and makes nothing. */
export function ensureFlowLabel(app: App, actor: User | undefined, repo: Repo): Result<void, AccessError> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  if (getLabel(app.db, repo.id, FLOW_LABEL) === undefined) createLabel(app.db, repo.id, FLOW_LABEL, FLOW_COLOR);
  return ok(undefined);
}

/** Add (`on`) or take off the `flow` label, keeping the issue's other labels. */
export async function putFlowFirst(
  app: App,
  actor: User | undefined,
  repo: Repo,
  issue: Issue,
  on: boolean,
): Promise<Result<Label[], ThroughError<AccessError | "unknown_label">>> {
  const others = labelsFor(app.db, issue.id)
    .map((l) => l.name)
    .filter((n) => n.toLowerCase() !== FLOW_LABEL);
  if (on) {
    const made = ensureFlowLabel(app, actor, repo);
    if (!made.ok) return made;
  }
  return setIssueLabelsThrough(app, actor, repo, issue, on ? [...others, FLOW_LABEL] : others);
}
