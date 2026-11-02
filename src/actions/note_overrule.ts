/**
 * One tap against the planner's verdict on a note (#8696). The planner
 * accepts, declines, snoozes or calls a note a duplicate without asking; the
 * person's say is final and is one action: `build` (a declined, duplicate or
 * snoozed note is built after all) or `decline` (an accepted note's own
 * issues are closed). The note is the person's alone; the overrule is kept as
 * a setting on them and, for `build`, as the issue it opened.
 */

import type { App } from "../app.ts";
import { openPlan } from "./plan.ts";
import { setIssueState } from "./issues.ts";
import { removeDependency } from "../core/dependencies.ts";
import { getIssue, MAX_TITLE } from "../core/issues.ts";
import { appendPlaced, type Placed } from "../core/placements.ts";
import { noteLine } from "../core/note_line.ts";
import { pillarsOf } from "../core/pillars.ts";
import { getRepo } from "../core/repos.ts";
import { setUserSetting } from "../core/settings.ts";
import { overruleKey, thoughtStream } from "../core/thought_stream.ts";
import { thoughtOf } from "../core/thoughts.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { homeOf } from "../crew/triage.ts";

export type OverruleError = "unauthorized" | "not_found" | "nothing_to_do" | "failed";

export function overruleNote(app: App, actor: User | undefined, thoughtId: string, action: unknown): Result<"accepted" | "declined", OverruleError> {
  if (!actor) return err("unauthorized");
  if (action !== "build" && action !== "decline") return err("nothing_to_do");
  const thought = thoughtOf(app.db, actor.id, thoughtId);
  const note = thought && thoughtStream(app.db, actor, { limit: 200 }).find((n) => n.id === thought.id);
  if (!thought || !note || note.placedAt === null) return err("not_found");
  // Only what the line offers: one tap, once. A replay or a stale form finds nothing to do.
  if (note.overruled !== null || noteLine(note).overrule?.do !== action) return err("nothing_to_do");
  const slugRepo = (slug: string) => {
    const [owner, name] = slug.split("/");
    return owner && name ? getRepo(app.db, owner, name) : undefined;
  };

  if (action === "decline") {
    for (const x of note.placed) {
      if (x.action !== "opened") continue;
      const repo = slugRepo(x.repo);
      const issue = repo && getIssue(app.db, repo.id, x.number);
      if (repo && issue && issue.state === "open") setIssueState(app, actor, repo, issue, "closed");
    }
    setUserSetting(app.db, actor.id, overruleKey(thought.id), "declined");
    app.bus.append({ kind: "thought.overruled", actorId: actor.id, payload: { id: thought.id, to: "declined" } });
    return ok("declined");
  }

  // build: a snoozed note is let out from behind the Later gate; any other is opened now.
  const snoozed = note.placed.filter((x) => x.action === "deferred");
  const opened: Placed[] = [];
  if (note.kind === "work" && snoozed.length > 0 && note.overruled === null) {
    for (const x of snoozed) {
      const repo = slugRepo(x.repo);
      const issue = repo && getIssue(app.db, repo.id, x.number);
      const gate = repo && pillarsOf(app.db, repo).gate;
      if (issue && gate) removeDependency(app.db, issue.id, gate.id);
    }
  } else {
    const repo = homeOf(app, actor.id);
    if (!repo) return err("failed");
    const slug = `${repo.ownerName}/${repo.name}`;
    const made = openPlan(app, actor, repo, [
      {
        key: "thought",
        title: (thought.text.replace(/\s+/g, " ").trim().slice(0, Math.min(MAX_TITLE, 120)) || "Note"),
        body: `From thought \`${thought.id}\`, built on its author's say:\n\n${thought.text.split("\n").map((l) => `> ${l}`).join("\n")}`,
        blockedBy: [],
      },
    ]);
    if (!made.ok) return err("failed");
    for (const o of made.value.opened) opened.push({ action: "opened", repo: slug, number: o.number });
    appendPlaced(app.db, thought.id, opened);
  }
  setUserSetting(app.db, actor.id, overruleKey(thought.id), "accepted");
  app.bus.append({ kind: "thought.overruled", actorId: actor.id, payload: { id: thought.id, to: "accepted" } });
  return ok("accepted");
}
