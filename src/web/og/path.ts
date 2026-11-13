/**
 * Where a page's own social card lives: `/og/<kind>/owner~name~number.png`.
 * Only a thread of a public repository, not sealed, has one an unfurler can
 * fetch; any other thread gets nothing here and the layout's site card stands in.
 */

interface Where {
  ownerName: string;
  name: string;
  visibility: string;
}

export function cardPath(
  kind: "issue" | "pull",
  repo: Where,
  thread: { number: number; sealed: boolean },
): string | undefined {
  // A sealed thread's card is a 404 to anyone signed out, as is a private repo's thread.
  if (repo.visibility !== "public" || thread.sealed) return undefined;
  return `/og/${kind}/${repo.ownerName}~${repo.name}~${thread.number}.png`;
}

/** A run's card, when the repo is public and the run's thread is not sealed (`visible`). */
export function runCardPath(repo: Where, runId: string, visible: boolean): string | undefined {
  if (repo.visibility !== "public" || !visible) return undefined;
  return `/og/run/${repo.ownerName}~${repo.name}~${runId}.png`;
}

/** An app's card, by its repository (never the platform slug): only a public app of a public repo has one. */
export function appCardPath(repo: Where, app: { access: string }): string | undefined {
  if (repo.visibility !== "public" || app.access !== "public") return undefined;
  return `/og/app/${repo.ownerName}~${repo.name}.png`;
}
