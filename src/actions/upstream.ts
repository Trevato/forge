/**
 * Propose upstream: a fork's own work, offered to the parent as one pull.
 *
 * The words are assembled, not asked for: every change that landed on the
 * fork since it last proposed is a line in the body, its title the pull's
 * title when there is one and a count when there are several. A person
 * presses one button and lands on the pull; nothing waits on the crew. A
 * proposal already open is returned rather than doubled.
 */

import type { App } from "../app.ts";
import { forkRelation } from "../core/following.ts";
import {
  forkParentFor,
  type Repo,
} from "../core/repos.ts";
import { listPulls, mergedPullsForRepos, type Pull } from "../core/pulls.ts";
import type { User } from "../core/users.ts";
import { aheadOids, resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { basicHeader, gitAuthEnv, redact, secretsIn } from "../origins/credentials.ts";
import { pushToOrigin } from "../origins/git-mirror.ts";
import { forgeLinkOf } from "../spawn/chain.ts";
import { parentCredential, type ParentCredential } from "../spawn/parent_credential.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireWriter, type AccessError } from "./access.ts";
import { openPull } from "./pulls.ts";

export interface Proposal {
  readonly pull: Pull;
  /** False when a proposal was already open and is returned as it stands. */
  readonly opened: boolean;
  /** How many of the fork's landed changes the proposal names. */
  readonly changes: number;
}

export type ProposeUpstreamError =
  | AccessError
  | "not_a_fork"
  | "nothing_to_propose"
  | { readonly kind: "refused"; readonly reason: string };

/** The open proposal from this fork's default branch, if one is. */
export function openProposal(
  app: App,
  fork: Repo,
  parent: Repo,
): Pull | undefined {
  return listPulls(app.db, parent.id, { sealed: true, state: "open", limit: 200 }).find(
    (p) => p.headRepoId === fork.id && p.headBranch === fork.defaultBranch,
  );
}

export async function proposeUpstream(
  app: App,
  actor: User | undefined,
  fork: Repo,
): Promise<Result<Proposal, ProposeUpstreamError>> {
  const writer = requireWriter(app, actor, fork);
  if (!writer.ok) return writer;
  const parent = forkParentFor(app.db, fork, actor);
  if (parent === undefined) return err("not_a_fork");
  const already = openProposal(app, fork, parent);
  if (already !== undefined)
    return ok({ pull: already, opened: false, changes: 0 });
  const relation = await forkRelation(app, fork, parent);
  if (relation === undefined || relation.ahead === 0)
    return err("nothing_to_propose");

  // What landed on the fork since it last proposed: the pulls, newest last,
  // so the body reads in the order the work happened — and only the pulls
  // whose landing commit is actually ahead of the parent. A fork whose work
  // reached upstream some other way (a push, a release) does not propose it
  // twice; without this, a first proposal once listed forty changes for one
  // commit ahead.
  const lastProposal = listPulls(app.db, parent.id, { sealed: true,
    state: "closed",
    limit: 200,
  })
    .filter((p) => p.headRepoId === fork.id)
    .map((p) => p.createdAt)
    .sort()
    .at(-1);
  const ahead = await aheadOids(
    repoDir(app.reposRoot, fork.ownerName, fork.name),
    relation.parentTip,
    relation.forkTip,
  );
  const landed = mergedPullsForRepos(app.db, [fork.id], 40)
    .filter(
      (p) =>
        p.mergedAt !== null &&
        p.mergedOid !== null &&
        ahead.has(p.mergedOid) &&
        (lastProposal === undefined || p.mergedAt > lastProposal),
    )
    .reverse();
  const name = `${fork.ownerName}/${fork.name}`;
  const title =
    landed.length === 1
      ? landed[0]!.title
      : landed.length > 1
        ? `${landed.length} changes from ${name}`
        : `${relation.ahead} commit${relation.ahead === 1 ? "" : "s"} from ${name}`;
  const lines = landed.map((p) => `- ${p.title} (${name}#${p.number})`);
  const body = [
    ...(lines.length > 0 ? [lines.join("\n")] : []),
    `${relation.ahead} commit${relation.ahead === 1 ? "" : "s"} ahead of ${parent.ownerName}/${parent.name}, proposed from ${name}'s following card.`,
  ].join("\n\n");
  const opened = await openPull(app, actor, parent, {
    title,
    body,
    baseBranch: parent.defaultBranch,
    headBranch: fork.defaultBranch,
    headRepo: fork,
  });
  if (!opened.ok)
    return err({
      kind: "refused",
      reason:
        typeof opened.error === "string"
          ? opened.error
          : ((opened.error as { kind?: string }).kind ?? "refused"),
    });
  return ok({ pull: opened.value, opened: true, changes: landed.length });
}

// ── Across forges. When the parent is another forge, the child pushes its
// change to `child/<name>/<branch>` there with the proposal token and opens
// the pull; the parent stays the truth and the child only caches its state.

export type ForgeProposalState = "open" | "merged" | "closed";

export interface ForgeProposal {
  readonly number: number;
  readonly title: string;
  readonly branch: string;
  readonly state: ForgeProposalState;
  /** False when the parent did not answer the last time it was asked. */
  readonly reachable: boolean;
  /** The pull's page on the parent forge. */
  readonly url: string;
}

export type ProposeForgeError =
  | AccessError
  | "no_parent_forge"
  | "nothing_to_propose"
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unreachable" };

/** A cached state is believed this long before the parent is asked again. */
export const STATE_TTL_MS = 60_000;
const ASK_TIMEOUT_MS = 5_000;
/** Only the newest few proposals are asked about at once. */
const REFRESHED = 5;
const PUSH_TIMEOUT_MS = 60_000;

interface Row {
  id: number;
  branch: string;
  number: number;
  title: string;
  source: string;
  state: string;
  reachable: number;
  checked_at: number;
}

const asProposal = (cred: ParentCredential, r: Row): ForgeProposal => ({
  number: r.number,
  title: r.title,
  branch: r.branch,
  state: r.state === "merged" || r.state === "closed" ? r.state : "open",
  reachable: r.reachable === 1,
  url: `${cred.url}/${cred.repo}/pulls/${r.number}`,
});

const apiUrl = (cred: ParentCredential, tail: string): string =>
  `${cred.url}/api/v1/repos/${cred.repo}/pulls${tail}`;

/** The parent's own words for a refusal, one line, with no secret in it. */
async function reasonOf(res: Response, cred: ParentCredential): Promise<string> {
  const text = await res.text().catch(() => "");
  let said = "";
  try {
    const d = JSON.parse(text) as { message?: unknown; error?: unknown };
    said = typeof d.message === "string" ? d.message : typeof d.error === "string" ? d.error : "";
  } catch {
    // not JSON: the status alone will do
  }
  return redact(said || `status ${res.status}`, cred.token).split("\n")[0]!.slice(0, 200);
}

/**
 * Push this forge's default branch to the parent as `child/<name>/<branch>`
 * and open the pull there, naming the change that landed here. One proposal
 * per tip: asking again for the same tip returns the one already made.
 */
export async function proposeToParentForge(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Promise<Result<ForgeProposal & { opened: boolean }, ProposeForgeError>> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  const link = await forgeLinkOf(app);
  const cred = await parentCredential(app);
  if (link === undefined || cred === undefined || link.repo !== `${repo.ownerName}/${repo.name}`)
    return err("no_parent_forge");

  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const tip = await resolveOid(dir, `refs/heads/${repo.defaultBranch}`);
  if (tip === undefined || tip === link.tip) return err("nothing_to_propose");
  const branch = `${repo.defaultBranch.replace(/[^A-Za-z0-9._-]/g, "-")}-${tip.slice(0, 8)}`;
  const known = app.db
    .query<Row, [string, string]>("SELECT * FROM upstream_proposal WHERE repo_id = ?1 AND branch = ?2")
    .get(repo.id, branch);
  if (known !== null) return ok({ ...asProposal(cred, known), opened: false });

  const landed = mergedPullsForRepos(app.db, [repo.id], 1)[0];
  const here = app.config.url ?? "";
  const source =
    landed === undefined
      ? `${repo.ownerName}/${repo.name}@${tip.slice(0, 8)}`
      : `${repo.ownerName}/${repo.name}#${landed.number}`;
  const title = landed?.title ?? `Changes from ${cred.child}`;

  const head = `child/${cred.child}/${branch}`;
  const auth = gitAuthEnv(cred.url, basicHeader(cred.child, cred.token));
  const ref = `refs/heads/${head}`;
  const push = (oldOid: string) =>
    pushToOrigin(dir, `${cred.url}/${cred.repo}.git`, [{ ref, oldOid, newOid: tip }], auth, {
      timeoutMs: PUSH_TIMEOUT_MS,
    });
  let pushed = await push("0".repeat(40));
  // An earlier press may have landed the branch and then lost the pull: the
  // branch is at this very tip, so pushing it again expecting it there is a
  // no-op that succeeds, and the pull opens on this try.
  if (!pushed.ok) {
    const again = await push(tip);
    if (again.ok) pushed = again;
  }
  if (!pushed.ok) {
    const reason = redact(pushed.error.message, ...secretsIn(auth), cred.token).split("\n")[0]!;
    return err(/could not resolve|unable to access|timed out|refused to connect|connection/i.test(reason)
      ? { kind: "unreachable" }
      : { kind: "refused", reason: reason.slice(0, 200) });
  }

  let res: Response;
  try {
    res = await fetch(apiUrl(cred, ""), {
      method: "POST",
      redirect: "manual",
      headers: { authorization: `Bearer ${cred.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        title: title.slice(0, 200),
        body: `Proposed by child ${cred.child}${here === "" ? "" : ` (${here})`}: ${source}.`,
        base: repo.defaultBranch,
        head,
      }),
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    });
  } catch {
    return err({ kind: "unreachable" });
  }
  if (!res.ok) return err({ kind: "refused", reason: await reasonOf(res, cred) });
  const made = (await res.json().catch(() => undefined)) as { number?: unknown } | undefined;
  if (typeof made?.number !== "number" || !Number.isSafeInteger(made.number))
    return err({ kind: "refused", reason: "the parent's answer was not a pull" });

  const now = Date.now();
  const inserted = app.db
    .query(
      `INSERT INTO upstream_proposal (repo_id, branch, number, title, source, state, reachable, checked_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'open', 1, ?6, ?6) ON CONFLICT (repo_id, branch) DO NOTHING`,
    )
    .run(repo.id, branch, made.number, title.slice(0, 200), source, now);
  if (inserted.changes > 0) announce(app, repo, actor, made.number, "open");
  const row = app.db
    .query<Row, [string, string]>("SELECT * FROM upstream_proposal WHERE repo_id = ?1 AND branch = ?2")
    .get(repo.id, branch)!;
  return ok({ ...asProposal(cred, row), opened: true });
}

/**
 * Tell an open chain page its Proposals card changed. Tied to the repository,
 * so the stream hands it only to those who can already see the forge.
 */
function announce(app: App, repo: Repo, actor: User | undefined, number: number, state: ForgeProposalState): void {
  app.bus.append({
    kind: "forge.proposal",
    repoId: repo.id,
    ...(actor === undefined ? {} : { actorId: actor.id }),
    payload: { repo: `${repo.ownerName}/${repo.name}`, number, state },
  });
}

/** Ask the parent how one pull stands; undefined when it did not say. */
async function readState(cred: ParentCredential, number: number): Promise<ForgeProposalState | undefined> {
  try {
    const res = await fetch(apiUrl(cred, `/${number}`), {
      redirect: "manual",
      headers: { authorization: `Bearer ${cred.token}` },
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const d = (await res.json()) as { state?: unknown; mergedAt?: unknown };
    if (typeof d.mergedAt === "string") return "merged";
    return d.state === "closed" ? "closed" : d.state === "open" ? "open" : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What this forge has proposed to its parent forge, newest first, each as
 * the parent last said. An open one older than the cache is asked again; a
 * parent that does not answer leaves the last state standing and marks it
 * unreachable, and is not asked again until the cache runs out.
 */
export async function forgeProposals(
  app: App,
  repo: Repo,
  now: number = Date.now(),
  /** Whether the parent may be asked: a signed-in viewer's, not an anonymous one's. */
  refresh = true,
): Promise<ForgeProposal[]> {
  const cred = await parentCredential(app);
  if (cred === undefined) return [];
  const rows = app.db
    .query<Row, [string]>("SELECT * FROM upstream_proposal WHERE repo_id = ?1 ORDER BY id DESC LIMIT 20")
    .all(repo.id);
  const fresh = await Promise.all(
    rows.map(async (r, i): Promise<Row> => {
      if (!refresh || i >= REFRESHED || r.state !== "open" || now - r.checked_at < STATE_TTL_MS) return r;
      const state = await readState(cred, r.number);
      const next = { ...r, state: state ?? r.state, reachable: state === undefined ? 0 : 1, checked_at: now };
      // The state is compared in the write itself, so two readers racing to
      // record the same change publish it once between them.
      const moved = app.db
        .query("UPDATE upstream_proposal SET state = ?1 WHERE id = ?2 AND state != ?1")
        .run(next.state, r.id);
      app.db
        .query("UPDATE upstream_proposal SET reachable = ?1, checked_at = ?2 WHERE id = ?3")
        .run(next.reachable, now, r.id);
      if (moved.changes > 0) announce(app, repo, undefined, r.number, next.state);
      return next;
    }),
  );
  return fresh.map((r) => asProposal(cred, r));
}

/** The one line that says how a proposal stands. */
export const forgeProposalLine = (p: ForgeProposal): string =>
  `#${p.number} ${p.title}: ${p.reachable ? p.state : `${p.state}, parent unreachable`}`;
