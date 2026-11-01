/**
 * Settings › Crew, admin-only: the forms that put an agent on this
 * repository's crew, take it off, set its role, and save what the crew
 * subscribes to. The crew card itself is drawn on the settings page; every
 * form here redirects back to its `#crew` anchor with a flash.
 */

import { addToCrew, listCrew, removeFromCrew } from "../../actions/crew.ts";
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
    message: "Saved. The next run here works on what is ticked.",
  });
}

// POST /:owner/:name/settings/crew
export async function crewAdd(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  // The team card's one button names the seat it fills.
  const role = field(form, "role");
  const added = addToCrew(ctx.app, ctx.auth.user, repo, field(form, "agent"), isCrewRole(role) ? role : undefined);
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings#crew`,
    added.ok
      ? {
          message: `${added.value.user.username} is on the crew. Assign it an issue and it starts.`,
        }
      : {
          tone: "danger",
          message:
            added.error === "not_an_agent"
              ? "Only an agent can be on a crew; a person is given access through an organization's team."
              : "No such agent on this forge.",
        },
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
      ? { message: `${username} is off the crew.` }
      : { tone: "danger", message: "No such agent on this forge." },
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
