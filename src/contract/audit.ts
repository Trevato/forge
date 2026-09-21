/**
 * What the apps on this forge allow, read from git.
 *
 * An app's `contract.json` is its policy, and the evaluator that reads it
 * here is the one the app decides with (`can.ts`, carried verbatim into
 * every scaffolded app). So "who can do what, across everything" is a
 * question of reading one file per repository at its default branch —
 * nothing is run, nothing is asked of the app.
 *
 * An app without the file is not wrong, it is unread: its doors are written
 * by hand and this lens cannot see them. It is listed as such, because an
 * audit that leaves out what it cannot read reads as a clean bill.
 */

import { readFileAt } from "../apps/checkout.ts";
import type { Repo } from "../core/repos.ts";
import { resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import {
  identities,
  readContract,
  table,
  type Cell,
  type Contract,
} from "./can.ts";

/** Past this a file is not a policy anyone reads; it is refused unparsed. */
const CONTRACT_MAX_BYTES = 256 * 1024;

export type Standing =
  /** No `contract.json`: the doors are hand-written. */
  | { readonly kind: "unread" }
  /** There is one and it does not hold; an app built on it does not boot. */
  | { readonly kind: "unsound"; readonly problems: readonly string[] }
  | {
      readonly kind: "sound";
      readonly contract: Contract;
      /** The roles someone can be, floor first. */
      readonly identities: readonly string[];
      readonly cells: readonly Cell[];
      /** What the floor may do: open to anyone who can reach the app. */
      readonly open: readonly Cell[];
    };

export interface Audited {
  readonly repo: Repo;
  /** The commit that was read; absent on a repository with no commits. */
  readonly oid?: string | undefined;
  readonly standing: Standing;
}

export function standingOf(text: string | undefined): Standing {
  if (text === undefined) return { kind: "unread" };
  if (text.length > CONTRACT_MAX_BYTES)
    return {
      kind: "unsound",
      problems: ["contract.json is too large to be a policy"],
    };
  const read = readContract(text);
  if (!read.ok) return { kind: "unsound", problems: read.problems };
  const who = identities(read.contract);
  const floor = who.find(
    (name) => read.contract.roles[name]!.held.by === "everyone",
  );
  const cells = table(read.contract);
  return {
    kind: "sound",
    contract: read.contract,
    identities: [
      ...who.filter((n) => n === floor),
      ...who.filter((n) => n !== floor),
    ],
    cells,
    open: cells.filter((c) => c.as === floor && c.answer !== "no"),
  };
}

/** Read one repository's policy at the tip of its default branch. */
export async function audit(reposRoot: string, repo: Repo): Promise<Audited> {
  const dir = repoDir(reposRoot, repo.ownerName, repo.name);
  const oid = await resolveOid(dir, `refs/heads/${repo.defaultBranch}`);
  if (oid === undefined) return { repo, standing: { kind: "unread" } };
  return {
    repo,
    oid,
    standing: standingOf(await readFileAt(dir, oid, "contract.json")),
  };
}
