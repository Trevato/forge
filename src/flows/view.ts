/**
 * One repository's flows as plain data (#9434): what comes in (its upstream,
 * the sources it follows, the packages it pins) and what goes out (forks,
 * the mirror it pushes to). Read from state the forge already keeps; no
 * network and no model.
 */

import type { Database } from "bun:sqlite";
import { getCursor } from "../core/origins.ts";
import { forkFollowMode } from "../core/fork_follow.ts";
import { canAdmin, canRead, canWrite, getRepoById, repoDatesFor, visibleForks, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { aheadWords, parseAhead } from "../origins/ahead.ts";
import { counts, lastScanAt } from "../checks/scan_store.ts";

/** A followed link is stale when its last head comparison is older than this (three follow periods). */
export const STALE_MS = 3 * 30 * 60_000;

/** How a link stands: `ok` level, `behind` has news, `diverged` both moved, `unread` could not be read, `stale` not read lately, `off` not following, `none` nothing to compare. */
export type Health = "ok" | "behind" | "diverged" | "unread" | "stale" | "off" | "none";

/** One thing a person may do about a link: a same-origin POST, or a link to a page. */
export interface FlowAction {
  readonly label: string;
  readonly href: string;
  readonly post: boolean;
  /** Hidden fields the POST carries (a form needs them to reach an existing action). */
  readonly fields?: Readonly<Record<string, string>>;
}

export interface FlowLine {
  readonly kind: "origin" | "source" | "upstream" | "fork" | "mirror" | "forge" | "scan";
  readonly label: string;
  /** In-forge link, when the line is a repository here. */
  readonly href: string;
  readonly state: string;
  /** When it last moved (ISO), or null. */
  readonly at: string | null;
  readonly problem: boolean;
  readonly health: Health;
  /** The followed source's id, for the line that stops it. */
  readonly id?: string;
  readonly action?: FlowAction;
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

/** Health of a followed link from its last comparison; `now` is injectable for tests. */
export function followHealth(
  r: { enabled: boolean; checkedAt: string | null; behind: number; error: string },
  now: number,
): Health {
  if (!r.enabled) return "off";
  if (r.error !== "") return "unread";
  if (r.checkedAt === null || now - Date.parse(r.checkedAt) > STALE_MS) return "stale";
  return r.behind > 0 ? "behind" : "ok";
}

export function readFlows(db: Database, repo: Repo, viewer: User | undefined, now = Date.now()): FlowView {
  const writer = viewer !== undefined && viewer.kind !== "agent" && canWrite(db, repo, viewer);
  const admin = viewer !== undefined && viewer.kind !== "agent" && canAdmin(db, repo, viewer);
  const inbound: FlowLine[] = [];
  const outbound: FlowLine[] = [];
  if (repo.forkParentId !== null) {
    const parent = getRepoById(db, repo.forkParentId);
    if (parent && canRead(db, parent, viewer)) {
      inbound.push({
        kind: "origin", label: `${parent.ownerName}/${parent.name}`, href: base(parent), state: "forked from", at: null, problem: false, health: "none",
        ...(writer ? { action: { label: `Offer what's useful to ${parent.ownerName}/${parent.name}`, href: `${base(repo)}/pulls/new`, post: false } } : {}),
      });
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
      health: followHealth({ enabled: up.enabled !== 0, checkedAt: up.checked_at, behind: up.behind, error: up.error }, now),
      state: up.enabled === 0 ? "not following" : behindWords(up.behind, up.error),
      ...(admin
        ? {
            action: {
              label: up.enabled === 0 ? "Follow again" : "Stop following",
              href: `${base(repo)}/settings/upstream`,
              post: true,
              fields: { url: up.url, branch: up.branch, ...(up.enabled === 0 ? { enabled: "on" } : {}), back: `${base(repo)}/flows` },
            },
          }
        : {}),
    });
  }
  for (const s of db
    .query<{ id: string; url: string; branch: string; enabled: number; checked_at: string | null; behind: number; error: string }, [string]>(
      "SELECT id, url, branch, enabled, checked_at, behind, error FROM repo_source WHERE repo_id = ?1 ORDER BY created_at",
    )
    .all(repo.id)) {
    inbound.push({
      kind: "source", id: s.id, label: `${plainUrl(s.url)} (${s.branch})`, href: "", at: s.checked_at, problem: s.error !== "",
      health: followHealth({ enabled: s.enabled !== 0, checkedAt: s.checked_at, behind: s.behind, error: s.error }, now),
      state: s.enabled === 0 ? "not following" : behindWords(s.behind, s.error),
      ...(admin
        ? { action: { label: "Stop following", href: `${base(repo)}/settings/sources/${s.id}/remove`, post: true, fields: { back: `${base(repo)}/flows` } } }
        : {}),
    });
  }
  if (repo.origin !== null) {
    const ahead = parseAhead(getCursor(db, repo.origin.originId, `repo:${repo.id}:ahead`));
    const read = getCursor(db, repo.origin.originId, `repo:${repo.id}:ahead-read`);
    const seenAt = ahead?.at ?? read ?? null;
    const old = seenAt === null || now - Date.parse(seenAt) > STALE_MS;
    const health: Health = old ? "stale" : ahead !== undefined ? (ahead.diverged ? "diverged" : "behind") : "ok";
    inbound.push({
      kind: "origin", label: "its origin", href: "", at: seenAt, problem: ahead?.diverged === true, health,
      state: seenAt === null ? "not read yet" : old ? "not read lately" : ahead === undefined ? "up to date" : aheadWords(ahead),
      ...(writer && health === "behind" ? { action: { label: "Pull in what's new", href: `${base(repo)}/sync/take`, post: true } } : {}),
    });
  }
  const forks = visibleForks(db, repo.id, viewer);
  const dates = repoDatesFor(db, forks.map((f) => f.id));
  for (const f of forks) {
    const d = dates.get(f.id);
    const mode = forkFollowMode(db, f.id);
    outbound.push({
      kind: "fork", label: `${f.ownerName}/${f.name}`, href: base(f), at: d?.pushedAt ?? d?.createdAt ?? null, problem: false, health: "none",
      state: mode === "take-updates" ? "fork, takes updates" : "fork, told of updates",
      ...(viewer !== undefined && viewer.kind !== "agent" && canAdmin(db, f, viewer)
        ? { action: { label: "Follow mode", href: `${base(f)}/following`, post: false } }
        : {}),
    });
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
      health: mirror.last_error !== "" ? "unread" : "ok",
    });
  }
  inbound.push(scanLine(db, repo));
  // Forges that follow this one: a child forge holds a proposal token for it. Their names are for those who write here.
  if (writer) {
    for (const c of db
      .query<{ child: string; origin: string; created_at: string; last_used_at: string | null; expires_at: string | null }, [string]>(
        `SELECT p.child, p.origin, t.created_at, t.last_used_at, t.expires_at
           FROM proposal_token p JOIN token t ON t.id = p.token_id WHERE p.repo_id = ?1 ORDER BY t.created_at LIMIT 50`,
      )
      .all(repo.id)) {
      const ended = c.expires_at !== null && Date.parse(c.expires_at) <= now;
      outbound.push({
        kind: "forge", label: `${c.child} (${plainUrl(c.origin)})`, href: "", at: c.last_used_at ?? c.created_at, problem: false,
        health: ended ? "stale" : "none", state: ended ? "forge follows, token ended" : "forge follows",
      });
    }
  }
  return { inbound, outbound };
}

/** Code scanning as one line (#9593): what the push and nightly passes found, open high first. */
export function scanLine(db: Database, repo: Repo): FlowLine {
  const c = counts(db, repo.id);
  const push = lastScanAt(db, repo.id, "push");
  const nightly = lastScanAt(db, repo.id, "nightly");
  const at = push === null ? nightly : nightly === null || push > nightly ? push : nightly;
  const state =
    at === null ? "not scanned yet"
    : c.openHigh > 0 ? `${c.openHigh} high ${c.openHigh === 1 ? "finding holds" : "findings hold"} releases`
    : c.open > 0 ? `${c.open} open ${c.open === 1 ? "finding" : "findings"}`
    : "no open findings";
  return {
    kind: "scan", label: "Code scanning", href: `${base(repo)}/findings`, state, at, problem: c.openHigh > 0,
    health: at === null ? "none" : c.openHigh > 0 ? "unread" : c.open > 0 ? "behind" : "ok",
  };
}
