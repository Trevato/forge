/**
 * Filing a finding sorted (#8856): the labels of its kind, made in the
 * repository when it has none by that name, added to what the issue already
 * carries. Shared by every detector that files: the sentinel and the
 * performance watcher. The forge acts on its own finding, so no access check
 * stands between it and the labels, as none stands between it and the issue.
 */

import type { App } from "../app.ts";
import { createLabel, getLabel, labelsFor, setIssueLabels, type Issue, type Label } from "../core/issues.ts";
import { KIND_LABELS, LABEL_COLORS, type FindingKind } from "./finding.ts";

export function getOrMakeLabel(app: App, repoId: string, name: string): Label | undefined {
  const had = getLabel(app.db, repoId, name);
  if (had !== undefined) return had;
  const made = createLabel(app.db, repoId, name, LABEL_COLORS[name] ?? "ededed");
  return made.ok ? made.value : undefined;
}

export const kindLabels = (app: App, repoId: string, kind: FindingKind): Label[] =>
  KIND_LABELS[kind].flatMap((name) => getOrMakeLabel(app, repoId, name) ?? []);

/** Adds `wanted` to the issue's labels and says so on the bus; labels already on it stay. */
export function addLabels(app: App, repoId: string, actorId: string, issue: Issue, wanted: readonly Label[]): void {
  const had = labelsFor(app.db, issue.id);
  const added = wanted.filter((w) => !had.some((h) => h.id === w.id));
  if (added.length === 0) return;
  setIssueLabels(app.db, issue.id, [...had, ...added].map((l) => l.id));
  app.bus.append({
    kind: "issue.labeled",
    repoId,
    actorId,
    payload: { number: issue.number, labels: added.map((l) => l.name) },
  });
}
