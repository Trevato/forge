/**
 * One fork's own chain in plain words (#11432): the grandparent, the parent,
 * the fork itself and its children, each with how it follows its parent (the
 * fork tree page's `followModeWords`) and the path of its page. A link cut by
 * "sever" says so and stops the chain; a repository the caller cannot read is
 * left out, never named. Not the whole tree: only this fork's lineage.
 */

import type { App } from "../app.ts";
import { forkParentFor, visibleForks, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { SEVERED_LINE } from "./detach_words.ts";
import { followModeOf } from "./follow.ts";
import { FOLLOWS_NOTHING, followModeWords } from "./follow_words.ts";

export const MAX_CHAIN_CHILDREN = 20;

export interface ChainRow {
  readonly role: "grandparent" | "parent" | "this" | "child";
  readonly repo: string;
  /** The Following card's line, "Severed from its upstream." or "This repository follows nothing.". */
  readonly follows: string;
  /** Path of its page. */
  readonly page: string;
}

export interface ForkChain {
  readonly chain: ChainRow[];
  /** The chain above stopped at a severed link. */
  readonly severed: boolean;
  readonly truncated: boolean;
}

const nameOf = (r: Repo): string => `${r.ownerName}/${r.name}`;

/** Whether this repo was cut from its upstream: it names no parent and the ledger has the severing. */
function wasSevered(app: App, repo: Repo): boolean {
  if (repo.forkParentId !== null) return false;
  return (
    app.db.query("SELECT 1 FROM event WHERE repo_id = ?1 AND kind = 'repo.detached' LIMIT 1").get(repo.id) !== null
  );
}

async function rowOf(app: App, role: ChainRow["role"], repo: Repo, user: User | undefined): Promise<ChainRow> {
  const parent = forkParentFor(app.db, repo, user);
  let follows: string;
  if (parent !== undefined) follows = followModeWords(await followModeOf(app, repo), nameOf(parent)).line;
  else if (repo.forkParentId !== null) follows = FOLLOWS_NOTHING; // parent exists but is not the caller's to see
  else follows = wasSevered(app, repo) ? SEVERED_LINE : FOLLOWS_NOTHING;
  return { role, repo: nameOf(repo), follows, page: `/${repo.ownerName}/${repo.name}` };
}

/** The chain around `repo`; the caller has already shown they may read it. */
export async function forkChain(app: App, repo: Repo, user: User | undefined): Promise<ForkChain> {
  const parent = forkParentFor(app.db, repo, user);
  const grand = parent === undefined ? undefined : forkParentFor(app.db, parent, user);
  const kids = visibleForks(app.db, repo.id, user);
  const shown = kids.slice(0, MAX_CHAIN_CHILDREN);
  const rows: ChainRow[] = [];
  if (grand !== undefined) rows.push(await rowOf(app, "grandparent", grand, user));
  if (parent !== undefined) rows.push(await rowOf(app, "parent", parent, user));
  const self = await rowOf(app, "this", repo, user);
  rows.push(self);
  for (const k of shown) rows.push(await rowOf(app, "child", k, user));
  return { chain: rows, severed: rows.some((r) => r.role !== "child" && r.follows === SEVERED_LINE), truncated: kids.length > shown.length };
}
