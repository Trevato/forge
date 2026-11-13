/**
 * What an origin's token can see, remembered. A GitHub token without the
 * `repo` scope — or a fine-grained one limited to public repositories —
 * lists public repositories only, and a picker with no private rows looks
 * broken unless it says why (#7516).
 *
 * The answer costs a request or two at the origin, so it is kept per
 * origin for a while and forgotten the moment the token is replaced.
 */

import type { App } from "../app.ts";
import type { Origin } from "../core/origins.ts";
import { providerForOrigin } from "./credential.ts";
import type { TokenReach } from "./types.ts";

const KEEP_MS = 10 * 60_000;
const MAX_KEPT = 256;
const kept = new Map<string, { reach: TokenReach; at: number }>();

const keyOf = (dataDir: string, originId: string): string =>
  `${dataDir} ${originId}`;

/**
 * The origin's reach, or undefined when its provider names none or the
 * origin did not answer — the picker then says nothing rather than guess.
 */
export async function tokenReach(
  app: App,
  origin: Origin,
): Promise<TokenReach | undefined> {
  const key = keyOf(app.config.dataDir, origin.id);
  const hit = kept.get(key);
  if (hit !== undefined && Date.now() - hit.at < KEEP_MS) return hit.reach;
  const provider = providerForOrigin(app, origin);
  if (!provider.ok || provider.value.tokenReach === undefined) return undefined;
  const read = await provider.value.tokenReach();
  if (!read.ok) return undefined;
  if (kept.size >= MAX_KEPT) {
    const oldest = kept.keys().next();
    if (!oldest.done) kept.delete(oldest.value);
  }
  kept.set(key, { reach: read.value, at: Date.now() });
  return read.value;
}

/** Drop what was learned about an origin's token: it was replaced or removed. */
export function forgetTokenReach(dataDir: string, originId: string): void {
  kept.delete(keyOf(dataDir, originId));
}

export const PUBLIC_ONLY =
  "This token sees public repositories only, so private ones won't appear";

export const FINE_GRAINED_NOTE =
  "A fine-grained token: Repository access: All repositories; Contents: Read";

/** A refused replacement, in words — the page and the terminal say the same. */
export function replaceTokenMessage(error: string): string {
  const words: Record<string, string> = {
    not_found: "No such origin.",
    other_account:
      "That token belongs to another account. Connect it as its own origin instead.",
    bad_token: "That token was refused by the origin.",
    unreachable: "That instance could not be reached.",
    rate_limited: "Too many connect attempts. Wait a minute.",
    unauthorized: "Sign in first.",
    admin_account:
      "That token is an administrator's. This forge does not accept one; use an everyday account's.",
    can_push:
      "That token can push to a protected repository. This forge does not accept one that can.",
    guard_unchecked:
      "This forge could not check what that token can do. Try again in a minute.",
  };
  return words[error] ?? "That token could not be put on this origin.";
}

/** GitHub's new-token page with the scope the picker needs filled in. */
export const newTokenUrl = (webUrl: string): string =>
  `${webUrl.replace(/\/+$/, "")}/settings/tokens/new?scopes=repo&description=forge-migrate`;
