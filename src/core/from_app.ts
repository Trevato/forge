/**
 * An issue a person sent from an app (#10365, sandbox-game#18): the forge
 * button in an app files it in the owner's name under this label
 * (`actions/app_notes.ts`). It is a person's ask, and it is read ahead of
 * the crew's own picks (`next_up.ts`) and starts ahead of them
 * (`crew/people_first.ts`): one sat for eighteen hours behind polish.
 */

import type { Database } from "bun:sqlite";
import { labelsForIssues } from "./issues.ts";

export const FROM_APP_LABEL = "from-app";

/** Of `issueIds`, the ones labelled `from-app`. */
export function fromAppIssues(
  db: Database,
  issueIds: readonly string[],
): Set<string> {
  if (issueIds.length === 0) return new Set();
  const out = new Set<string>();
  for (const [id, labels] of labelsForIssues(db, issueIds))
    if (labels.some((l) => l.name.toLowerCase() === FROM_APP_LABEL))
      out.add(id);
  return out;
}
