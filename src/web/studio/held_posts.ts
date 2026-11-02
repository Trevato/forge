/**
 * Which live posts arrived since the page was drawn, and what the button
 * that offers them says. Pure reads: ids in, ids and text out. `heldPostsJs`
 * is the same two functions as plain JS for the page.
 */

/** The ids in `fresh` not in `shown`, in `fresh`'s order, each once. */
export function newPostIds(shown: readonly string[], fresh: readonly string[]): string[] {
  const seen = new Set(shown);
  const out: string[] = [];
  for (const id of fresh) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** `1 new post`, `3 new posts`, and nothing for none. */
export function newPostsLabel(n: number): string {
  if (!(n >= 1)) return "";
  return n === 1 ? "1 new post" : `${n} new posts`;
}

export const heldPostsJs = /* js */ `
function newPostIds(shown, fresh) {
  var seen = {}, out = [], i;
  for (i = 0; i < shown.length; i++) seen['$' + shown[i]] = 1;
  for (i = 0; i < fresh.length; i++) {
    if (seen['$' + fresh[i]]) continue;
    seen['$' + fresh[i]] = 1;
    out.push(fresh[i]);
  }
  return out;
}
function newPostsLabel(n) {
  return !(n >= 1) ? '' : n === 1 ? '1 new post' : n + ' new posts';
}
`;
