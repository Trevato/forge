/**
 * A sealed report opens when its fix is released (#621). The hole is
 * closed once a release carries the fix, and from then on the report is
 * history every reader may learn from: so when a tag is pushed whose
 * commit contains the merged pull that closed a sealed report, the report
 * and that pull are unsealed, and the record says the release did it.
 * Before then only a writer unseals (`setIssueSealed`). A release is a
 * person's act: a tag an agent pushes opens nothing, or the crew — which
 * reads the sealed report, words and all — could publish it by asking.
 */

import type { App } from "../app.ts";
import { getIssue } from "../core/issues.ts";
import { closesFromBody, listPulls } from "../core/pulls.ts";
import { canWrite, type Repo } from "../core/repos.ts";
import { isActive, type User } from "../core/users.ts";
import { setSealed } from "../core/sealed.ts";
import { isAncestor } from "../git/local.ts";
import { repoDir } from "../git/repos.ts";

/** A ref a push moved, as the post-receive hook reports it. */
export interface RefUpdate {
  readonly ref: string;
  readonly newOid: string;
}

/**
 * Unseal what the tags in `updates` release: each sealed report closed by
 * a merged pull whose merge commit a pushed tag contains, with that pull.
 * Returns the numbers unsealed.
 */
export async function unsealReleased(
  app: App,
  repo: Repo,
  updates: readonly RefUpdate[],
  pusher: User | undefined,
): Promise<number[]> {
  if (
    pusher === undefined ||
    pusher.kind !== "user" ||
    !isActive(pusher) ||
    !canWrite(app.db, repo, pusher)
  )
    return [];
  const tags = updates.filter(
    (u) => u.ref.startsWith("refs/tags/") && !/^0+$/.test(u.newOid),
  );
  if (tags.length === 0) return [];
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const fixes = listPulls(app.db, repo.id, {
    state: "closed",
    sealed: true,
    limit: 200,
  }).filter((p) => p.mergedOid !== null);
  const opened: number[] = [];
  for (const pull of fixes) {
    const reports = closesFromBody(pull.body)
      .map((n) => getIssue(app.db, repo.id, n))
      .filter((i) => i !== undefined && i.sealed && i.kind === "issue");
    if (reports.length === 0 && !pull.sealed) continue;
    let release: string | undefined;
    for (const tag of tags)
      if (await isAncestor(dir, pull.mergedOid!, tag.newOid)) {
        release = tag.ref.slice("refs/tags/".length);
        break;
      }
    if (release === undefined) continue;
    for (const issue of [...reports, pull])
      if (issue !== undefined && setSealed(app.db, issue.id, false)) {
        opened.push(issue.number);
        app.bus.append({
          kind: "issue.unsealed",
          repoId: repo.id,
          actorId: pusher.id,
          payload: { number: issue.number, released: release },
        });
      }
  }
  return opened;
}
