/**
 * Keeping a child's apps current with the parent's (`spawn/app_links.ts` is the link). The check
 * itself is the ordinary followed upstream's (`actions/upstream_follow.ts`); this is only who
 * calls it, and when:
 *
 *  - a hosted child awake in the parent's process is driven by the parent's own clock (its own
 *    process has no timers), and checked the moment an app it follows lands on the parent
 *    (`watchLandings`) or the moment it wakes (`followOnWake`);
 *  - a child in a cell of its own runs the clock itself, and hears of a landing in the answer
 *    to its heartbeat (`hearLandings`);
 *  - everything else is the existing hourly-or-so poll, which nothing here replaces.
 */

import type { App } from "../app.ts";
import { checkDue, checkUpstream, stagedRef } from "../actions/upstream_follow.ts";
import { getRepo, getRepoById } from "../core/repos.ts";
import { getFollow, listFollowing } from "../core/upstream_follow.ts";
import { resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { applyAppLinks, entriesOf, reasonOf, reconcileAppLinks } from "./app_links.ts";
import { refreshServed } from "./clients.ts";
import { hostedChildOpen, openChildren } from "./host.ts";

/** Look at every app this forge follows from its parent, now, whatever the clock says. */
export async function followParentNow(app: App): Promise<number> {
  let checked = 0;
  for (const f of listFollowing(app.db)) {
    if (f.via !== "parent") continue;
    const repo = getRepoById(app.db, f.repoId);
    if (repo === undefined) continue;
    try {
      if ((await checkUpstream(app, repo)).ok) checked++;
    } catch (error) {
      app.log.warn("followed app not checked", { repo: `${repo.ownerName}/${repo.name}`, error: String(error) });
    }
  }
  return checked;
}

/** A hosted child has woken: take any offer, then look at its apps. */
export async function followOnWake(parent: App, child: App): Promise<void> {
  if (!hostedChildOpen(parent, child)) return;
  await applyAppLinks(child);
  if (!hostedChildOpen(parent, child)) return;
  await followParentNow(child);
}

/**
 * The follow clock's tick, one minute: take an offer if this forge is a child, offer and end
 * credentials if it is a parent (paced), and drive the hosted children awake in this process.
 */
export async function followTick(app: App, boot = false): Promise<void> {
  const applied = await applyAppLinks(app);
  for (const name of applied.linked) {
    const [o, n] = name.split("/") as [string, string];
    const repo = getRepo(app.db, o, n);
    if (repo !== undefined) await checkUpstream(app, repo);
  }
  await reconcileAppLinks(app);
  // One child that cannot be opened or linked is that child's trouble: the rest are looked at all the same.
  for (const { name, app: child } of openChildren(app)) {
    try {
      if (!hostedChildOpen(app, child)) continue;
      const linked = await applyAppLinks(child, name);
      if (linked.linked.length > 0) await followParentNow(child);
      else await checkDue(child);
    } catch (error) {
      app.log.warn("a hosted child's follow pass failed", { forge: name, reason: reasonOf(error) });
    }
  }
  // The list /forges serves is read here, off any request: with a question to each child at a start, never after.
  await refreshServed(app, { probe: boot }).catch((error) =>
    app.log.warn("the forges list was not read", { reason: reasonOf(error) }),
  );
}

/**
 * When an app lands on this forge's default branch, every hosted child awake here that follows it
 * looks now. A child asleep takes it when it wakes; one in a cell hears it in its next heartbeat.
 * Returns the unsubscribe.
 */
export function watchLandings(parent: App): () => void {
  return parent.bus.subscribe((event) => {
    if (event.kind !== "push" || event.repoId === null) return;
    const updates = event.payload["updates"];
    if (!Array.isArray(updates)) return;
    const repo = getRepoById(parent.db, event.repoId);
    if (repo === undefined) return;
    if (!updates.some((u) => typeof u === "object" && u !== null && (u as Record<string, unknown>)["ref"] === `refs/heads/${repo.defaultBranch}`)) return;
    const ref = `${repo.ownerName}/${repo.name}`;
    for (const { app: child } of openChildren(parent)) void landed(parent, child, ref);
  });
}

async function landed(parent: App, child: App, ref: string): Promise<void> {
  try {
    const entry = entriesOf(await Bun.file(`${child.config.dataDir}/parent.json`).json().catch(() => undefined)).find(
      (e) => e.upstream === ref && e.appliedAt !== undefined && e.severedAt === undefined,
    );
    if (entry === undefined || !hostedChildOpen(parent, child)) return;
    const [o, n] = entry.repo.split("/") as [string, string];
    const repo = getRepo(child.db, o, n);
    if (repo !== undefined && getFollow(child.db, repo.id)?.enabled === true) await checkUpstream(child, repo);
  } catch (error) {
    parent.log.warn("a landed app was not passed to its child", { upstream: ref, error: String(error) });
  }
}

const OID = /^[0-9a-f]{40,64}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** What the parent's heartbeat answer carries, as the child reads it: bounded, shaped, never trusted for more than "look now". */
export function parseHints(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) return out;
  for (const [repo, tip] of Object.entries(v).slice(0, 50))
    if (REPO.test(repo) && typeof tip === "string" && OID.test(tip)) out[repo] = tip;
  return out;
}

/** The parent said these apps now stand at these tips: look at each whose tip this forge has not fetched. */
export async function hearLandings(app: App, hints: Record<string, string>): Promise<void> {
  for (const [name, tip] of Object.entries(hints)) {
    const [o, n] = name.split("/") as [string, string];
    const repo = getRepo(app.db, o, n);
    const follow = repo === undefined ? undefined : getFollow(app.db, repo.id);
    if (repo === undefined || follow === undefined || !follow.enabled || follow.via !== "parent") continue;
    const staged = await resolveOid(repoDir(app.reposRoot, o, n), stagedRef(follow.branch));
    if (staged !== tip) await checkUpstream(app, repo);
  }
}
