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
 * a kind nobody classified is for admins; kinds for readers are listed.
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
import { personOwners } from "./orgs.ts";
import { getTeam } from "./teams.ts";
import { canAdmin, canEnterApp, canWrite, canSeeOwnerFacts, getRepoById } from "./repos.ts";
import type { User } from "./users.ts";

export type EventAudience = "readers" | "admins" | "actor" | "app" | "writers" | "team";

/**
 * Whether this viewer answers for a deleted repository: the forge's admin, who
 * deleted it, or its owner (a person, or an org's owners while the org lasts).
 * Its row is gone, so its owner comes from the event.
 */
function answersForDeleted(db: Database, viewer: User | undefined, event: ForgeEvent): boolean {
  if (viewer === undefined || !isActive(viewer)) return false;
  if (viewer.isAdmin || event.actorId === viewer.id) return true;
  const owner = event.payload.ownerId;
  return typeof owner === "string" && (owner === viewer.id || personOwners(db, owner).includes(viewer.id));
}

/** A `repo.deleted` names its repository; unless it was public (said so outright), the name is not for readers. */
const namesHiddenRepo = (event: ForgeEvent): boolean =>
  event.kind === "repo.deleted" &&
  event.payload.repo !== undefined &&
  event.payload.visibility !== "public";

const READER_KINDS: ReadonlySet<string> = new Set([
  // Whether a repository follows an upstream, never where: the address is
  // the admins' (`repo.upstream_follow`).
  "repo.following",
  "issue.labeled",
  "issue.first",
  "issue.ranked",
  "week.retro",
  "issue.closed",
  "issue.gate_reviewed",
  "issue.commented",
  "usage.delta",
  "issue.raised",
  "issue.blocked",
  "pull.pushed",
  "forge.spawn.live",
  "forge.spawn.failed",
  "fork.diverged",
  "push",
  "account.parent_linked",
  "account.parent_unlinked",
  "account.edge_linked",
  "account.edge_unlinked",
  "account.notify_set",
  "limb.moved",
  "repo.imported",
  "repo.mirrored",
  "account.signed_out",
  "session.ended",
  "label.created",
  "pull.labeled",
  "issue.edited",
  "pull.edited",
  "issue.sealed",
  "issue.unsealed",
  "issue.assigned",
  "pull.assigned",
  "pull.commented",
  "issue.reopened",
  "pull.closed",
  "pull.reopened",
  "pull.opened",
  "pull.merged",
  "pull.bypassed",
  "issue.opened",
  "spend.reported",
  "forge.proposal",
  "pull.held",
  "pull.released",
  "org.created",
  "team.created",
  "team.deleted",
  "team.member_added",
  "team.member_removed",
  "team.member_role_set",
  "forge.spawn.started",
  "forge.spawned",
  "forge.removed",
  "forge.stopped",
  "forge.claim_reissued",
  "forge.claim_revoked",
  "forge.claim_restored",
  "agent.created",
  "agent.updated",
  "agent.deleted",
  "crew.added",
  "crew.removed",
  "account.model_granted",
  "account.model_added",
  "account.ceiling_set",
  "pull.reviewed",
  "pull.thread_resolved",
  "pull.run_granted",
  "pull.guest_approved",
  "team.changed",
  "forge.severed",
  "forge.follow_mode",
  "token.created",
  "token.deleted",
  "issue.teams",
  "account.role_set",
  "account.email_verified",
  "account.recovered",
  "limb.replan",
  "limb.replan_taken_back",
  "invite.minted",
  "invite.revoked",
  "user.created",
  "user.recovered",
  "board.saved",
  "board.deleted",
  "repo.created",
  "repo.vision_kept",
  "repo.forked",
  "repo.links_probed",
  "repo.detached",
  "repo.deleted",
  // Who moved a repository from where to where (#569): its readers knew both paths.
  "repo.transferred",
  "label.updated",
  "label.deleted",
  "telemetry.granted",
  "telemetry.revoked",
  "account.suspended",
  "account.unsuspended",
  "org.retired",
  "account.removed",
  "branch.created",
  "branch.deleted",
  "build.pinned",
  "build.deleted",
  "build.noted",
  // A pin's screenshots are read by its repository's readers (`actions/build_shots.ts`).
  "build.shots",
  "invite.used",
  "user.updated",
  "user.key_added",
  "user.key_removed",
  "user.key_renamed",
  "issue.unblocked",
  "issue.confirmed",
  "capacity.changed",
  "shield.changed",
  "traffic.capture_started",
  "traffic.networks_imported",
  "crew.governed",
]);

/**
 * The audience a kind was classified for, or undefined when nobody did.
 * `test/event-audience-coverage.test.ts` fails on an emitted kind that is.
 */
export function classifiedAudience(kind: string): EventAudience | undefined {
  // A hook that keeps failing is for those who can act on it: the host and
  // the reason, never the address (`webhook_streak.ts`).
  if (kind === "webhook.failing") return "writers";
  if (
    kind.startsWith("webhook.") ||
    kind.startsWith("app.env_") ||
    kind.startsWith("app.domain.") ||
    // A private address and port, and who may reach it (#3543).
    kind.startsWith("app.egress.") ||
    kind.startsWith("prompt.") ||
    kind.startsWith("secret.") ||
    // The forge's mail ceiling is its owner's to hear (`actions/mail.ts`).
    kind.startsWith("mail.") ||
    // A restore drill's verdict is the forge owner's (`snapshot/service.ts`).
    kind.startsWith("drill.") ||
    // A snapshot moving is the forge owner's too, and has no repository.
    kind.startsWith("backup.") ||
    // Preparing for a power-off and ending it are the forge owner's (`maintenance/service.ts`).
    kind.startsWith("maintenance.") ||
    // The weekly model review's changes and results are the owner's (`actions/model_review.ts`).
    kind.startsWith("crew.model_") ||
    // A child forge answering no one at its public address is the owner's to hear (`spawn/reach.ts`).
    kind.startsWith("forge.child_") ||
    // A clog is the whole forge's flow, the owner's to hear (`flow/clog_tick.ts`).
    kind.startsWith("clog.") ||
    // What the throughput keeper did to lift a brake is the owner's too (`flow/keeper.ts`).
    kind.startsWith("keeper.") ||
    // Who is trusted to fold in, and the switch that stops it, are the owner's (`actions/trusted_sources.ts`).
    kind.startsWith("trust.") ||
    kind.startsWith("foldin.") ||
    // Events the retired FLOW ONLY switch wrote stay the admins' to hear.
    kind === "flow_only.cleared" ||
    // A report from outside waits for a person who decides; its arrival is
    // theirs to see, never the readers' (`actions/reports.ts`).
    kind.startsWith("report.") ||
    // An upstream's address, a connected host and a cloud's write switch are
    // configuration, as a webhook's URL is (#3565, #3568).
    kind === "forge.upstream" ||
    kind === "forge.updates_taken" ||
    kind === "cloud.write_allowed" ||
    // A bet's name, share and what is left are the owner's plan (#8713).
    kind.startsWith("bet.") ||
    // A pinned forge's deploy, update and rollback name the owner's cloud (#8697).
    kind.startsWith("pinned.") ||
    // Which of a person's connected accounts a mirror syncs through is too.
    kind.startsWith("origin.") ||
    // A declared LAN device names the owner's own network (#10567).
    kind.startsWith("device.") ||
    kind === "repo.settings_updated" ||
    // Where a repository follows is its admins' to read, off or on: the
    // address is often a private repository's.
    kind === "repo.upstream_follow" ||
    kind === "repo.upstream_checked" ||
    kind === "repo.source_added" ||
    kind === "repo.source_removed" ||
    kind === "repo.crew_outsiders" ||
    // A valve turn names a repository and the owner's budget: for those who administer it (`actions/valves.ts`).
    kind === "valve.turned" ||
    // A clog starting names the forge's own pile-up: the owner's to hear (#6524).
    kind.startsWith("clog.") ||
    // The release keeper's steps name images and probe numbers: the forge owner's (`keeper/keeper.ts`, #7557).
    kind.startsWith("release.") ||
    // A file held against new work is its admins' book-keeping (#6522).
    kind === "repo.file_held" ||
    kind === "repo.file_released" ||
    // Which repositories New app offers is the admins' choice (`actions/app_templates.ts`).
    kind.startsWith("app_template.") ||
    // What a parent lends a child's crew, by name and dollar, is the admins' business (`actions/child_credit.ts`, #10484).
    kind === "forge.credit_set"
  )
    return "admins";
  // A broken adapter sync is for those who may write the repository (`apps/pull.ts`).
  if (kind === "adapter.sync_failed") return "writers";
  // A fleet operation spans repositories; its receipt is its actor's. So is
  // a thought: it belongs to no repository and to nobody but its author.
  if (
    kind === "repo.pinned" ||
    kind === "repo.unpinned" ||
    // A person's pinned panels changed (`actions/board-pins.ts`): theirs alone.
    kind === "board.pins" ||
    kind.startsWith("fleet.") ||
    kind.startsWith("thought.")
  )
    return "actor";
  // A run's summary, an app's serving state and its pictures can carry the
  // app's own output: for a private app they are for those who may enter it
  // (#620, #599).
  if (kind.startsWith("run.") || kind.startsWith("app.") || kind.startsWith("look."))
    return "app";
  // A pull waiting on a named team's review is that team's news alone
  // (`actions/team_waits.ts`, #10164): its members, among those who may read.
  if (kind === "pull.team_waiting" || kind === "pull.team_answered") return "team";
  if (READER_KINDS.has(kind)) return "readers";
  return undefined;
}

/** Private by default: a kind nobody classified is for admins. */
export function eventAudience(kind: string): EventAudience {
  return classifiedAudience(kind) ?? "admins";
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
  const writers = new Map<string, boolean>();
  const mayWrite = (repoId: string): boolean => {
    const known = writers.get(repoId);
    if (known !== undefined) return known;
    const repo = getRepoById(db, repoId);
    const yes =
      repo !== undefined &&
      viewer !== undefined &&
      isActive(viewer) &&
      canWrite(db, repo, viewer);
    writers.set(repoId, yes);
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
  const teams = new Map<string, boolean>();
  const onTeam = (slug: unknown): boolean => {
    if (typeof slug !== "string" || viewer === undefined || !isActive(viewer)) return false;
    const known = teams.get(slug);
    if (known !== undefined) return known;
    const yes = getTeam(db, slug)?.members.includes(viewer.id) ?? false;
    teams.set(slug, yes);
    return yes;
  };
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
    if (namesHiddenRepo(event) && !answersForDeleted(db, viewer, event)) return false;
    switch (eventAudience(event.kind)) {
      case "readers":
        return true;
      case "app":
        return event.repoId === null || mayEnter(event.repoId);
      case "writers":
        return event.repoId !== null && mayWrite(event.repoId);
      case "actor":
        return viewer !== undefined && event.actorId === viewer.id;
      case "team":
        return onTeam(event.payload.team);
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
    // Which door an actor used (a token's name) is for those who answer for the repository.
    if (event.payload.door !== undefined) {
      const answers =
        event.repoId === null
          ? answersForDeleted(db, viewer, event)
          : event.actorId === viewer?.id || isOwner(event.repoId);
      if (answers) return event;
      const { door: _, ...payload } = event.payload;
      return { ...event, payload };
    }
    if (!event.kind.startsWith("run.")) return event;
    if (event.repoId !== null && isOwner(event.repoId)) return event;
    const payload = { ...event.payload };
    for (const field of RUN_OWNER_FIELDS) delete payload[field];
    return { ...event, payload };
  };
}
