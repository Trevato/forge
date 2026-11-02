/**
 * The owner's ranked list as a person does it (#8694): `Top`, `Not now` and
 * a place under another row are each one action that saves at once, for the
 * page and for MCP `next_up`, in the same words. The rank itself is
 * `core/rank.ts`; the list it orders is `core/next_up.ts`.
 */
import type { App } from "../app.ts";
import { addDependency, repoGraph } from "../core/dependencies.ts";
import { getIssue, type Issue } from "../core/issues.ts";
import { isStructural, pillarsOf } from "../core/pillars.ts";
import { clearRank, lift, MAX_RANKED, ranksInRepo, writeOrder } from "../core/rank.ts";
import { nextUp } from "../core/next_up.ts";
import { canWrite, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export const NEXT_FORBIDDEN = "Only someone with write access can rank the list.";
export const NEXT_INVALID = "Only an open issue that is work can be ranked.";
export const NEXT_NO_GATE = "This repository has no open Later gate to put it behind.";
export const NEXT_ONLY_DEFERRED = "Only deferred work needs it, so it stays deferred until what needs it comes back.";
export const NEXT_ALREADY_AWAY = "It is already behind the Later gate; Top brings it back.";
export const NEXT_FULL = `The list holds at most ${MAX_RANKED} ranked issues; take one off first.`;
export const NEXT_NO_PLACE = "There is no such place in the list.";

/** Where an issue goes: to the top, under another row, or away behind the Later gate. */
export type Place = { readonly to: "top" } | { readonly to: "after"; readonly number: number } | { readonly to: "not_now" };

export type NextError = { kind: "not_found" | "forbidden" | "invalid"; message: string };

/** Read a place from its one-line form: `top`, `not-now`, or `after:<number>`. */
export function placeOf(text: string): Place | undefined {
  if (text === "top") return { to: "top" };
  if (text === "not-now") return { to: "not_now" };
  const after = /^after:([1-9][0-9]{0,8})$/.exec(text);
  return after === null ? undefined : { to: "after", number: Number(after[1]) };
}

export function rankIssue(
  app: App,
  actor: User,
  repo: Repo,
  number: number,
  place: Place,
): Result<Issue, NextError> {
  const issue = Number.isInteger(number) && number > 0 ? getIssue(app.db, repo.id, number) : undefined;
  if (!issue || issue.kind !== "issue") return err({ kind: "not_found", message: "No such issue." });
  if (actor.kind === "agent" || !canWrite(app.db, repo, actor))
    return err({ kind: "forbidden", message: NEXT_FORBIDDEN });
  const set = pillarsOf(app.db, repo);
  if (issue.state !== "open" || isStructural(set, issue.id))
    return err({ kind: "invalid", message: NEXT_INVALID });
  const invalid = (message: string) => err<NextError>({ kind: "invalid", message });

  if (place.to === "not_now" && (set.gate === undefined || set.gate.state !== "open"))
    return invalid(NEXT_NO_GATE);
  if (place.to === "not_now" && repoGraph(app.db, repo.id, { sealed: true, lean: true }).deferred.has(issue.id))
    return invalid(NEXT_ALREADY_AWAY);
  if (place.to !== "not_now") {
    // Work only deferred work needs has no hold of its own to lift.
    const why = repoGraph(app.db, repo.id, { sealed: true, lean: true }).deferred.get(issue.id);
    if (why?.startsWith("only deferred work") === true) return invalid(NEXT_ONLY_DEFERRED);
  }
  // Checked before anything is written: a place that is not there, or a list
  // too long, changes nothing.
  const rest = nextUp(app.db, repo).rows.map((r) => r.issue).filter((i) => i.id !== issue.id);
  const at = place.to === "after" ? rest.findIndex((i) => i.number === place.number) + 1 : 0;
  if (place.to === "after" && at === 0) return invalid(NEXT_NO_PLACE);
  // The list is ranked down to where it was dropped, and whatever was ranked stays.
  const ranked = ranksInRepo(app.db, repo.id);
  const order = [...rest.slice(0, at), issue, ...rest.slice(at)]
    .filter((i, n) => n <= at || ranked.has(i.id))
    .map((i) => i.id);
  if (place.to !== "not_now" && order.length > MAX_RANKED) return invalid(NEXT_FULL);
  const moved = app.db.transaction((): Result<void, NextError> => {
    if (place.to === "not_now") {
      const linked = addDependency(app.db, issue, set.gate!, actor.id);
      if (!linked.ok) return invalid(NEXT_INVALID);
      clearRank(app.db, issue.id);
      return ok(undefined);
    }
    lift(app.db, repo, issue.id);
    writeOrder(app.db, repo, order, actor.id);
    return ok(undefined);
  }).immediate();
  if (!moved.ok) return moved;
  app.bus.append({
    kind: "issue.ranked",
    repoId: repo.id,
    actorId: actor.id,
    payload: { number: issue.number, to: place.to },
  });
  return ok(issue);
}

/** What the page and MCP say after a move. */
export function rankedWords(number: number, place: Place): string {
  if (place.to === "top") return `#${number} is on top.`;
  if (place.to === "not_now") return `#${number} is not now.`;
  return `#${number} moved under #${place.number}.`;
}

/** The place that puts row `at` one step up (`-1`) or down (`1`) in `numbers`, the list's issue numbers in order. */
export function stepTo(numbers: readonly number[], at: number, step: -1 | 1): string | undefined {
  if (step === 1) return at < numbers.length - 1 ? `after:${numbers[at + 1]}` : undefined;
  if (at < 1) return undefined;
  return at === 1 ? "top" : `after:${numbers[at - 2]}`;
}
