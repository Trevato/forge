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

import { NOT_A_MEMBER } from "../core/roles.ts";
import { AGENT_NOT_ON_CREW } from "../actions/crew_limit_words.ts";
import type { App } from "../app.ts";
import {
  addComment,
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
import { moveLimb, parseSeat, type Seating } from "../core/limb_seats.ts";
import { getHold } from "../core/holds.ts";
import { recordInteraction, removeDismissals, removeMutes } from "../core/interactions.ts";
import { getPull } from "../core/pulls.ts";
import { teamHoldRefusal } from "../core/teams_words.ts";
import { askItemsOf } from "../web/studio/asks.ts";
import type { FleetValue } from "../core/fleet_ops.ts";
import { findPillar, isStructural, type Pillars } from "../core/pillars.ts";
import { getIssue, type Issue } from "../core/issues.ts";
import {
  ARCHIVED_WHY,
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
  /** Whether the viewer muted this repository. */
  readonly muted?: boolean;
  /** For a pull: merged, its latest check green, and whether it merges as it stands. */
  readonly merged?: boolean;
  readonly green?: boolean;
  readonly stale?: boolean;
  /** The repository's planner, by username, when its crew has one. */
  readonly planner?: string | null;
  /** For an issue: its repository's pillars, gate and Later umbrella. */
  readonly pillars?: Pillars;
  /** For an issue: the numbers of the umbrellas that wait for it directly, ascending. */
  readonly under?: readonly number[];
  /** For an issue: its repository's limbs in order, read on the first ask. */
  readonly seating?: () => Seating;
  /** For an issue: the ids of every row this operation is over, itself included. */
  readonly peers?: ReadonlySet<string>;
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
  /**
   * Make the row hold `after`; undefined when it does, else why not.
   * `value` is the action's own value, for a verb that says something as
   * it writes (a reason); an undo carries the value of what it undoes.
   */
  write(
    app: App,
    actor: User,
    target: Target,
    after: FleetValue,
    value?: FleetValue,
  ): Promise<string | undefined>;
}

/** An action's refusal codes, in words a receipt can show. */
const WORDS: Record<string, string> = {
  ...dependencyWords,
  not_member: NOT_A_MEMBER,
  not_found: "not found",
  forbidden: "not allowed",
  unauthorized: "not signed in",
  mirrored: "mirrored: change it at the origin",
  unknown_label: "no such label here",
  assignee_cannot_read: "the assignee cannot read this repository",
  agent_not_on_crew: AGENT_NOT_ON_CREW,
  already_merged: "a merged pull stays closed",
  reason_required: "a bug closed without a fix says why: add a reason",
  invalid_note: "a reason is one sentence of at most 300 characters",
  finished: "already finished",
  not_agent: "only an agent run is queued again",
  not_finished: "only a cancelled or failed run is queued again",
  no_task: "its issue is closed or its agent is gone",
  archived: ARCHIVED_WHY,
  not_queued: "the crew would not take it now (already queued, parked, or at the ceiling)",
  unknown_branch: "unknown branch",
};

/** An action's refusal code in words; the terminal says the same (#7294). */
export const words = (code: string): string => WORDS[code] ?? code;

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

// ---- where an issue is filed: under an umbrella, behind the gate ----

const UNDER = /^under #(\d+)$/;
const BEHIND = /^behind #(\d+)$/;
const NO_GATE = "behind a Later gate this repository does not have";
const NO_PILLAR = "under a pillar this repository does not have";

/** The umbrellas an issue is under and the gate it is behind, as a row's value. */
function placement(t: Target): string[] {
  const gate = t.pillars?.gate?.number;
  return [
    ...(gate !== undefined && (t.blockers ?? []).includes(gate)
      ? [`behind #${gate}`]
      : []),
    ...(t.under ?? []).map((n) => `under #${n}`),
  ];
}

/** A placement read back into numbers; undefined when it is not one. */
function placed(
  value: FleetValue,
): { under: number[]; behind: number | undefined } | undefined {
  if (!Array.isArray(value)) return undefined;
  const under: number[] = [];
  let behind: number | undefined;
  for (const token of value) {
    const u = UNDER.exec(String(token));
    const b = BEHIND.exec(String(token));
    if (u !== null) under.push(Number(u[1]));
    else if (b !== null) behind = Number(b[1]);
    else return undefined;
  }
  return { under, behind };
}

/**
 * Whether `gate` would come to wait for the issue: putting it behind the
 * gate would then be a loop. The umbrellas it is being taken out from under
 * do not count, and neither does a path through another row of the same
 * operation, which is on its way behind the gate too. One bounded walk up
 * the edges.
 */
function servesActiveWork(app: App, t: Target, gateId: string): boolean {
  const peers = [...(t.peers ?? [])].filter((id) => id !== t.id);
  const leaving = (t.pillars?.pillars ?? []).map((p) => p.umbrella.id);
  const row = app.db
    .query<{ n: number }, [string, string, string, string]>(
      `WITH RECURSIVE up(id) AS (
         SELECT d.issue_id FROM issue_dependency d
          WHERE d.blocked_by_id = ?1
            AND d.issue_id NOT IN (SELECT value FROM json_each(?3))
         UNION
         SELECT d.issue_id FROM issue_dependency d JOIN up ON d.blocked_by_id = up.id
          WHERE d.issue_id NOT IN (SELECT value FROM json_each(?4))
       )
       SELECT COUNT(*) AS n FROM up WHERE id = ?2`,
    )
    .get(
      t.id,
      gateId,
      JSON.stringify([...leaving, ...peers]),
      JSON.stringify(peers),
    );
  return (row?.n ?? 0) > 0;
}

/**
 * Why a held pull is not shipped in a batch. One person's own Ship or
 * merge on a held pull still works: they are looking at it, and the hold
 * is on the page in front of them. A batch lands many changes on one
 * word, and whoever sends it may never have seen that someone said "not
 * this one yet" (`core/holds.ts`).
 */
function heldWords(app: App, pullId: string): string | undefined {
  const hold = getHold(app.db, pullId);
  return hold === undefined
    ? undefined
    : `held by ${hold.heldByName} (${hold.why}): release it first`;
}

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

  archive: {
    kind: "repo",
    reversible: true,
    parse: (_app, value) =>
      typeof value === "boolean" ? ok(value) : err("archive is true or false"),
    read: (t) => t.repo.archivedAt !== null,
    next: replace,
    refuse: () => undefined,
    write: async (app, actor, t, after) =>
      typeof after === "boolean"
        ? done(await updateRepoSettings(app, actor, t.repo, { archived: after }))
        : "not a value for this setting",
  },

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

  // Close: with a reason (one sentence), it is said on each before it
  // closes; undo opens it again and the reason stays in the conversation.
  close: {
    kind: "issue",
    reversible: true,
    parse: (_app, value) =>
      value === null || value === undefined || value === ""
        ? ok(null)
        : typeof value === "string" && value.length <= 300
          ? ok(value.trim().replace(/\s+/g, " "))
          : err("a reason is one sentence of at most 300 characters"),
    read: (t) => t.issue?.state ?? null,
    next: () => "closed",
    refuse: (app, t) => (isMirror(app, t.repo) ? words("mirrored") : undefined),
    async write(app, actor, t, after, value) {
      if (!t.issue || (after !== "open" && after !== "closed"))
        return words("not_found");
      // The reason rides the close, so it is said with it or not at all,
      // and a bug that needs one is refused without it.
      const note = after === "closed" && typeof value === "string" ? value : "";
      const closed = done(
        setIssueState(app, actor, t.repo, t.issue, after, note === "" ? {} : { note }),
      );
      return closed;
    },
  },

  // Mute: the actor's own "not this app, not now": its repository goes
  // quiet in their feed and their On you card. Undo listens again.
  mute: {
    kind: "issue",
    reversible: true,
    personal: true,
    parse: noValue,
    read: (t) => (t.muted ? "muted" : "listening"),
    next: () => "muted",
    refuse: () => undefined,
    async write(app, actor, t, after) {
      if (after === "listening") removeMutes(app.db, actor.id, [`repo:${t.repo.id}`]);
      else
        recordInteraction(app.db, {
          viewerId: actor.id,
          itemId: `repo:${t.repo.id}`,
          kind: "muted",
          repoId: t.repo.id,
          actorId: null,
        });
      return undefined;
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
      return heldWords(app, t.issue.id);
    },
    async write(app, actor, t) {
      const pull = t.issue ? getPull(app.db, t.repo.id, t.issue.number) : undefined;
      if (!pull) return words("not_found");
      // Asked again here: earlier rows of the same batch take time to land,
      // and a hold set meanwhile is still a hold.
      const held = heldWords(app, pull.id);
      if (held !== undefined) return held;
      const merged = await mergePull(app, actor, t.repo, pull, "squash");
      if (merged.ok) return undefined;
      if (typeof merged.error !== "string" && merged.error.kind === "conflict") {
        bringUpToDate(app, t.repo, pull, merged.error.files);
        return `it conflicts with main (${merged.error.files.join(", ")}); its agent brings it up to date`;
      }
      if (typeof merged.error !== "string" && merged.error.kind === "team_review_required")
        return teamHoldRefusal(merged.error.teams);
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

  /**
   * File an issue: `later` puts it behind the Later gate and under the
   * Later umbrella, out from under any pillar; a pillar's name or short
   * form puts it under that pillar and out from behind the gate; `none`
   * takes it out of both. Over `limb:<n>`, top down, `later` is how a
   * whole limb is deferred: every issue of the limb gets its own row, so
   * nothing is put off that the preview did not show.
   */
  file: {
    kind: "issue",
    reversible: true,
    parse: (_app, value) =>
      typeof value === "string" && value.trim() !== "" && value.length <= 100
        ? ok(value.trim())
        : err("file takes later, none, or a pillar's name"),
    read: (t) => placement(t),
    next: replace,
    nextFor(t, _before, value) {
      const wanted = String(value).toLowerCase();
      if (wanted === "none") return [];
      const set = t.pillars;
      if (wanted === "later") {
        if (set?.gate === undefined) return [NO_GATE];
        return [
          `behind #${set.gate.number}`,
          ...(set.later === undefined ? [] : [`under #${set.later.number}`]),
        ];
      }
      const pillar = findPillar(set?.pillars ?? [], wanted);
      return pillar === undefined
        ? [NO_PILLAR]
        : [`under #${pillar.umbrella.number}`];
    },
    refuse(app, t, after) {
      if (isMirror(app, t.repo)) return words("mirrored");
      if (t.pillars !== undefined && isStructural(t.pillars, t.id))
        return "an umbrella or the gate is the plan's own, and is not filed";
      const tokens = Array.isArray(after) ? after.map(String) : [];
      if (tokens.includes(NO_GATE))
        return 'this repository has no open issue titled "Later gate: …"';
      if (tokens.includes(NO_PILLAR)) {
        const names = (t.pillars?.pillars ?? []).map((p) => p.name);
        return names.length === 0
          ? "this repository has no pillars"
          : `no such pillar here; they are ${names.join(", ")}`;
      }
      const want = placed(after);
      if (want === undefined) return "not a place an issue can be filed";
      const gate = t.pillars?.gate;
      if (want.behind !== undefined) {
        if (gate === undefined || gate.number !== want.behind)
          return "the Later gate has moved since";
        if (servesActiveWork(app, t, gate.id))
          return "something that is not deferred waits for it: defer that instead, or unlink it first";
      }
      return undefined;
    },
    async write(app, actor, t, after) {
      const want = placed(after);
      const have = placed(placement(t));
      if (!t.issue || want === undefined || have === undefined)
        return words("not_found");
      const issueOf = (n: number) => getIssue(app.db, t.repo.id, n);
      // Out first, in after: nothing is ever behind the gate and under a
      // pillar at once, which would be a loop.
      for (const n of have.under) {
        if (want.under.includes(n)) continue;
        const umbrella = issueOf(n);
        if (!umbrella) continue;
        const why = done(unlinkIssue(app, actor, t.repo, umbrella, t.issue));
        if (why) return why;
      }
      if (have.behind !== undefined && have.behind !== want.behind) {
        const gate = issueOf(have.behind);
        if (gate) {
          const why = done(unlinkIssue(app, actor, t.repo, t.issue, gate));
          if (why) return why;
        }
      }
      if (want.behind !== undefined && want.behind !== have.behind) {
        const gate = issueOf(want.behind);
        if (!gate) return `no #${want.behind} here`;
        const why = done(linkIssue(app, actor, t.repo, t.issue, gate));
        if (why) return why;
      }
      for (const n of want.under) {
        if (have.under.includes(n)) continue;
        const umbrella = issueOf(n);
        if (!umbrella) return `no #${n} here`;
        const why = done(linkIssue(app, actor, t.repo, umbrella, t.issue));
        if (why) return why;
      }
      return undefined;
    },
  },

  /**
   * Bring back what was filed for later: an issue behind the Later gate or
   * under the Later umbrella goes under the pillar named, or nowhere with
   * `none`. An issue that was not filed for later is left as it is. Over
   * `limb:<n>^`, leaves first, it is how a whole limb is resumed.
   */
  resume: {
    kind: "issue",
    reversible: true,
    parse: (_app, value) =>
      value === null || value === ""
        ? ok("none")
        : typeof value === "string" && value.length <= 100
          ? ok(value.trim())
          : err("resume takes a pillar's name, or none"),
    read: (t) => placement(t),
    next: replace,
    nextFor(t, before, value) {
      const later = t.pillars?.later?.number;
      const filed =
        Array.isArray(before) &&
        before.some(
          (token) =>
            BEHIND.test(String(token)) ||
            (later !== undefined && token === `under #${later}`),
        );
      if (!filed) return before;
      const wanted = String(value).toLowerCase();
      if (wanted === "none") return [];
      const pillar = findPillar(t.pillars?.pillars ?? [], wanted);
      return pillar === undefined
        ? [NO_PILLAR]
        : [`under #${pillar.umbrella.number}`];
    },
    refuse: (app, t, after) => VERBS["file"]!.refuse(app, t, after),
    write: (app, actor, t, after, value) =>
      VERBS["file"]!.write(app, actor, t, after, value),
  },

  /**
   * Close an issue as not doing: it closes as dropped, and the reason is
   * said on it. Undo opens it again; the reason stays in the conversation.
   */
  drop: {
    kind: "issue",
    reversible: true,
    parse: (_app, value) =>
      typeof value === "string" && value.trim() !== "" && value.length <= 300
        ? ok(value.trim().replace(/\s+/g, " "))
        : err("drop takes the reason, in one sentence of at most 300 characters"),
    read: (t) =>
      t.issue === undefined
        ? null
        : t.issue.state === "open"
          ? "open"
          : `closed (${t.issue.closeReason ?? "done"})`,
    next: () => "closed (dropped)",
    refuse(app, t, after) {
      if (isMirror(app, t.repo)) return words("mirrored");
      if (after !== "open" && after !== "closed (dropped)")
        return "an issue is dropped, or opened again";
      if (after === "open") return undefined;
      return t.issue?.state === "closed" ? "already closed" : undefined;
    },
    async write(app, actor, t, after, value) {
      if (!t.issue) return words("not_found");
      if (after === "open")
        return done(setIssueState(app, actor, t.repo, t.issue, "open"));
      const said = addComment(
        app,
        actor,
        t.repo,
        t.issue,
        `Not doing: ${value === undefined ? "" : String(value)}`,
      );
      if (!said.ok) return words(String(said.error));
      return done(
        setIssueState(app, actor, t.repo, t.issue, "closed", {
          reason: "dropped",
        }),
      );
    },
  },

  /**
   * Seat a limb among its siblings: the value is a seat, `<group>:<place>`
   * (`top` or an issue number, then the place from 1), and the limb takes
   * that place with the others moving over. The row holds every seat the
   * limb has, so undo is the seats from before. The order is kept here and
   * is not the origin's, so a mirror is no reason to refuse.
   */
  place: {
    kind: "issue",
    reversible: true,
    parse: (_app, value) =>
      parseSeat(value) === undefined
        ? err("place takes a seat: top:2, or the number of the milestone and the place, 12:1")
        : ok(String(value)),
    read: (t) => [...(t.seating?.().of(t.id) ?? [])],
    next: replace,
    nextFor(_t, before, value) {
      const want = parseSeat(value);
      const held = Array.isArray(before) ? before.map(String) : [];
      return want === undefined
        ? held
        : held.map((seat) => (parseSeat(seat)?.group === want.group ? String(value) : seat));
    },
    refuse(_app, t, after) {
      const seats = t.seating?.();
      for (const seat of Array.isArray(after) ? after.map(String) : []) {
        const want = parseSeat(seat);
        if (want === undefined || seats === undefined) return "not a seat";
        if (want.place > seats.size(want.group))
          return `there are only ${seats.size(want.group)} limbs there`;
      }
      return undefined;
    },
    async write(app, actor, t, after) {
      const have = t.seating?.().of(t.id) ?? [];
      for (const seat of Array.isArray(after) ? after.map(String) : []) {
        const want = parseSeat(seat);
        if (want === undefined) return "not a seat";
        if (have.includes(seat)) continue;
        const why = moveLimb(app.db, t.repo, t.id, want);
        if (why !== undefined) return why;
        // The order is not an issue's own change, so no issue event says it
        // moved: a milestones page open elsewhere hears this one.
        app.bus.append({
          kind: "limb.moved",
          repoId: t.repo.id,
          actorId: actor.id,
          payload: { number: t.issue?.number ?? null, seat },
        });
      }
      return undefined;
    },
  },
};
