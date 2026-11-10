/**
 * Turning a knob (#10461), an admin's: each one writes through the setting
 * the forge already keeps and leaves the same event that setting's own page
 * leaves (`capacity.changed`, `repo.settings_updated`), so the feed says who
 * turned what. The next pump reads the change; nothing restarts.
 */

import type { App } from "../app.ts";
import { changeCapacity } from "./capacity.ts";
import { updateRepoSettings } from "./repos.ts";
import { getRepo } from "../core/repos.ts";
import { AUTONOMY_WORDS, knobRepos, type AutonomyWord, type KnobId } from "../crew/knobs.ts";
import { validPolishShare } from "../crew/small_share.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import type { User } from "../core/users.ts";

export type KnobError = "not_found" | "no_such_knob" | "invalid_value";

const WORDS: Record<AutonomyWord, { autonomy: "off" | "autonomous"; plansNeedNod: boolean; decisionsBy: "me" | "decider" }> = {
  off: { autonomy: "off", plansNeedNod: true, decisionsBy: "me" },
  ask: { autonomy: "autonomous", plansNeedNod: true, decisionsBy: "me" },
  go: { autonomy: "autonomous", plansNeedNod: false, decisionsBy: "decider" },
};

export async function setKnob(
  app: App,
  actor: User | undefined,
  knob: string,
  value: string,
  repoPath?: string,
): Promise<Result<{ knob: KnobId; value: string }, KnobError>> {
  if (actor?.isAdmin !== true || actor.kind === "agent") return err("not_found");
  const v = value.trim();
  if (knob === "speed" || knob === "budget") {
    const changed = changeCapacity(app, actor, knob === "speed" ? "crew.concurrency" : "week.use", v);
    if (!changed.ok) return err(changed.error === "not_found" ? "not_found" : "invalid_value");
    return ok({ knob, value: v });
  }
  if (knob === "polish") {
    const n = /^\d+$/.test(v) ? Number(v) : Number.NaN;
    if (!validPolishShare(n)) return err("invalid_value");
    // The value is checked above, and an admin actor passes every repository's check alike, so a write
    // cannot fail for one repository and not the rest.
    for (const repo of knobRepos(app).filter((r) => r.autonomy !== "off")) {
      const done = await updateRepoSettings(app, actor, repo, { polishShare: n });
      if (!done.ok) return err("invalid_value");
    }
    return ok({ knob, value: v });
  }
  if (knob === "autonomy") {
    if (!(AUTONOMY_WORDS as readonly string[]).includes(v)) return err("invalid_value");
    const [owner, name] = (repoPath ?? "").split("/");
    const repo = owner === undefined || name === undefined ? undefined : getRepo(app.db, owner, name);
    if (repo === undefined) return err("not_found");
    const done = await updateRepoSettings(app, actor, repo, WORDS[v as AutonomyWord]);
    return done.ok ? ok({ knob, value: v }) : err("invalid_value");
  }
  return err("no_such_knob");
}
