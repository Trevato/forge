/**
 * The name and address a commit the forge writes for a person carries.
 *
 * A commit is published in every clone of a public repository, forever, and
 * an address in it cannot be taken back without rewriting history. So the
 * address is one the person chose to publish: a no-reply address on this
 * forge's own host unless they opted in to their account email on the
 * settings page (#623). The account email itself is never the default.
 */

import type { ForgeConfig } from "../app.ts";
import type { User } from "./users.ts";

export interface CommitIdentity {
  readonly name: string;
  readonly email: string;
}

/** The host this forge is reached at: its public URL's, else its own name. */
export function forgeHost(config: Pick<ForgeConfig, "url" | "host">): string {
  return config.url !== undefined
    ? new URL(config.url).hostname
    : (config.host ?? "localhost");
}

/** `<username>@users.noreply.<host>` — an address that reaches nobody. */
export function noreplyAddress(username: string, host: string): string {
  return `${username}@users.noreply.${host}`;
}

/**
 * Who a commit says wrote it. An agent's address is the forge's own
 * invention (`…@agents.invalid`) and names nobody's mailbox, so it is used
 * as it is; a person's is their no-reply address unless they opted in.
 */
export function commitIdentity(
  config: Pick<ForgeConfig, "url" | "host">,
  user: Pick<User, "username" | "displayName" | "email" | "kind" | "commitEmail">,
): CommitIdentity {
  const name = user.displayName || user.username;
  if (user.kind === "agent" || user.commitEmail === "account")
    return { name, email: user.email };
  return { name, email: noreplyAddress(user.username, forgeHost(config)) };
}
