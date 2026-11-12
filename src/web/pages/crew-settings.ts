/**
 * Settings › Crew, admin-only: the forms that put an agent on this
 * repository's crew, take it off, set its role, and save what the crew
 * subscribes to. The crew card itself is drawn on the settings page; every
 * form here redirects back to its `#crew` anchor with a flash.
 */

import { seatSlotsSaid, setSeatSlots } from "../../actions/seat_slots.ts";
import { checkSeatSlots } from "../../crew/seat_slots.ts";
import { addToCrew, listCrew, removeFromCrew } from "../../actions/crew.ts";
import { crewAddedWords, crewRefusal, crewRemovedWords } from "../../actions/crew_words.ts";
import { getAgentByName, isCrewRole, setCrewRole } from "../../core/agents.ts";
import type { Ctx } from "../../http/context.ts";
import { loadRepo, repoBase, repoNotFound } from "../chrome.ts";
import { field } from "../form.ts";
import { flashTo, redirect } from "../layout.ts";
import { adminForm } from "./settings.ts";
import { saveGrants } from "./subscriptions.ts";

// GET /:owner/:name/settings/crew
export function crewSettingsPage(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  return redirect(`${repoBase(repo)}/settings#crew`);
}

// POST /:owner/:name/settings/crew/subscriptions
export async function crewSubscriptionsSave(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  if (ctx.auth.user?.isAdmin !== true) return repoNotFound(ctx);
  const crew = listCrew(ctx.app, ctx.auth.user, repo);
  saveGrants(ctx, form, repo.id, crew.ok ? crew.value : []);
  return flashTo(ctx, `${repoBase(repo)}/settings#crew`, {
    message: "Saved.",
  });
}

// POST /:owner/:name/settings/crew
export async function crewAdd(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  // The team card's one button names the seat it fills.
  const role = field(form, "role");
  const asked = isCrewRole(role) ? role : undefined;
  const added = addToCrew(ctx.app, ctx.auth.user, repo, field(form, "agent"), asked);
  // An agent already on the crew picked for another list moves to it.
  if (added.ok && asked !== undefined) setCrewRole(ctx.app.db, repo.id, added.value.user.id, asked);
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings#crew`,
    added.ok
      ? { message: crewAddedWords(added.value.user.username) }
      : { tone: "danger", message: crewRefusal(added.error) },
  );
}

// POST /:owner/:name/settings/crew/:username/remove
export async function crewRemove(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo } = gate;
  const username = ctx.params.username ?? "";
  const removed = removeFromCrew(ctx.app, ctx.auth.user, repo, username);
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings#crew`,
    removed.ok
      ? { message: crewRemovedWords(username) }
      : { tone: "danger", message: crewRefusal(removed.error) },
  );
}

// POST /:owner/:name/settings/crew/:username/role
export async function crewRoleUpdate(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const base = repoBase(repo);
  const agent = getAgentByName(ctx.app.db, ctx.params.username ?? "");
  const role = field(form, "role");
  if (!agent || !isCrewRole(role))
    return flashTo(ctx, `${base}/settings#crew`, {
      tone: "danger",
      message: "That role could not be set.",
    });
  setCrewRole(ctx.app.db, repo.id, agent.user.id, role);
  return flashTo(ctx, `${base}/settings#crew`, {
    message: `${agent.user.username} is a ${role} here.`,
  });
}

// POST /:owner/:name/settings/pillars
export async function pillarUpdate(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const base = repoBase(repo);
  const checked = checkSeatSlots(field(form, "seat"), field(form, "slots"));
  if (checked === undefined)
    return flashTo(ctx, `${base}/settings#team`, {
      tone: "danger",
      message: "Use a whole number from 0 (paused) to 8; the planner 0 or 1.",
    });
  const done = await setSeatSlots(ctx.app, ctx.auth.user, repo, checked.role, checked.slots);
  return flashTo(
    ctx,
    `${base}/settings#team`,
    done.ok
      ? { message: seatSlotsSaid(checked.role, checked.slots) }
      : { tone: "danger", message: "That could not be saved." },
  );
}
