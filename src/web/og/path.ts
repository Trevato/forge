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
