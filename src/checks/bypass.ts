/**
 * The break-glass (#7790): a gate with a bug cannot judge the pull that fixes
 * it. While landing has stopped (`gate_stopped.ts`, the forge's own repository
 * only), an owner lands one named pull past the checks with one recorded
 * action: a reason, on the pull's trail as a comment and on the outbox as
 * `pull.bypassed`. Review and conflicts still count, and an agent never does
 * it (rule 10). The intent is written to the trail before the merge, so a
 * landing always has its record.
 */

import type { App } from "../app.ts";
import { mergePull } from "../actions/pulls.ts";
import { addComment } from "../actions/issues.ts";
import { canAdmin, type Repo } from "../core/repos.ts";
import type { Pull } from "../core/pulls.ts";
import type { User } from "../core/users.ts";
import { getIssueById } from "../core/issues.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { ownLandingStopped } from "./gate_stopped.ts";

export const MIN_REASON = 8;
export const MAX_REASON = 500;

/** What `mergePull` refuses with. */
type MergeError = Extract<Awaited<ReturnType<typeof mergePull>>, { ok: false }>["error"];

export type BypassError =
  | { readonly kind: "forbidden" | "not_found" | "reason" | "not_stopped" }
  | { readonly kind: "merge"; readonly error: MergeError };

/** The reason as the trail will say it, or undefined when it is too short or too long. */
export function cleanReason(text: string): string | undefined {
  const reason = text.replace(/\s+/g, " ").trim();
  return reason.length < MIN_REASON || reason.length > MAX_REASON ? undefined : reason;
}

/** Whether this person may be offered the break-glass on this repository right now. */
export function bypassOffered(app: App, actor: User | undefined, repo: Repo): boolean {
  return (
    actor !== undefined &&
    actor.kind !== "agent" &&
    canAdmin(app.db, repo, actor) &&
    ownLandingStopped(app.db, repo) !== undefined
  );
}

/** What stops the break-glass before any reason is read, or undefined. */
export function bypassRefusal(app: App, actor: User | undefined, repo: Repo, pull: Pull): BypassError | undefined {
  if (actor === undefined || actor.kind === "agent" || !canAdmin(app.db, repo, actor)) return { kind: "forbidden" };
  if (pull.repoId !== repo.id) return { kind: "not_found" };
  if (ownLandingStopped(app.db, repo) === undefined) return { kind: "not_stopped" };
  return undefined;
}

/** The refusal a plan (a dry run) would meet, in order: who, whether stopped, the reason. */
export function planBypass(app: App, actor: User | undefined, repo: Repo, pull: Pull, reasonText: string): BypassError | undefined {
  return bypassRefusal(app, actor, repo, pull) ?? (cleanReason(reasonText) === undefined ? { kind: "reason" } : undefined);
}

/** Land `pull` past the gate. `reasonText` is what the trail will say. */
export async function landPastGate(
  app: App,
  actor: User | undefined,
  repo: Repo,
  pull: Pull,
  reasonText: string,
): Promise<Result<{ mergeOid: string }, BypassError>> {
  const refused = planBypass(app, actor, repo, pull, reasonText);
  if (refused !== undefined || actor === undefined) return err(refused ?? { kind: "forbidden" });
  const reason = cleanReason(reasonText)!;
  const issue = getIssueById(app.db, pull.id);
  if (issue !== undefined)
    addComment(app, actor, repo, issue, `Landing past the gate, by @${actor.username}: ${reason}`);
  const merged = await mergePull(app, actor, repo, pull, "squash", undefined, { pastGate: true });
  if (!merged.ok) {
    if (issue !== undefined) addComment(app, actor, repo, issue, "That did not land: the merge was refused, and nothing changed.");
    return err({ kind: "merge", error: merged.error });
  }
  app.bus.append({
    kind: "pull.bypassed",
    repoId: repo.id,
    actorId: actor.id,
    payload: { number: pull.number, reason, mergeOid: merged.value.mergeOid },
  });
  return ok({ mergeOid: merged.value.mergeOid });
}
