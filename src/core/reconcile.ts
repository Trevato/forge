/**
 * Boot reconciliation: make on-disk reality match the index before serving.
 * Two passes. First it refreshes every repo's hook stubs — the hook contract
 * can change between releases, and a stale pre-receive fails closed
 * (silently rejecting every push to an older repo), so an upgrade must re-lay
 * them. Then it heals index rows from ref state, git being the truth for
 * code: an open same-repository pull whose recorded head is not its branch's
 * tip (a forge that stopped between a push and its index write) is moved to
 * the tip through `trackPullHead`, the call every push makes, and a `push`
 * event is recorded so whatever hears pushes hears this one. The checks'
 * boot catch-up then asks for the new head. Pulls from forks live in other
 * repositories and are left alone here.
 *
 * It runs before the listeners come up, which makes it the one piece of
 * startup a growing forge waits on: two thousand repos done one at a time is
 * four filesystem round trips each, in series, while nothing is being served.
 * So it fans out — bounded, because the point is not to replace a slow boot
 * with a thundering herd of file writes. The head pass reads refs only for
 * repositories with an open same-repository pull, one `for-each-ref` each.
 */

import type { App } from "../app.ts";
import { installHooks } from "../git/hooks.ts";
import { listRefs } from "../git/read.ts";
import { repoDir } from "../git/repos.ts";
import { repoExists } from "../git/repos.ts";
import { getPull, trackPullHead } from "./pulls.ts";

/** Repos reconciled at once. Filesystem work, so wider than the git limit. */
const CONCURRENCY = 32;
/** Repos whose refs are read at once in the head pass: a git process each. */
const GIT_CONCURRENCY = 8;

/** Run `work` over `items`, at most `limit` at a time. */
async function fanOut<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const item = items[next++];
      if (item === undefined) return;
      await work(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}

export async function reconcile(app: App): Promise<void> {
  const rows = app.db
    .query<{ owner_name: string; name: string }, []>(
      `SELECT user.username AS owner_name, repo.name AS name
       FROM repo JOIN user ON user.id = repo.owner_id`,
    )
    .all();

  let refreshed = 0;
  await fanOut(rows, CONCURRENCY, async (row) => {
    const dir = repoDir(app.reposRoot, row.owner_name, row.name);
    // HEAD, not the directory: hooks can only be installed into a usable
    // repository, and a half-removed one (no HEAD) is not that.
    if (await repoExists(dir)) {
      await installHooks(dir);
      refreshed++;
    } else {
      app.log.warn("repo row without a git directory", {
        repo: `${row.owner_name}/${row.name}`,
      });
    }
  });

  const heads = await reconcileHeads(app);

  app.log.info("reconciled", {
    repos: rows.length,
    hooks_refreshed: refreshed,
    heads_repaired: heads,
  });
}

interface OpenHead {
  readonly repo_id: string;
  readonly owner_name: string;
  readonly repo_name: string;
  readonly number: number;
  readonly head_branch: string;
  readonly head_oid: string;
}

/**
 * Move every open same-repository pull whose recorded head differs from its
 * branch's ref to that ref. Returns how many moved. A second run moves none.
 */
export async function reconcileHeads(app: App): Promise<number> {
  const open = app.db
    .query<OpenHead, []>(
      `SELECT issue.repo_id, user.username AS owner_name, repo.name AS repo_name,
              issue.number, pull.head_branch, pull.head_oid
         FROM pull
         JOIN issue ON issue.id = pull.issue_id
         JOIN repo ON repo.id = issue.repo_id
         JOIN user ON user.id = repo.owner_id
        WHERE issue.state = 'open' AND pull.merged_at IS NULL
          AND (pull.head_repo_id IS NULL OR pull.head_repo_id = issue.repo_id)`,
    )
    .all();
  const byRepo = new Map<string, OpenHead[]>();
  for (const row of open) {
    const list = byRepo.get(row.repo_id);
    if (list === undefined) byRepo.set(row.repo_id, [row]);
    else list.push(row);
  }

  let repaired = 0;
  await fanOut([...byRepo.values()], GIT_CONCURRENCY, async (pulls) => {
    const first = pulls[0]!;
    const repo = `${first.owner_name}/${first.repo_name}`;
    const dir = repoDir(app.reposRoot, first.owner_name, first.repo_name);
    if (!(await repoExists(dir))) return; // the hook pass has said so
    const refs = await listRefs(dir, "refs/heads/");
    if (!refs.ok) {
      app.log.warn("could not read branches to reconcile pull heads", {
        repo,
        error: refs.error.stderr,
      });
      return;
    }
    const tips = new Map(refs.value.map((r) => [r.name, r.oid]));
    const updates: { ref: string; oldOid: string; newOid: string }[] = [];
    for (const pull of pulls) {
      const ref = `refs/heads/${pull.head_branch}`;
      const tip = tips.get(ref);
      if (tip === undefined) {
        app.log.warn("open pull's branch is missing; row left as it is", {
          repo,
          pull: pull.number,
          branch: pull.head_branch,
        });
        continue;
      }
      if (tip === pull.head_oid) continue;
      trackPullHead(app.db, pull.repo_id, pull.head_branch, tip);
      // trackPullHead moves the branch's newest pull; an older open one
      // sharing the branch is not its to move, and is not claimed here.
      if (getPull(app.db, pull.repo_id, pull.number)?.headOid !== tip) continue;
      updates.push({ ref, oldOid: pull.head_oid, newOid: tip });
      app.log.info("pull head repaired from its branch", {
        repo,
        pull: pull.number,
        from: pull.head_oid,
        to: tip,
      });
      repaired++;
    }
    if (updates.length > 0)
      app.bus.append({
        kind: "push",
        repoId: first.repo_id,
        payload: { updates, reconciled: true },
      });
  });
  return repaired;
}
