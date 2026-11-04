/**
 * A merge of a followed source that leaves its work behind (#9034).
 *
 * A pull whose head merges a source's tip but carries under `MIN_SHARE` of
 * that source's diff (an `-s ours` merge, or a "resolution" that kept our
 * tree) marks the source's commits as taken while dropping their content,
 * and git never offers them again. Such a pull never lands by itself,
 * trusted source or not: it waits for a person, and says what it dropped.
 */
import type { App } from "../app.ts";
import { getFollow } from "../core/upstream_follow.ts";
import { listSources, sourceRef } from "../core/follow_sources.ts";
import { pullDir, type Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { stagedRef } from "../actions/upstream_follow.ts";
import { runGitCapture } from "../git/env.ts";
import { resolveOid } from "../git/merge.ts";
import { MIN_SHARE, droppedWords, sourceShare } from "../git/source_share.ts";

export interface SourceDrop {
  /** The source's address, as written when it was followed. */
  readonly name: string;
  readonly tip: string;
  /** Under the minimum share: the pull waits for a person. */
  readonly held: boolean;
  /** What it dropped, as a sentence a person reads. */
  readonly words: string;
}

/** Every followed source (and the repository's upstream) whose head `pull` merges, with what it left out. */
export async function sourceDrops(app: App, repo: Repo, pull: Pull, baseTip: string): Promise<SourceDrop[]> {
  if (baseTip === "") return [];
  const follow = getFollow(app.db, repo.id);
  const targets = [
    ...(follow === undefined ? [] : [{ name: follow.url, ref: stagedRef(follow.branch) }]),
    ...listSources(app.db, repo.id).map((s) => ({ name: s.url, ref: sourceRef(s.id) })),
  ];
  if (targets.length === 0) return [];
  const dir = await pullDir(app.db, app.reposRoot, repo, pull);
  // An ordinary pull has no merge commit: a source is merged by one, so it pays nothing more.
  const merges = await runGitCapture(["rev-list", "--merges", "-1", `${baseTip}..${pull.headOid}`], { cwd: dir });
  if (merges.code !== 0 || merges.stdout.trim() === "") return [];
  const out: SourceDrop[] = [];
  for (const t of targets) {
    const current = await resolveOid(dir, t.ref);
    if (current === undefined) continue;
    const share = await sourceShare(dir, baseTip, pull.headOid, current);
    if (share === undefined) continue;
    const tip = share.tip;
    const held = share.share < MIN_SHARE;
    out.push({
      name: t.name,
      tip,
      held,
      words: `${held ? "merges" : "carries"} ${t.name} at ${tip.slice(0, 7)} and ${held ? "drops" : "leaves out"} ${droppedWords(share)} of its diff`,
    });
  }
  return out;
}

/** What waits for a person: one sentence per source whose merge dropped its content. */
export async function sourceHeld(app: App, repo: Repo, pull: Pull, baseTip: string): Promise<string[]> {
  return (await sourceDrops(app, repo, pull, baseTip))
    .filter((d) => d.held)
    .map((d) => `this pull ${d.words}: bring the work in, or a person decides`);
}

/** The review brief's lines for a pull: what each followed source it merges lost, as the forge measured. */
export async function reviewSourceNote(app: App, repo: Repo, pull: Pull, bare: string): Promise<string[]> {
  const baseTip = (await resolveOid(bare, `refs/heads/${pull.baseBranch}`)) ?? "";
  return (await sourceDrops(app, repo, pull, baseTip)).map((d) => `this pull ${d.words}`);
}
