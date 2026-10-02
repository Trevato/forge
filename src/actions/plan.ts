/**
 * Opening a plan: several small issues and the links between them, all or
 * nothing. Every refusal names the item that was wrong, and nothing is
 * written (or announced) until the whole plan is known to be good.
 */

import type { App } from "../app.ts";
import { isCrew } from "../core/agents.ts";
import { addDependency, repoGraph, readyNow } from "../core/dependencies.ts";
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
import { err, ok, type Result } from "../kernel/result.ts";
import { isMirror } from "../origins/write-through.ts";

export const PLAN_MAX = 12;
const KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;

export interface PlanItem {
  readonly key: string;
  readonly title: string;
  readonly body: string;
  /** Keys of this plan, or numbers of issues already open in the repository. */
  readonly blockedBy: readonly (string | number)[];
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
    items.push({ key, title, body, blockedBy: waits as (string | number)[] });
  }
  return ok(items);
}

export interface Planned {
  readonly opened: { key: string; number: number }[];
  /** Numbers of the open issues nothing open stands in front of. */
  readonly ready: number[];
}

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

export function openPlan(
  app: App,
  actor: User | undefined,
  repo: Repo,
  items: readonly PlanItem[],
): Result<Planned, PlanError> {
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
            `"${item.key}": ${"an issue cannot wait for itself"}`,
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

  const opened: { key: string; number: number }[] = [];
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
        body: item.body,
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
  return ok({
    opened,
    ready: readyNow(repoGraph(app.db, repo.id)).map((r) => r.issue.number),
  });
}
