/**
 * What a fleet operation can do, one verb per entry. Every verb is the same
 * four questions over one row: what does it hold now (`read`), what will
 * it hold (`next`), why can it not (`refuse`), and make it so (`write`).
 * Because a verb's value is the whole state it touches — a state, a label
 * set, a list of blockers — undo is the same verb asked to write the value
 * from before, so nothing here knows how to undo anything.
 *
 * `write` goes through the platform's own actions, which authorize again
 * and append their own events; a verb never touches the database itself.
 */

import type { App } from "../app.ts";
import {
  assignIssue,
  setIssueLabels,
  setIssueState,
} from "../actions/issues.ts";
import { linkIssue, unlinkIssue, dependencyWords } from "../actions/dependencies.ts";
import { updateRepoSettings } from "../actions/repos.ts";
import { cancelRepoRun, requeueRepoRun } from "../actions/runs.ts";
import { isCrew } from "../core/agents.ts";
import { mergePull } from "../actions/pulls.ts";
import { bringUpToDate } from "../crew/autonomy.ts";
import { recordInteraction, removeDismissals } from "../core/interactions.ts";
import { getPull } from "../core/pulls.ts";
import { askItemsOf } from "../web/studio/asks.ts";
import type { FleetValue } from "../core/fleet_ops.ts";
import { getIssue, type Issue } from "../core/issues.ts";
import {
  canRead,
  isAutonomy,
  type Repo,
  type RepoSettings,
} from "../core/repos.ts";
import { isTerminal, type Run } from "../core/runs.ts";
import { getUserByName, type User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { isMirror } from "../origins/write-through.ts";
import type { FleetKind } from "./selection.ts";

/** One selected row, with what its verbs read, loaded for the whole batch. */
export interface Target {
  readonly id: string;
  readonly repo: Repo;
  readonly label: string;
  readonly run?: Run;
  readonly issue?: Issue;
  /** For an issue: its label names, sorted. */
  readonly labels?: readonly string[];
  /** For an issue: the numbers it waits for, ascending. */
  readonly blockers?: readonly number[];
  /** For an issue: every label its repository has, by name. */
  readonly repoLabels?: readonly string[];
  /** Who the operation is for: a personal verb (`dismiss`) acts on their own state. */
  readonly viewerId?: string;
  /** For an issue: whether the viewer's dismissal of its ask still holds. */
  readonly askDismissed?: boolean;
  /** For a pull: merged, its latest check green, and whether it merges as it stands. */
  readonly merged?: boolean;
  readonly green?: boolean;
  readonly stale?: boolean;
  /** The repository's planner, by username, when its crew has one. */
  readonly planner?: string | null;
}

export interface Verb {
  readonly kind: FleetKind;
  readonly reversible: boolean;
  /** Check the action's value at the boundary; the normalised value, or why not. */
  parse(app: App, value: unknown): Result<FleetValue, string>;
  /** True when the verb changes the actor's own state, not the repository's: only they undo it. */
  readonly personal?: boolean;
  read(target: Target): FleetValue;
  next(before: FleetValue, value: FleetValue): FleetValue;
  /** When the value depends on the row (the repository's own planner): this, not `next`. */
  nextFor?(target: Target, before: FleetValue, value: FleetValue): FleetValue;
  /** Why this row cannot hold `after`, beyond who is asking; undefined when it can. */
  refuse(app: App, target: Target, after: FleetValue): string | undefined;
  /** Make the row hold `after`; undefined when it does, else why not. */
  write(
    app: App,
    actor: User,
    target: Target,
    after: FleetValue,
  ): Promise<string | undefined>;
}

/** An action's refusal codes, in words a receipt can show. */
const WORDS: Record<string, string> = {
  ...dependencyWords,
  not_found: "not found",
  forbidden: "not allowed",
  unauthorized: "not signed in",
  mirrored: "mirrored: change it at the origin",
  unknown_label: "no such label here",
  assignee_cannot_read: "the assignee cannot read this repository",
  agent_not_on_crew: "that agent is not on this repository's crew",
  already_merged: "a merged pull stays closed",
  finished: "already finished",
  not_agent: "only an agent run is queued again",
  not_finished: "only a cancelled or failed run is queued again",
  no_task: "its issue is closed or its agent is gone",
  not_queued: "the crew would not take it now (already queued, parked, or at the ceiling)",
  unknown_branch: "unknown branch",
};

const words = (code: string): string => WORDS[code] ?? code;

/** A Result from an action, as a verb's answer. */
const done = (result: Result<unknown, string>): string | undefined =>
  result.ok ? undefined : words(result.error);

const sortedUnique = (
  values: readonly (string | number)[],
): (string | number)[] =>
  [...new Set(values)].sort((a, b) =>
    typeof a === "number" && typeof b === "number"
      ? a - b
      : String(a).localeCompare(String(b)),
  );

const replace = (_before: FleetValue, value: FleetValue): FleetValue => value;

/** A repository setting: the row holds the setting's value. */
function setting(
  field: "autonomy" | "autonomySlots" | "autonomyCeilingUsd" | "autonomyDirection",
  parse: (value: unknown) => Result<FleetValue, string>,
): Verb {
  return {
    kind: "repo",
    reversible: true,
    parse: (_app, value) => parse(value),
    read: (t) => t.repo[field],
    next: replace,
    refuse: () => undefined,
    async write(app, actor, t, after) {
      const settings: RepoSettings = {};
      if (field === "autonomy" && isAutonomy(after)) {
        settings.autonomy = after;
        // Whoever turns autonomy on is who it acts as, as on the settings page.
        settings.autonomyBy = after === "off" ? null : actor.id;
      } else if (field === "autonomyDirection" && typeof after === "string")
        settings.autonomyDirection = after;
      else if (field === "autonomySlots" && typeof after === "number")
        settings.autonomySlots = after;
      else if (field === "autonomyCeilingUsd" && typeof after === "number")
        settings.autonomyCeilingUsd = after;
      else return "not a value for this setting";
      return done(await updateRepoSettings(app, actor, t.repo, settings));
    },
  };
}

const noValue = (): Result<FleetValue, string> => ok(null);

/** Assign: the row holds its assignee's username, or nothing. */
const ASSIGN: Verb = {
  kind: "issue",
  reversible: true,
  parse(app, value) {
    if (value === null || value === "" || value === "none") return ok(null);
    if (typeof value !== "string") return err("assign takes a username, or none");
    const user = getUserByName(app.db, value.replace(/^@/, ""));
    return user ? ok(user.username) : err(`no account named ${value}`);
  },
  read: (t) => t.issue?.assigneeName ?? null,
  next: replace,
  refuse(app, t, after) {
    if (after === null) return undefined;
    const user = getUserByName(app.db, String(after));
    if (!user) return "that account is gone";
    if (user.kind === "org" || !canRead(app.db, t.repo, user))
      return words("assignee_cannot_read");
    if (user.kind === "agent" && !isCrew(app.db, t.repo.id, user.id))
      return words("agent_not_on_crew");
    return undefined;
  },
  async write(app, actor, t, after) {
    if (!t.issue) return words("not_found");
    const user = after === null ? null : getUserByName(app.db, String(after));
    if (user === undefined) return "that account is gone";
    return done(assignIssue(app, actor, t.repo, t.issue, user));
  },
};

export const VERBS: Record<string, Verb> = {
  autonomy: setting("autonomy", (v) =>
    isAutonomy(v) ? ok(v) : err("autonomy is off, assisted or autonomous"),
  ),
  slots: setting("autonomySlots", (v) =>
    typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 8
      ? ok(v)
      : err("slots are a whole number from 1 to 8"),
  ),
  ceiling: setting("autonomyCeilingUsd", (v) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 10_000
      ? ok(Math.round(v * 100) / 100)
      : err("the ceiling is a number of dollars from 0 to 10000"),
  ),
  direction: setting("autonomyDirection", (v) =>
    typeof v === "string" && v.trim().length <= 2000
      ? ok(v.trim())
      : err("the direction is text of at most 2000 characters"),
  ),

  cancel: {
    kind: "run",
    reversible: false,
    parse: noValue,
    read: (t) => t.run?.state ?? null,
    next: () => "cancelled",
    refuse: (_app, t) =>
      t.run && isTerminal(t.run.state) && t.run.state !== "cancelled"
        ? `already finished (${t.run.state})`
        : undefined,
    write: async (app, actor, t) =>
      done(cancelRepoRun(app, actor, t.repo, t.id)),
  },

  requeue: {
    kind: "run",
    reversible: false,
    parse: noValue,
    read: (t) => t.run?.state ?? null,
    next: () => "queued",
    refuse(_app, t) {
      if (t.run?.kind !== "agent") return words("not_agent");
      if (t.run.state !== "cancelled" && t.run.state !== "failed")
        return words("not_finished");
      return undefined;
    },
    write: async (app, actor, t) =>
      done(requeueRepoRun(app, actor, t.repo, t.id)),
  },

  close: {
    kind: "issue",
    reversible: true,
    parse: noValue,
    read: (t) => t.issue?.state ?? null,
    next: () => "closed",
    refuse: (app, t) => (isMirror(app, t.repo) ? words("mirrored") : undefined),
    async write(app, actor, t, after) {
      if (!t.issue || (after !== "open" && after !== "closed"))
        return words("not_found");
      return done(setIssueState(app, actor, t.repo, t.issue, after));
    },
  },

  assign: ASSIGN,

  // Ship: the same merge the asks' Ship button does, and the same handover
  // of a conflict to the pull's agent. A merge is not undone silently.
  ship: {
    kind: "issue",
    reversible: false,
    parse: noValue,
    read: (t) =>
      t.issue?.kind !== "pull" ? null : t.merged ? "shipped" : t.issue.state,
    next: () => "shipped",
    refuse(app, t) {
      if (t.issue?.kind !== "pull") return "not a change";
      if (t.issue.state !== "open") return "already closed";
      if (isMirror(app, t.repo)) return words("mirrored");
      if (t.stale) return "it no longer merges as it stands";
      if (t.green !== true) return "its check is not green";
      return undefined;
    },
    async write(app, actor, t) {
      const pull = t.issue ? getPull(app.db, t.repo.id, t.issue.number) : undefined;
      if (!pull) return words("not_found");
      const merged = await mergePull(app, actor, t.repo, pull, "squash");
      if (merged.ok) return undefined;
      if (typeof merged.error !== "string" && merged.error.kind === "conflict") {
        bringUpToDate(app, t.repo, pull, merged.error.files);
        return `it conflicts with main (${merged.error.files.join(", ")}); its agent brings it up to date`;
      }
      return typeof merged.error === "string" ? words(merged.error) : merged.error.kind;
    },
  },

  // Dismiss: the actor's own "not now", held until something new happens
  // to the ask (`web/studio/asks.ts`). Undo takes the dismissal back.
  dismiss: {
    kind: "issue",
    reversible: true,
    personal: true,
    parse: noValue,
    read: (t) => (t.askDismissed ? "dismissed" : "asking"),
    next: () => "dismissed",
    refuse: () => undefined,
    async write(app, actor, t, after) {
      if (!t.issue) return words("not_found");
      const items = askItemsOf(t.issue);
      if (after === "asking") removeDismissals(app.db, actor.id, items);
      else
        for (const item of items)
          recordInteraction(app.db, {
            viewerId: actor.id,
            itemId: item,
            kind: "dismissed",
            repoId: t.repo.id,
            actorId: null,
          });
      return undefined;
    },
  },

  // Hand back to the planner: the issue is assigned to the repository's
  // planner, which re-plans it. Never on a public repository, where a crew
  // assignment would let any reader's comment steer the run (#619).
  replan: {
    ...ASSIGN,
    parse: noValue,
    nextFor: (t) => t.planner ?? null,
    refuse(app, t, after) {
      if (t.issue?.kind === "pull") return "a change is told what is off, not re-planned";
      if (t.repo.visibility === "public")
        return "public: a crew assignment here lets any reader steer it";
      if (after === null) return "no planner on this crew";
      return ASSIGN.refuse(app, t, after);
    },
  },


  label: {
    kind: "issue",
    reversible: true,
    parse: (_app, value) =>
      typeof value === "string" && value.trim() !== "" && value.length <= 100
        ? ok(value.trim())
        : err("label takes a label's name"),
    read: (t) => t.labels ?? [],
    next: (before, value) => {
      const names = Array.isArray(before) ? before.map(String) : [];
      const name = String(value);
      return names.some((n) => n.toLowerCase() === name.toLowerCase())
        ? names
        : sortedUnique([...names, name]);
    },
    refuse(app, t, after) {
      if (isMirror(app, t.repo)) return words("mirrored");
      const known = new Set((t.repoLabels ?? []).map((n) => n.toLowerCase()));
      const missing = (Array.isArray(after) ? after : []).find(
        (n) => !known.has(String(n).toLowerCase()),
      );
      return missing === undefined
        ? undefined
        : `no label named ${missing} in ${t.repo.ownerName}/${t.repo.name}`;
    },
    async write(app, actor, t, after) {
      if (!t.issue || !Array.isArray(after)) return words("not_found");
      return done(
        setIssueLabels(app, actor, t.repo, t.issue, after.map(String)),
      );
    },
  },

  link: {
    kind: "issue",
    reversible: true,
    parse: (_app, value) =>
      typeof value === "number" && Number.isInteger(value) && value > 0
        ? ok(value)
        : err("link takes the number of the issue they wait for"),
    read: (t) => t.blockers ?? [],
    next: (before, value) =>
      sortedUnique([...(Array.isArray(before) ? before : []), Number(value)]),
    refuse(app, t, after) {
      for (const n of Array.isArray(after) ? after : []) {
        if (typeof n !== "number") return "not an issue number";
        if (n === t.issue?.number) return dependencyWords.self;
        const blocker = getIssue(app.db, t.repo.id, n);
        if (!blocker) return `no #${n} in ${t.repo.ownerName}/${t.repo.name}`;
        if (blocker.kind !== "issue") return dependencyWords.not_an_issue;
      }
      return undefined;
    },
    async write(app, actor, t, after) {
      if (!t.issue || !Array.isArray(after)) return words("not_found");
      const want = new Set(after.map(Number));
      const have = new Set(t.blockers ?? []);
      for (const n of want) {
        if (have.has(n)) continue;
        const blocker = getIssue(app.db, t.repo.id, n);
        if (!blocker) return `no #${n} here`;
        const why = done(linkIssue(app, actor, t.repo, t.issue, blocker));
        if (why) return why;
      }
      for (const n of have) {
        if (want.has(n)) continue;
        const blocker = getIssue(app.db, t.repo.id, n);
        if (!blocker) continue;
        const why = done(unlinkIssue(app, actor, t.repo, t.issue, blocker));
        if (why) return why;
      }
      return undefined;
    },
  },
};
