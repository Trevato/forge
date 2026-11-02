/**
 * `a` on an issue or a pull: hand it to somebody, or to nobody.
 *
 * The picker lists nobody, then people — every account on the forge that
 * is neither an org nor an agent, filtered through `canRead` so a name that
 * cannot see the repository is never offered — and then the crew. Assigning
 * an agent is a dispatch, not a decoration (docs/APPS.md), so the crew sits
 * apart and wears the bot mark where the font has one.
 *
 * `assignIssue` decides. The list here shapes what is on offer; it cannot
 * widen what the action allows, and the action's refusals are shown in
 * words.
 */

import { listCrew } from "../../actions/crew.ts";
import type { Agent } from "../../core/agents.ts";
import { assignIssue } from "../../actions/issues.ts";
import type { Issue } from "../../core/issues.ts";
import { canRead, type Repo } from "../../core/repos.ts";
import { getUserById, listPeople, type User } from "../../core/users.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { icon, type IconSet } from "../ui/icons.ts";
import type { Session } from "../session.ts";
import {
  errorText,
  metaOf,
  pickerScreen,
  type PickItem,
} from "./common.ts";

/** An agent as a picker row: the bot mark where the font has one. */
export function agentPick(
  agent: Agent,
  set: IconSet,
): { id: string; label: string; hint: string } {
  return {
    id: agent.user.username,
    label:
      set === "nerd"
        ? `${icon("bot", set)} ${agent.user.username}`
        : agent.user.username,
    hint: metaOf("agent", agent.model === "" ? "" : agent.model),
  };
}

/**
 * ` · assigned to robo` after the opener. An agent wears the bot mark where
 * the font has one and the word "agent" where it does not; a person's name
 * is just a name.
 */
export function assignedText(issue: Issue | undefined, set: IconSet): string {
  if (issue === undefined || issue.assigneeName === null) return "";
  if (!issue.assigneeIsAgent) return ` · assigned to ${issue.assigneeName}`;
  return set === "nerd"
    ? ` · assigned to ${icon("bot", set)} ${issue.assigneeName}`
    : ` · assigned to ${issue.assigneeName} (agent)`;
}

/** How many people the picker reads before it stops; `listPeople`'s ceiling. */
const PEOPLE_LIMIT = 200;

/**
 * The people who may read this repository, by name. The listing is bounded,
 * so whoever opened the issue and whoever holds it now are added by hand:
 * the two names a person most expects to find must not depend on where the
 * alphabet cut off.
 */
export function assignablePeople(f: Session, repo: Repo, issue: Issue): User[] {
  const seen = new Map<string, User>();
  const consider = (user: User | undefined): void => {
    if (user === undefined || user.kind !== "user") return;
    if (seen.has(user.id) || !canRead(f.db, repo, user)) return;
    seen.set(user.id, user);
  };
  for (const person of listPeople(f.db, { limit: PEOPLE_LIMIT }))
    consider(person);
  consider(getUserById(f.db, issue.authorId));
  if (issue.assigneeId !== null) consider(getUserById(f.db, issue.assigneeId));
  return [...seen.values()].sort((a, b) =>
    a.username.localeCompare(b.username),
  );
}

export function assignPicker(
  f: Session,
  ctx: Ctx,
  parent: Screen,
  repo: Repo,
  issue: Issue,
  onDone: () => void,
): void {
  const people = assignablePeople(f, repo, issue);
  const crew = listCrew(f.app, f.user, repo);
  const items: PickItem[] = [
    { id: "", label: "nobody", hint: issue.assigneeId === null ? "now" : "" },
    ...people.map(
      (user): PickItem => ({
        id: user.id,
        label: user.username,
        hint: user.id === issue.assigneeId ? "now" : "",
      }),
    ),
    ...(crew.ok ? crew.value : []).map((agent): PickItem => {
      const pick = agentPick(agent, ctx.icons);
      return {
        id: agent.user.id,
        label: pick.label,
        hint:
          agent.user.id === issue.assigneeId ? `${pick.hint} · now` : pick.hint,
      };
    }),
  ];
  ctx.push(
    pickerScreen(ctx, parent, {
      title: `Assign #${issue.number}`,
      items,
      onPick: ([chosen]) => {
        if (chosen === undefined) return;
        const assignee = chosen === "" ? null : getUserById(f.db, chosen);
        if (assignee === undefined) {
          ctx.toast(errorText("no_such_user"), "danger");
          return;
        }
        const done = assignIssue(f.app, f.user, repo, issue, assignee);
        if (!done.ok) {
          ctx.toast(errorText(done.error), "danger");
          return;
        }
        ctx.toast(
          assignee === null
            ? "unassigned"
            : assignee.kind === "agent"
              ? `assigned to ${assignee.username} — it starts now`
              : `assigned to ${assignee.username}`,
          "success",
        );
        onDone();
      },
    }),
  );
}
