/**
 * Who an event is for.
 *
 * The outbox records everything that happens to a repository, and most of it
 * is for anyone who may read the repository: a push, an issue, a merge. Some
 * of it is configuration — a webhook's URL, which is often a secret in
 * itself; the names of an app's variables; which settings changed — and that
 * is for the repository's admins. And some is one person's own choice, like
 * keeping a repository on their machine, which is for them.
 *
 * Every surface that hands events to a reader — the JSON outbox, the two
 * event streams, the activity rail, the terminal's feed — asks here first, so
 * a new surface cannot forget and a new kind is classified once. An event of
 * a kind nobody classified is for readers, as it always was.
 */

import { isActive } from "./users.ts";
import {
  canSeeSealed,
  eventRow,
  eventRows,
  eventSubject,
  subjectKey,
  type SealedRow,
} from "./sealed.ts";
import type { Database } from "bun:sqlite";
import type { ForgeEvent } from "./events.ts";
import { getAppByRepo } from "./apps.ts";
import { canAdmin, canEnterApp, canSeeOwnerFacts, getRepoById } from "./repos.ts";
import type { User } from "./users.ts";

export type EventAudience = "readers" | "admins" | "actor" | "app";

export function eventAudience(kind: string): EventAudience {
  if (
    kind.startsWith("webhook.") ||
    kind.startsWith("app.env_") ||
    kind.startsWith("app.domain.") ||
    kind.startsWith("prompt.") ||
    kind.startsWith("secret.") ||
    // The forge's mail ceiling is its owner's to hear (`actions/mail.ts`).
    kind.startsWith("mail.") ||
    // A restore drill's verdict is the forge owner's (`snapshot/service.ts`).
    kind.startsWith("drill.") ||
    // A snapshot moving is the forge owner's too, and has no repository.
    kind.startsWith("backup.") ||
    // A report from outside waits for a person who decides; its arrival is
    // theirs to see, never the readers' (`actions/reports.ts`).
    kind.startsWith("report.") ||
    kind === "repo.settings_updated" ||
    // Which of a person's connected accounts a mirror now syncs through is
    // the repository's configuration, as a webhook's URL is.
    kind === "origin.mirror_reattached" ||
    kind === "repo.crew_outsiders"
  )
    return "admins";
  // A fleet operation spans repositories; its receipt is its actor's. So is
  // a thought: it belongs to no repository and to nobody but its author.
  if (
    kind === "repo.pinned" ||
    kind === "repo.unpinned" ||
    kind.startsWith("fleet.") ||
    kind.startsWith("thought.")
  )
    return "actor";
  // A run's summary, an app's serving state and its pictures can carry the
  // app's own output: for a private app they are for those who may enter it
  // (#620, #599).
  if (kind.startsWith("run.") || kind.startsWith("app.") || kind.startsWith("look."))
    return "app";
  return "readers";
}

/**
 * A reader's view of events they may already see by repository: the ones
 * meant for them. `admins` is remembered per repository for the life of the
 * returned function, so a stream asks once per repository, not per event.
 */
export function audienceFilter(
  db: Database,
  viewer: User | undefined,
  /**
   * The events about to be filtered, when the caller has them all: their
   * subjects are read in one query per chunk instead of one per subject.
   */
  batch?: readonly ForgeEvent[],
): (event: ForgeEvent) => boolean {
  const admins = new Map<string, boolean>();
  const isAdmin = (repoId: string): boolean => {
    const known = admins.get(repoId);
    if (known !== undefined) return known;
    const repo = getRepoById(db, repoId);
    const yes = repo !== undefined && canAdmin(db, repo, viewer);
    admins.set(repoId, yes);
    return yes;
  };
  const entrants = new Map<string, boolean>();
  const mayEnter = (repoId: string): boolean => {
    const known = entrants.get(repoId);
    if (known !== undefined) return known;
    const repo = getRepoById(db, repoId);
    const record = repo === undefined ? undefined : getAppByRepo(db, repoId);
    const yes =
      repo !== undefined &&
      (record === undefined ||
        canEnterApp(db, repo, record, viewer, { named: false }));
    entrants.set(repoId, yes);
    return yes;
  };
  // An event about a sealed issue or pull — by number or by id — is for
  // those who may see it (`sealed.ts`), whatever its kind says.
  const sealedSeers = new Map<string, boolean>();
  const maySeeSealed = (repoId: string): boolean => {
    const known = sealedSeers.get(repoId);
    if (known !== undefined) return known;
    const repo = getRepoById(db, repoId);
    const yes = repo !== undefined && canSeeSealed(db, repo, viewer);
    sealedSeers.set(repoId, yes);
    return yes;
  };
  // Its reporter follows it too, for that one issue (`mayView`).
  const subjects = new Map<string, SealedRow | null>();
  if (batch !== undefined) {
    const rows = eventRows(db, batch);
    for (const event of batch) {
      const subject = eventSubject(event);
      if (subject === undefined) continue;
      const key = subjectKey(subject);
      subjects.set(key, rows.get(key) ?? null);
    }
  }
  const hidden = (event: ForgeEvent): boolean => {
    const subject = eventSubject(event);
    if (subject === undefined) return false;
    const key = subjectKey(subject);
    let row = subjects.get(key);
    if (row === undefined) {
      row = eventRow(db, event) ?? null;
      subjects.set(key, row);
    }
    if (row === null || !row.sealed) return false;
    if (viewer !== undefined && viewer.id === row.authorId && isActive(viewer))
      return false;
    return !maySeeSealed(event.repoId!);
  };
  return (event) => {
    if (hidden(event)) return false;
    switch (eventAudience(event.kind)) {
      case "readers":
        return true;
      case "app":
        return event.repoId === null || mayEnter(event.repoId);
      case "actor":
        return viewer !== undefined && event.actorId === viewer.id;
      case "admins":
        return event.repoId === null
          ? viewer?.isAdmin === true && isActive(viewer)
          : isAdmin(event.repoId);
    }
  };
}

/** What a run event says about spend and placement: the owner's own facts. */
const RUN_OWNER_FIELDS = ["costUsd", "turns", "placement", "node"] as const;

/**
 * An event as this reader may see it. A `run.*` payload carries its cost,
 * turns and node, which are owner facts (`canSeeOwnerFacts`) like the same
 * fields on a run; the rest of the event is unchanged. Webhooks do not pass
 * through here: they go to admins and keep the full payload.
 */
export function eventForReader(
  db: Database,
  viewer: User | undefined,
): (event: ForgeEvent) => ForgeEvent {
  const owners = new Map<string, boolean>();
  const isOwner = (repoId: string): boolean => {
    const known = owners.get(repoId);
    if (known !== undefined) return known;
    const repo = getRepoById(db, repoId);
    const yes = repo !== undefined && canSeeOwnerFacts(db, repo, viewer);
    owners.set(repoId, yes);
    return yes;
  };
  return (event) => {
    if (!event.kind.startsWith("run.")) return event;
    if (event.repoId !== null && isOwner(event.repoId)) return event;
    const payload = { ...event.payload };
    for (const field of RUN_OWNER_FIELDS) delete payload[field];
    return { ...event, payload };
  };
}
