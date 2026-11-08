/**
 * The releases view's sentences, said once for the web page and the
 * terminal alike (#5613). The live line is written as a template each
 * surface tags its own way: the page with `html`, escaping and marking up
 * the sha; the terminal with `plain`, joining the parts as they are.
 */

/** A template tag: the page's `html`, or `plain` for the terminal. */
export type Tag<T, V> = (strings: TemplateStringsArray, ...values: V[]) => T;

/** Joins a template's parts as they are: the terminal's tag. */
export function plain(strings: TemplateStringsArray, ...values: string[]): string {
  return String.raw({ raw: strings }, ...values);
}

/** "live: <sha> since <time>", in the surface's own tag. */
export function liveSince<T, V>(tag: Tag<T, V>, sha: V, since: V): T {
  return tag`live: ${sha} since ${since}`;
}

/** What the empty releases view says will fill it. */
export const NO_RELEASES_YET = "A pull landed on the forge's own repository is recorded here.";

/** Why a kept release offers no rollback: it is the one serving. */
export const ALREADY_LIVE = "This release is the one serving; there is nothing to roll back to.";

/** Why a kept release offers no rollback: its preflight failed or its schema is behind the live database's. */
export const NOT_ROLLABLE = "This release cannot be rolled back to: its preflight failed or its schema is behind the live database's.";
