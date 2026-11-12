/**
 * The follow actions of a flow line, for a door that has no form (the
 * terminal): the same two functions the settings routes call, so the same
 * admin check decides. Plain data in (a line the view produced), a verdict out.
 */

import type { App } from "../app.ts";
import { removeFollowSource } from "../actions/follow_sources.ts";
import { setFollowUpstream } from "../actions/upstream_follow.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { getFollow } from "../core/upstream_follow.ts";
import type { FlowLine } from "./view.ts";

export type Acted = { ok: true; message: string } | { ok: false; why: string };

/** Stop (or resume) following the line's source; refused for anyone the page would not offer it to. */
export function actOnFollow(app: App, repo: Repo, user: User | undefined, line: FlowLine): Acted {
  if (user === undefined || user.kind === "agent") return { ok: false, why: "Only an admin of this repository can do this." };
  if (line.kind === "source" && line.id !== undefined) {
    const gone = removeFollowSource(app, user, repo, line.id);
    return gone.ok ? { ok: true, message: "No longer following that source." } : { ok: false, why: "Only an admin of this repository can do this." };
  }
  if (line.kind === "upstream") {
    const follow = getFollow(app.db, repo.id);
    if (follow === undefined) return { ok: false, why: "Nothing is followed." };
    const saved = setFollowUpstream(app, user, repo, { url: follow.url, branch: follow.branch, enabled: !follow.enabled });
    return saved.ok ? { ok: true, message: saved.value.enabled ? "Following the upstream again." : "Following the upstream is off." } : { ok: false, why: "Only an admin of this repository can do this." };
  }
  return { ok: false, why: "That line has nothing to follow." };
}
