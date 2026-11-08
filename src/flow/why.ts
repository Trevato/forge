/**
 * Why a repository, issue or pull is not moving (#7654): one ordered list of
 * causes, each with a sentence and the action that clears it. `firstCause` is
 * plain data in, plain data out, so the throughput keeper can ask the same
 * list; `whyOf` reads the facts for one subject and the MCP `flow` answers
 * from it. The first cause that holds is the answer: later ones are behind it.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { listCrewRoles } from "../core/agents.ts";
import { repoGraph } from "../core/dependencies.ts";
import type { Issue } from "../core/issues.ts";
import type { Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { refTip } from "../git/read.ts";
import { resolveOid } from "../git/merge.ts";
import { checkSummary } from "../core/runs.ts";
import { standings } from "../core/standing.ts";
import { ceilingHitAt, forgeCeiling } from "./ceiling.ts";
import { heldNow, mapHolds } from "../crew/held.ts";
import { nextOfPull, type Actor } from "./next_actor.ts";
import { wallWords } from "./wall_wait.ts";

/** How `crew/held.ts` words a file an admin holds, the one hold that is a person's setting. */
const HELD_BY_ADMIN = " is held by an admin";

export const CAUSES = [
  "wall",
  "ceiling",
  "hot_file",
  "blocked_by",
  "later_gate",
  "no_builder",
  "no_headroom",
  "red_check",
  "waiting_review",
] as const;

export type CauseName = (typeof CAUSES)[number];

/** What is known about the subject; a missing fact is one that does not hold. */
export interface WhyFacts {
  /** Who must act for it to move: an agent (builder, reviewer) is held by the ceiling and headroom. */
  readonly actor: Actor | null;
  readonly ceilingUsd?: number;
  readonly hotFile?: string;
  readonly blockedBy?: readonly number[];
  readonly laterGate?: string;
  readonly builders?: number;
  readonly noHeadroom?: boolean;
  readonly redCheck?: boolean;
  readonly waitingReview?: boolean;
  /** What the access wall holds the pull for, in plain words (#7847). */
  readonly wall?: readonly string[];
}

export interface Cause {
  readonly name: CauseName;
  readonly says: string;
  /** The action that clears it. */
  readonly clears: string;
}

const agentActs = (f: WhyFacts): boolean => f.actor === "builder" || f.actor === "reviewer";

const RULES: Readonly<Record<CauseName, (f: WhyFacts) => Omit<Cause, "name"> | null>> = {
  wall: (f) =>
    f.wall !== undefined && f.wall.length > 0
      ? {
          says: `The access wall holds it for a person: ${f.wall.join("; ")}.`,
          clears: "a person allows it (merges the pull) or sends it back (requests changes).",
        }
      : null,
  ceiling: (f) =>
    f.ceilingUsd !== undefined && agentActs(f)
      ? {
          says: `The crew's daily ceiling ($${f.ceilingUsd}) is reached, so no agent starts today.`,
          clears: "raise the ceiling in the governor, or wait for the UTC day to turn.",
        }
      : null,
  hot_file: (f) =>
    f.hotFile !== undefined
      ? {
          says: f.hotFile.endsWith(HELD_BY_ADMIN)
            ? `An admin holds new work on ${f.hotFile.slice(0, -HELD_BY_ADMIN.length)}, so it waits (Settings › Held files).`
            : `A file it names is hot: ${f.hotFile}.`,
          clears: "land or close the open pulls on that file, or release an admin's hold on it.",
        }
      : null,
  blocked_by: (f) =>
    f.blockedBy !== undefined && f.blockedBy.length > 0
      ? {
          says: `It waits for ${f.blockedBy.map((n) => `#${n}`).join(", ")}.`,
          clears: "finish those, or remove the dependency.",
        }
      : null,
  later_gate: (f) =>
    f.laterGate !== undefined
      ? { says: `It is deferred: ${f.laterGate}`, clears: "close the Later gate, or move it out from behind it." }
      : null,
  no_builder: (f) =>
    f.actor === "builder" && f.builders === 0
      ? { says: "No builder is on this repository's crew.", clears: "add a builder to the crew." }
      : null,
  no_headroom: (f) =>
    f.noHeadroom === true && agentActs(f)
      ? {
          says: "Every subscription's window is spent down to the share kept for people.",
          clears: "wait for the window to reset, lower the headroom, or add a subscription.",
        }
      : null,
  red_check: (f) =>
    f.redCheck === true
      ? { says: "Its check is red.", clears: "a builder fixes it and pushes; or ask for a check again." }
      : null,
  waiting_review: (f) =>
    f.waitingReview === true
      ? { says: "It waits for a review.", clears: "a reviewer reviews it on its current head." }
      : null,
};

/** The first cause that holds the subject, or null when none does. */
export function firstCause(f: WhyFacts): Cause | null {
  for (const name of CAUSES) {
    const hit = RULES[name](f);
    if (hit !== null) return { name, ...hit };
  }
  return null;
}

export interface Why {
  readonly cause: Cause | null;
  /** Set when nothing is left to move: the subject is closed, or the pull merged. */
  readonly settled?: "closed" | "merged";
  /** Who acts next, when the subject is a pull. */
  readonly next?: { readonly who: Actor; readonly why: string };
}

/** True when every subscription has used what the crew may spend; false with none. */
function headroomSpent(db: Database, now: Date): boolean {
  const ids = db.query<{ id: string }, []>("SELECT id FROM subscription").all().map((r) => r.id);
  if (ids.length === 0) return false;
  const read = standings(db, ids, now);
  return ids.every((id) =>
    (read.get(id)?.windows ?? []).some((w) => w.crewRemaining !== null && w.crewRemaining.value <= 0),
  );
}

type Shared = Pick<WhyFacts, "ceilingUsd" | "builders" | "noHeadroom">;

/** The facts that hold for the whole forge, read once for a batch. */
function forgeFacts(app: App, now: Date): Pick<Shared, "ceilingUsd" | "noHeadroom"> {
  const cap = forgeCeiling(app.config);
  return {
    ...(cap !== null && ceilingHitAt(app.db, now, cap) !== null ? { ceilingUsd: cap } : {}),
    noHeadroom: headroomSpent(app.db, now),
  };
}

const buildersOf = (app: App, repo: Repo): number =>
  listCrewRoles(app.db, repo.id).filter((c) => c.role === "builder").length;

function sharedFacts(app: App, repo: Repo, now: Date): Shared {
  return { ...forgeFacts(app, now), builders: buildersOf(app, repo) };
}

/** Why the repository's builders are held, whatever the issue. */
export function whyRepo(app: App, repo: Repo, now = new Date()): Why {
  return { cause: firstCause({ actor: "builder", ...sharedFacts(app, repo, now) }) };
}

/** Why an open issue is not moving. */
export function whyIssue(app: App, repo: Repo, issue: Issue, now = new Date()): Why {
  if (issue.state !== "open") return { cause: null, settled: "closed" };
  const graph = repoGraph(app.db, repo.id, { sealed: true });
  const byId = new Map(graph.issues.map((i) => [i.id, i]));
  const openBlockers = graph.edges
    .filter((e) => e.issueId === issue.id)
    .map((e) => byId.get(e.blockedById))
    .filter((b): b is Issue => b !== undefined && b.state === "open")
    .map((b) => b.number)
    .sort((x, y) => x - y);
  const held = heldNow(app, repo);
  const holdOf = mapHolds(repo, held).holds.get(issue.number);
  const hot = holdOf?.by === "hot_file" ? holdOf.detail : undefined;
  const later = graph.deferred.get(issue.id);
  return {
    cause: firstCause({
      actor: "builder",
      ...(hot !== undefined ? { hotFile: hot } : {}),
      blockedBy: openBlockers,
      ...(later !== undefined ? { laterGate: later } : {}),
      ...sharedFacts(app, repo, now),
    }),
  };
}

/** The head git has now (ref file, then git), the stored one only when git cannot say. */
export async function liveHead(dir: string, pull: Pull): Promise<string> {
  const ref = pull.crossRepo ? `refs/pull/${pull.number}/head` : `refs/heads/${pull.headBranch}`;
  return (await refTip(dir, ref)) ?? (await resolveOid(dir, ref)) ?? pull.headOid;
}

/** Why an open pull is not moving; `live` is the head and conflicts the caller read from git (`liveHead` below reads the head). */
export function whyPull(
  app: App,
  repo: Repo,
  pull: Pull,
  live: { readonly headOid: string; readonly conflicts: number },
  now = new Date(),
  shared: Shared = sharedFacts(app, repo, now),
): Why {
  if (pull.mergedAt !== null) return { cause: null, settled: "merged" };
  if (pull.state !== "open") return { cause: null, settled: "closed" };
  const next = nextOfPull(app.db, pull, live);
  if (next === null) return { cause: null };
  const check = checkSummary(app.db, pull.id, live.headOid).state;
  const wall = next.who === "person" ? wallWords(app.db, pull.id, live.headOid) : null;
  const cause = firstCause({
    actor: next.who,
    redCheck: next.who === "builder" && check === "failed",
    waitingReview: next.who === "reviewer",
    ...(wall === null ? {} : { wall }),
    ...shared,
  });
  return { cause, next };
}

/**
 * `whyPull` for a pile of pulls (#7655): the forge-wide facts and each
 * repository's builders are read once, not once per pull. The stored head
 * stands for the live one and no conflict is looked for: a pile touches no git.
 */
export function whyPulls(
  app: App,
  rows: readonly { readonly repo: Repo; readonly pull: Pull }[],
  now = new Date(),
): Why[] {
  const forge = forgeFacts(app, now);
  const builders = new Map<string, number>();
  return rows.map(({ repo, pull }) => {
    if (!builders.has(repo.id)) builders.set(repo.id, buildersOf(app, repo));
    return whyPull(app, repo, pull, { headOid: pull.headOid, conflicts: 0 }, now, {
      ...forge,
      builders: builders.get(repo.id)!,
    });
  });
}
