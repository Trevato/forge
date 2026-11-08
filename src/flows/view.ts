/**
 * One repository's flows as plain data (#9434): what comes in (its upstream,
 * the sources it follows, the packages it pins) and what goes out (forks,
 * the mirror it pushes to). Read from state the forge already keeps; no
 * network and no model.
 */

import type { Database } from "bun:sqlite";
import { canRead, getRepoById, visibleForks, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";

export interface FlowLine {
  readonly kind: "origin" | "source" | "upstream" | "fork" | "mirror";
  readonly label: string;
  /** In-forge link, when the line is a repository here. */
  readonly href: string;
  readonly state: string;
  /** When it last moved (ISO), or null. */
  readonly at: string | null;
  readonly problem: boolean;
}

export interface FlowView {
  readonly inbound: FlowLine[];
  readonly outbound: FlowLine[];
}

/** A followed URL as shown to any reader: no userinfo (`user:token@`), no query, no fragment. */
export function plainUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    // Not a URL (scp-style `user@host:path`): drop anything before the last `@`.
    return raw.replace(/^[^@/]*@/, "");
  }
}

const base = (r: Repo) => `/${r.ownerName}/${r.name}`;

function behindWords(behind: number, error: string): string {
  if (error !== "") return "could not be read";
  return behind === 0 ? "up to date" : `${behind} ${behind === 1 ? "change" : "changes"} behind`;
}

export function readFlows(db: Database, repo: Repo, viewer: User | undefined): FlowView {
  const inbound: FlowLine[] = [];
  const outbound: FlowLine[] = [];
  if (repo.forkParentId !== null) {
    const parent = getRepoById(db, repo.forkParentId);
    if (parent && canRead(db, parent, viewer)) {
      inbound.push({ kind: "origin", label: `${parent.ownerName}/${parent.name}`, href: base(parent), state: "forked from", at: null, problem: false });
    }
  }
  const up = db
    .query<{ url: string; branch: string; enabled: number; checked_at: string | null; behind: number; error: string }, [string]>(
      "SELECT url, branch, enabled, checked_at, behind, error FROM repo_upstream WHERE repo_id = ?1",
    )
    .get(repo.id);
  if (up) {
    inbound.push({
      kind: "upstream", label: `${plainUrl(up.url)} (${up.branch})`, href: "", at: up.checked_at, problem: up.error !== "",
      state: up.enabled === 0 ? "not following" : behindWords(up.behind, up.error),
    });
  }
  for (const s of db
    .query<{ url: string; branch: string; enabled: number; checked_at: string | null; behind: number; error: string }, [string]>(
      "SELECT url, branch, enabled, checked_at, behind, error FROM repo_source WHERE repo_id = ?1 ORDER BY created_at",
    )
    .all(repo.id)) {
    inbound.push({
      kind: "source", label: `${plainUrl(s.url)} (${s.branch})`, href: "", at: s.checked_at, problem: s.error !== "",
      state: s.enabled === 0 ? "not following" : behindWords(s.behind, s.error),
    });
  }
  for (const f of visibleForks(db, repo.id, viewer)) {
    outbound.push({ kind: "fork", label: `${f.ownerName}/${f.name}`, href: base(f), state: "fork", at: null, problem: false });
  }
  const mirror = db
    .query<{ full_name: string; pushed_at: string | null; last_error: string }, [string]>(
      "SELECT full_name, pushed_at, last_error FROM migrate_mirror WHERE repo_id = ?1",
    )
    .get(repo.id);
  if (mirror) {
    outbound.push({
      kind: "mirror", label: mirror.full_name, href: "", at: mirror.pushed_at, problem: mirror.last_error !== "",
      state: mirror.last_error !== "" ? "last push failed" : "mirrored",
    });
  }
  return { inbound, outbound };
}
