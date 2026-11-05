/**
 * A contribution fork: the public fork a guest makes to help build a public
 * repository. The guest may push to it and send pulls from it to its parent,
 * and nothing else an owner may do. `canAdmin` answers no for it, so it has no
 * settings, secrets, webhooks, app or crew, and nothing runs for it: no check,
 * no deploy, no crew run. The mark stands while the owner is a guest; an admin
 * promoting them makes the fork an ordinary one. Pure data; the refusals and
 * limits are decided in `actions/guests.ts`.
 */

import type { Database } from "bun:sqlite";
import { guestSql } from "./roles.ts";

/** Whether `repoId` is a contribution fork whose owner is still a guest. */
export function isContributionFork(db: Database, repoId: string): boolean {
  return (
    db
      .query<{ n: number }, [string]>(
        `SELECT 1 AS n FROM contribution_fork c JOIN repo r ON r.id = c.repo_id
          WHERE c.repo_id = ?1 AND ${guestSql("r.owner_id")}`,
      )
      .get(repoId) !== null
  );
}

/** The contribution forks a guest owns, for measuring what they hold. */
export function contributionForksOf(db: Database, ownerId: string): { name: string; owner: string }[] {
  return db
    .query<{ name: string; owner: string }, [string]>(
      `SELECT r.name AS name, u.username AS owner
         FROM contribution_fork c
         JOIN repo r ON r.id = c.repo_id
         JOIN user u ON u.id = r.owner_id
        WHERE r.owner_id = ?1`,
    )
    .all(ownerId);
}

/** Contribution forks made on the whole forge since `since`, an ISO time. */
export function contributionForksSince(db: Database, since: string): number {
  return (
    db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM contribution_fork WHERE made_at >= ?1")
      .get(since)?.n ?? 0
  );
}

export const GUEST_REFUSALS = {
  guest_private: "A guest can help build public repositories only, and this one is private. You can still read and comment on public work.",
  guest_copy: "This repository is a copy. Help build the original instead.",
  guest_archived: "This repository is archived, so it takes no new changes.",
  guest_cooldown: "A new account waits a few minutes before it sends changes. You can read and comment now.",
  guest_forks_today: "You have used today's forks. Work in a fork you already have, or come back tomorrow.",
  guest_forge_forks_today: "This forge has taken all the new guest forks it can today. Come back tomorrow.",
  guest_pulls_today: "You have sent today's pull requests. Come back tomorrow, or add to one you already opened.",
  guest_storage: "Your forks are using all the space a guest gets. Delete a fork to make room.",
  guest_pull_shape: "A guest sends a pull request from their own fork to the repository it came from. Use Help build this on that repository first.",
} as const;
export type GuestRefusal = keyof typeof GUEST_REFUSALS;

export const isGuestRefusal = (error: string): error is GuestRefusal => Object.hasOwn(GUEST_REFUSALS, error);

/** A day's allowance spent is a wait; every other refusal is a no. */
export const guestRefusalStatus = (error: GuestRefusal): 403 | 429 =>
  error === "guest_forks_today" || error === "guest_forge_forks_today" || error === "guest_pulls_today" ? 429 : 403;

/** The button a guest sees where a member sees a fork or a copy. */
export const HELP_BUILD = "Help build this";
/** What that button does next, in one sentence. */
export const HELP_BUILD_NEXT =
  "You get your own copy to change, and when you send it back, a person reviews it before any of it runs.";
/** What a new account gets, on the sign-up page. */
export const SIGNUP_YOU_GET =
  "You can read everything public, comment, and help build public apps by sending changes for review.";
export const SIGNUP_OWN_FORGE = "To run your own apps and crew, get your own forge.";
