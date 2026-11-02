/**
 * Opening a plan: several small issues and the links between them, all or
 * nothing. Every refusal names the item that was wrong, and nothing is
 * written (or announced) until the whole plan is known to be good.
 *
 * Where the repository has pillars (`core/pillars.ts`), a plan is honest
 * about what each item is for: an item names the pillar it serves and its
 * umbrella waits for it, or it is for later and waits behind the Later gate
 * with one sentence that says why. An item that says neither is refused, so
 * nothing reaches the ready list without a reason to be built now.
 */

import { sealedScope } from "../core/sealed.ts";
import type { App } from "../app.ts";
import { isCrew } from "../core/agents.ts";
import { mapHeldFor, type HoldName } from "../crew/held.ts";
import { addDependency, repoGraph, readyNow } from "../core/dependencies.ts";
import { findPillar, pillarsOf, type Pillar } from "../core/pillars.ts";
import {
  createIssue,
  getIssue,
  MAX_BODY,
  MAX_TITLE,
  type Issue,
} from "../core/issues.ts";
import { canRead, canWrite, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { transact } from "../kernel/db.ts";
import { id as newId } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { isMirror } from "../origins/write-through.ts";
import { SELF_WAIT } from "./plan_words.ts";
import { followLink } from "./pillars.ts";

export const PLAN_MAX = 12;
/** One sentence, with room. */
export const WHY_MAX = 300;
const KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;

export interface PlanItem {
  readonly key: string;
  readonly title: string;
  readonly body: string;
  /** Keys of this plan, or numbers of issues already open in the repository. */
  readonly blockedBy: readonly (string | number)[];
  /** The pillar it serves, by short form (`P0`) or name (`P0 Trust`). */
  readonly pillar?: string;
  /** Set when it serves no pillar now: why it waits, in one sentence. */
  readonly later?: string;
}

/** A refusal: a stable code, and a sentence that names the item at fault. */
export interface PlanError {
  readonly error: string;
  readonly message: string;
}

const refuse = (error: string, message: string) => err({ error, message });

/** The plan as the wire gave it, checked into plain items. */
export function parsePlan(raw: unknown): Result<PlanItem[], PlanError> {
  if (!Array.isArray(raw) || raw.length === 0)
    return refuse("invalid", "issues must be a non-empty list");
  if (raw.length > PLAN_MAX)
    return refuse("too_many", `a plan is at most ${PLAN_MAX} issues`);
  const items: PlanItem[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    const at = `issues[${i}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      return refuse("invalid", `${at} must be an object`);
    const o = entry as Record<string, unknown>;
    if (typeof o["key"] !== "string" || !KEY.test(o["key"]))
      return refuse(
        "invalid",
        `${at}: key must be a short name starting with a letter`,
      );
    const key = o["key"];
    if (seen.has(key))
      return refuse("duplicate_key", `${at}: key "${key}" is used twice`);
    seen.add(key);
    const title = typeof o["title"] === "string" ? o["title"].trim() : "";
    if (title === "") return refuse("empty_title", `"${key}" needs a title`);
    if (title.length > MAX_TITLE)
      return refuse(
        "title_too_long",
        `"${key}": title is over ${MAX_TITLE} characters`,
      );
    const body = o["body"] ?? "";
    if (typeof body !== "string")
      return refuse("invalid", `"${key}": body must be text`);
    if (body.length > MAX_BODY)
      return refuse(
        "body_too_long",
        `"${key}": body is over ${MAX_BODY} characters`,
      );
    const waits = o["blockedBy"] ?? [];
    if (!Array.isArray(waits) || waits.length > PLAN_MAX * 2)
      return refuse("invalid", `"${key}": blockedBy must be a short list`);
    for (const w of waits) {
      const good =
        typeof w === "string" ||
        (typeof w === "number" && Number.isInteger(w) && w > 0);
      if (!good)
        return refuse(
          "invalid",
          `"${key}": blockedBy takes keys or issue numbers`,
        );
    }
    const pillar = o["pillar"];
    if (
      pillar !== undefined &&
      (typeof pillar !== "string" || pillar.trim() === "")
    )
      return refuse("invalid", `"${key}": pillar is the name of a pillar`);
    const later = o["later"] ?? false;
    if (typeof later !== "boolean")
      return refuse("invalid", `"${key}": later is true or false`);
    if (later && pillar !== undefined)
      return refuse(
        "invalid",
        `"${key}" names a pillar and is for later: it is one or the other`,
      );
    if (typeof (o["why"] ?? "") !== "string")
      return refuse("invalid", `"${key}": why must be text`);
    // One line: it becomes the first line of the issue.
    const why = ((o["why"] ?? "") as string).trim().replace(/\s+/g, " ");
    if (!later && why !== "")
      return refuse("invalid", `"${key}": why goes with later: true`);
    if (later && why === "")
      return refuse(
        "no_reason",
        `"${key}" is for later: say why it waits, in one sentence (why)`,
      );
    if (why.length > WHY_MAX)
      return refuse(
        "why_too_long",
        `"${key}": why is one sentence, at most ${WHY_MAX} characters`,
      );
    items.push({
      key,
      title,
      body,
      blockedBy: waits as (string | number)[],
      ...(pillar === undefined ? {} : { pillar: pillar.trim() }),
      ...(later ? { later: why } : {}),
    });
  }
  return ok(items);
}

export interface Planned {
  readonly opened: { key: string; number: number }[];
  /** Numbers of the open issues nothing open stands in front of. */
  readonly ready: number[];
  /** Numbers of the issues this plan put behind the Later gate. */
  readonly later: number[];
  /** Opened issues that are ready but would not start now, with the map's words for why. */
  readonly held: { key: string; number: number; by: HoldName; detail: string }[];
  /** The Later gate's number, when the plan put something behind it. */
  readonly gate?: number;
}

/** "P0 Trust, P1 Feed or P2 Explorer". */
const namesOf = (pillars: readonly Pillar[]): string =>
  pillars
    .map((pillar) => pillar.name)
    .join(", ")
    .replace(/, ([^,]*)$/, " or $1");

/** Which key sits on a loop among the plan's own links, if any. */
function loopAt(items: readonly PlanItem[]): string | undefined {
  const by = new Map(items.map((i) => [i.key, i]));
  const state = new Map<string, "walking" | "done">();
  const visit = (key: string): string | undefined => {
    if (state.get(key) === "done") return undefined;
    if (state.get(key) === "walking") return key;
    state.set(key, "walking");
    for (const w of by.get(key)!.blockedBy)
      if (typeof w === "string") {
        const hit = visit(w);
        if (hit !== undefined) return hit;
      }
    state.set(key, "done");
    return undefined;
  };
  for (const i of items) {
    const hit = visit(i.key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** What a good plan was checked against, for opening it. */
interface Vetted {
  readonly actor: User;
  readonly existing: Map<number, Issue>;
  readonly serves: Map<string, Pillar>;
  readonly gate: Issue | undefined;
  readonly later: Issue | undefined;
}

/** Every refusal a plan can meet, before anything is written. */
function vet(
  app: App,
  actor: User | undefined,
  repo: Repo,
  items: readonly PlanItem[],
): Result<Vetted, PlanError> {
  if (!actor || !canRead(app.db, repo, actor))
    return refuse("not_found", "no such app or repository (owner/name)");
  if (!canWrite(app.db, repo, actor) && !isCrew(app.db, repo.id, actor.id))
    return refuse("forbidden", "you need write access to plan here");
  if (isMirror(app, repo))
    return refuse(
      "mirrored",
      "this repository is mirrored; plan at its origin",
    );

  const keys = new Set(items.map((i) => i.key));
  const existing = new Map<number, Issue>();
  for (const item of items)
    for (const w of item.blockedBy) {
      if (typeof w === "string") {
        if (!keys.has(w))
          return refuse(
            "unknown_key",
            `"${item.key}" waits for "${w}", which is not in this plan`,
          );
        if (w === item.key)
          return refuse(
            "self",
            `"${item.key}": ${SELF_WAIT}`,
          );
      } else {
        const found = getIssue(app.db, repo.id, w);
        if (!found || found.kind !== "issue")
          return refuse(
            "no_such_issue",
            `"${item.key}" waits for #${w}, which is not an issue here`,
          );
        existing.set(w, found);
      }
    }
  const loop = loopAt(items);
  if (loop !== undefined)
    return refuse("cycle", `"${loop}" is on a loop: that would make a loop`);

  // What each item is for. A repository with pillars takes no item that
  // says neither which one it serves nor that it waits.
  const { pillars, gate, later } = pillarsOf(app.db, repo);
  const serves = new Map<string, Pillar>();
  for (const item of items) {
    if (item.later !== undefined) {
      if (gate === undefined)
        return refuse(
          "no_later_gate",
          `"${item.key}" is for later, and this repository has no open issue titled "Later gate: …" to hold it`,
        );
    } else if (item.pillar !== undefined) {
      const pillar = findPillar(pillars, item.pillar);
      if (pillar === undefined)
        return refuse(
          "unknown_pillar",
          pillars.length === 0
            ? `"${item.key}": this repository has no pillars to serve`
            : `"${item.key}": "${item.pillar}" is not a pillar here; they are ${namesOf(pillars)}`,
        );
      serves.set(item.key, pillar);
    } else if (pillars.length > 0)
      return refuse(
        "no_pillar",
        `"${item.key}" names no pillar: give it ${namesOf(pillars)}, or later: true and why`,
      );
  }
  return ok({ actor, existing, serves, gate, later });
}

export interface Proposed {
  readonly status: "proposed";
  readonly id: string;
}

/**
 * "Plans need a nod": the same checks as `openPlan`, then the plan is kept
 * as one proposal (title, why, the ordered issues with their blockedBy) and
 * no issue is opened. A person's nod opens it.
 */
export function proposePlan(
  app: App,
  actor: User | undefined,
  repo: Repo,
  items: readonly PlanItem[],
  say: { title?: unknown; why?: unknown } = {},
): Result<Proposed, PlanError> {
  const title = typeof say.title === "string" ? say.title.trim() : "";
  if (say.title !== undefined && typeof say.title !== "string")
    return refuse("invalid", "title must be text");
  if (title.length > MAX_TITLE)
    return refuse("title_too_long", `title is over ${MAX_TITLE} characters`);
  if (say.why !== undefined && typeof say.why !== "string")
    return refuse("invalid", "why must be text");
  const why = ((say.why ?? "") as string).trim();
  if (why.length > MAX_BODY)
    return refuse("body_too_long", `why is over ${MAX_BODY} characters`);
  const vetted = vet(app, actor, repo, items);
  if (!vetted.ok) return vetted;
  const id = newId();
  app.db
    .query(
      `INSERT INTO plan_proposal (id, repo_id, author_id, title, why, issues, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .run(
      id,
      repo.id,
      vetted.value.actor.id,
      title === "" ? items[0]!.title : title,
      why,
      JSON.stringify(items),
      new Date().toISOString(),
    );
  return ok({ status: "proposed", id });
}

export function openPlan(
  app: App,
  actor: User | undefined,
  repo: Repo,
  items: readonly PlanItem[],
): Result<Planned, PlanError> {
  const vetted = vet(app, actor, repo, items);
  if (!vetted.ok) return vetted;
  const { existing, serves, gate, later } = vetted.value;
  actor = vetted.value.actor;

  const opened: { key: string; number: number }[] = [];
  /** The links an item's purpose adds: [the issue that waits, what it waits for]. */
  const purpose: [Issue, Issue][] = [];
  const failed = transact(app.db, (): PlanError | undefined => {
    app.db.exec("SAVEPOINT plan");
    const made = new Map<string, Issue>();
    const undo = (e: PlanError) => {
      app.db.exec("ROLLBACK TO plan");
      app.db.exec("RELEASE plan");
      return e;
    };
    for (const item of items) {
      const created = createIssue(app.db, {
        repoId: repo.id,
        authorId: actor.id,
        title: item.title,
        // A deferred issue opens with why it waits.
        body:
          item.later === undefined
            ? item.body
            : `**Later:** ${item.later}${item.body === "" ? "" : `\n\n${item.body}`}`,
      });
      if (!created.ok)
        return undo({
          error: created.error,
          message: `"${item.key}": ${created.error}`,
        });
      made.set(item.key, created.value);
    }
    for (const item of items)
      for (const w of item.blockedBy) {
        const blocker = typeof w === "string" ? made.get(w)! : existing.get(w)!;
        const linked = addDependency(
          app.db,
          made.get(item.key)!,
          blocker,
          actor.id,
        );
        if (!linked.ok)
          return undo({
            error: linked.error,
            message: `"${item.key}" cannot wait for ${String(w)}: ${linked.error}`,
          });
      }
    for (const item of items) {
      const issue = made.get(item.key)!;
      const pillar = serves.get(item.key);
      const links: [Issue, Issue][] =
        pillar !== undefined
          ? [[pillar.umbrella, issue]]
          : item.later !== undefined
            ? [
                [issue, gate!],
                ...(later ? [[later, issue] as [Issue, Issue]] : []),
              ]
            : [];
      for (const [waits, blocker] of links) {
        const linked = addDependency(app.db, waits, blocker, actor.id);
        if (!linked.ok)
          return undo({
            error: linked.error,
            message: `"${item.key}" cannot ${pillar ? `serve ${pillar.name}` : "wait for later"}: ${linked.error}`,
          });
        purpose.push([waits, blocker]);
      }
    }
    app.db.exec("RELEASE plan");
    for (const item of items)
      opened.push({ key: item.key, number: made.get(item.key)!.number });
    return undefined;
  });
  if (failed) return err(failed);

  // Announced only once the plan is committed, the same events as one by one.
  const number = new Map(opened.map((o) => [o.key, o.number]));
  for (const item of items) {
    app.bus.append({
      kind: "issue.opened",
      repoId: repo.id,
      actorId: actor.id,
      payload: { number: number.get(item.key)! },
    });
    for (const w of item.blockedBy)
      app.bus.append({
        kind: "issue.blocked",
        repoId: repo.id,
        actorId: actor.id,
        payload: {
          number: number.get(item.key)!,
          blockedBy: typeof w === "string" ? number.get(w)! : w,
        },
      });
  }
  for (const [waits, blocker] of purpose) {
    app.bus.append({
      kind: "issue.blocked",
      repoId: repo.id,
      actorId: actor.id,
      payload: { number: waits.number, blockedBy: blocker.number },
    });
    // What it serves is on the issue too, as its label (`actions/pillars.ts`).
    followLink(app, actor, repo, waits, blocker);
  }
  const deferred = items
    .filter((item) => item.later !== undefined)
    .map((item) => number.get(item.key)!);
  const scope = sealedScope(app.db, repo, actor);
  const graph = repoGraph(app.db, repo.id, scope);
  const { holds } = mapHeldFor(app, repo, graph, scope, new Set(opened.map((o) => o.number)));
  const held = opened.flatMap((o) => {
    const hold = holds.get(o.number);
    return hold === undefined ? [] : [{ ...o, by: hold.by, detail: hold.detail }];
  });
  return ok({
    opened,
    ready: readyNow(graph).map((r) => r.issue.number),
    held,
    later: deferred,
    ...(deferred.length > 0 && gate ? { gate: gate.number } : {}),
  });
}
