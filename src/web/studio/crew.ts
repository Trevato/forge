/**
 * The studio's own settings: what the app says it is, who is on the crew,
 * and how far it may go on its own — the decisions that belong to the
 * studio's story, told from one page reached from its head. Everything here
 * posts to the very same routes dev's General, Crew and Autonomy pages
 * already use (`settingsUpdate`, `crewAdd`, `crewRemove`, `crewRoleUpdate`,
 * `autonomySettingsUpdate`) — same same-origin check, same authorization,
 * same errors. This module only draws the page; it never decides anything a
 * mutation already decides.
 *
 * The description and visibility form posts the same fields dev's General
 * page always sends (`protectDefault`/`requireReview`/`requireChecks`) as
 * hidden inputs carrying the repo's current values, so a save from here
 * cannot silently turn off branch protection it never showed — the same
 * trick `autonomyCard` already plays with `direction`.
 *
 * Crew and autonomy are the owner's own book-keeping, same as the app page's
 * rail (`canSeeOwnerFacts`): a viewer who cannot write here is told that,
 * not shown the roster or the day's spend. The forms that change any of
 * this are drawn only for who the actions themselves would let post — an
 * admin — so nothing here offers a control that would just come back
 * refused. These three lead the one settings page (`settingsPage`,
 * `pages/settings.ts`), for every repository and every viewer; the rest —
 * the default branch and its gates, secrets, the app's own environment,
 * prompts, labels, webhooks, deletion — sits beneath them, an admin's.
 */

import { listAllAgents, listCrew } from "../../actions/crew.ts";
import { CREW_ROLES, listCrewRoles, type CrewRole } from "../../core/agents.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { canAdmin, canSeeOwnerFacts, type Repo } from "../../core/repos.ts";
import { crewHasCredential } from "../../core/subscriptions.ts";
import { autonomyStatus } from "../../crew/autonomy.ts";
import { crewOffInPreview } from "../../crew/preview.ts";
import type { Ctx } from "../../http/context.ts";
import { repoBase } from "../chrome.ts";
import { html, raw, type Html } from "../html.ts";
import { icon } from "../icons.ts";
import { crewReadiness } from "../pages/crew.ts";
import { grantsSection } from "../pages/subscriptions.ts";
import {
  btn,
  card,
  empty,
  field,
  listCard,
  row,
  selectField,
  userLink,
} from "../ui.ts";

const ROLE_WORD: Record<CrewRole, string> = {
  builder: "builds",
  reviewer: "reviews",
  planner: "plans",
};

/**
 * The sentence and the ceiling the New app page asked for, editable again:
 * posts straight to `settingsUpdate` (`POST /:owner/:name/settings`, the
 * same one dev's General page uses), with hidden inputs carrying the branch
 * protection fields that form always sends so this save can't reset them.
 */
function aboutCard(
  repo: Repo,
  base: string,
  admin: boolean,
  isApp: boolean,
): Html | null {
  if (!admin) return null;
  const noun = isApp ? "app" : "repository";
  return card(
    html`<form method="post" action="${base}/settings">
      ${field({
        label: "Description",
        name: "description",
        value: repo.description,
        hint: `One line, shown wherever this ${noun} is listed.`,
      })}
      ${selectField({
        label: "Visibility",
        name: "visibility",
        hint: `A private ${noun} and one that does not exist look identical to anyone else; a private app and its previews stay open only to people who can write here.`,
        options: [
          {
            value: "private",
            label: "Private",
            selected: repo.visibility === "private",
          },
          {
            value: "public",
            label: "Public",
            selected: repo.visibility === "public",
          },
        ],
      })}
      ${repo.protectDefault
        ? html`<input type="hidden" name="protect" value="on" />`
        : null}
      ${repo.requireReview
        ? html`<input type="hidden" name="requireReview" value="on" />`
        : null}
      ${repo.requireChecks
        ? html`<input type="hidden" name="requireChecks" value="on" />`
        : null}
      <div class="form-actions">${btn("Save", { variant: "primary" })}</div>
    </form>`,
    { head: html`${icon("pencil")}<h2>About</h2>` },
  );
}

function crewCard(ctx: Ctx, repo: Repo, base: string, admin: boolean): Html {
  const db = ctx.app.db;
  const crew = listCrewRoles(db, repo.id);
  const onCrew = new Set(crew.map((c) => c.agent.user.id));
  const allListed = listAllAgents(ctx.app, ctx.auth.user);
  const available = (allListed.ok ? allListed.value : []).filter(
    (agent) => !onCrew.has(agent.user.id),
  );

  const forgeAdmin = ctx.auth.user?.isAdmin === true;
  const rows =
    crew.length === 0
      ? empty(
          available.length > 0
            ? {
                icon: "bot",
                title: "Nobody yet",
                note: "Add an agent below and tell it what you want.",
              }
            : forgeAdmin
              ? {
                  icon: "bot",
                  title: "Nobody yet",
                  note: "No agents exist on this forge yet.",
                  action: btn("Add an agent", {
                    href: "/settings/crew",
                    variant: "primary",
                    icon: "plus",
                  }),
                }
              : {
                  icon: "bot",
                  title: "Nobody yet",
                  note: "No agents exist on this forge yet. An admin can add one.",
                },
        )
      : listCard(
          crew.map((c) =>
            row({
              lead: icon("bot"),
              title: html`${userLink(c.agent.user.username)}`,
              meta: html`<span title="${c.agent.brief}"
                >${ROLE_WORD[c.role]}${c.agent.model === ""
                  ? ""
                  : ` · ${c.agent.model}`}${c.agent.brief === ""
                  ? ""
                  : ` · ${c.agent.brief}`}</span
              >`,
              ...(admin
                ? {
                    trail: html`<form
                        class="row-actions"
                        method="post"
                        action="${base}/settings/crew/${encodeURIComponent(
                          c.agent.user.username,
                        )}/role"
                      >
                        <label
                          class="sr-only"
                          for="f-role-${c.agent.user.username}"
                          >Role of ${c.agent.user.username}</label
                        >
                        <select
                          class="input input-sm"
                          id="f-role-${c.agent.user.username}"
                          name="role"
                        >
                          ${CREW_ROLES.map(
                            (r) =>
                              html`<option
                                value="${r}"
                                ${c.role === r ? raw("selected") : null}
                              >
                                ${ROLE_WORD[r]}
                              </option>`,
                          )}
                        </select>
                        ${btn("Set", { size: "sm" })}
                      </form>
                      <form
                        class="row-actions"
                        method="post"
                        action="${base}/settings/crew/${encodeURIComponent(
                          c.agent.user.username,
                        )}/remove"
                      >
                        ${btn("Remove", { size: "sm", icon: "x" })}
                      </form>`,
                  }
                : {}),
            }),
          ),
        );

  const add =
    !admin || available.length === 0
      ? null
      : card(
          html`<form class="edit-row" method="post" action="${base}/settings/crew">
            <label class="sr-only" for="f-agent">Agent</label>
            <select class="input" id="f-agent" name="agent">
              ${available.map(
                (agent) =>
                  html`<option value="${agent.user.username}">
                    ${agent.user.username}
                  </option>`,
              )}
            </select>
            ${btn("Add to crew", {
              variant: "primary",
              size: "sm",
              icon: "plus",
            })}
          </form>`,
          { head: html`<h2>Add an agent</h2>`, pad: false },
        );

  // Whose money the crew spends here is the forge admin's to say.
  const grants =
    admin && forgeAdmin
      ? (() => {
          const agents = listCrew(ctx.app, ctx.auth.user, repo);
          return grantsSection(ctx, {
            scopeId: repo.id,
            agents: agents.ok ? agents.value : [],
            action: `${base}/settings/crew/subscriptions`,
            wider: "the owner's grant, or the forge's own token",
          });
        })()
      : null;
  return html`<div id="crew">
    ${admin ? crewReadiness(ctx) : null}
    ${card(html`${rows}`, {
      head: html`${icon("bot")}
        <h2>Crew</h2>`,
      pad: false,
    })}
    ${add} ${grants}
  </div>`;
}

function autonomyCard(ctx: Ctx, repo: Repo, base: string, admin: boolean): Html {
  const planner = listCrewRoles(ctx.app.db, repo.id).find(
    (c) => c.role === "planner",
  );
  const status = repo.autonomy === "off" ? undefined : autonomyStatus(ctx.app, repo);
  const state = crewOffInPreview()
    ? html`<p class="muted small">
        The crew is off in a preview: nothing here plans, picks or runs an
        agent. Set <code>FORGE_CREW_IN_PREVIEW=1</code> to turn it on.
      </p>`
    : status === undefined
      ? html`<p class="muted small">
          Off. Every run starts because a person assigned, commented, or a
          check failed.
        </p>`
      : html`<dl>
          <dt>Mode</dt>
          <dd>${repo.autonomy === "autonomous" ? "Autonomous" : "Assisted"}</dd>
          <dt>Today</dt>
          <dd>
            $${status.spentTodayUsd.toFixed(2)} of
            $${status.ceilingUsd.toFixed(0)}
          </dd>
          <dt>Slots</dt>
          <dd>${status.active} of ${status.slots} in use</dd>
          ${status.paused
            ? html`<dt>Paused</dt>
                <dd>
                  ${status.paused === "ceiling"
                    ? "at the ceiling, until 00:00 UTC"
                    : status.paused}
                </dd>`
            : null}
        </dl>`;
  const form = !admin
    ? null
    : html`<form method="post" action="${base}/settings/autonomy">
        ${selectField({
          label: "Mode",
          name: "autonomy",
          hint: "Assisted: the crew works what is ready and every green change waits for your look. Autonomous: green ships on its own.",
          options: [
            { value: "off", label: "Off", selected: repo.autonomy === "off" },
            {
              value: "assisted",
              label: "Assisted",
              selected: repo.autonomy === "assisted",
            },
            {
              value: "autonomous",
              label: "Autonomous",
              selected: repo.autonomy === "autonomous",
            },
          ],
        })}
        <div class="field">
          <label for="f-direction">Direction</label>
          <textarea
            class="input"
            id="f-direction"
            name="direction"
            rows="3"
            placeholder="Pull the engine out of the game so a second game can use it."
          >
${repo.autonomyDirection}</textarea
          >
          <p class="hint">
            One or two sentences. The planner turns this into issues and links
            them when nothing is left to build.
            ${planner
              ? html`Planner here: ${userLink(planner.agent.user.username)}.`
              : html`No planner on the crew yet — set one under Crew, or the
                map is only what people write.`}
          </p>
        </div>
        ${field({
          label: "Ceiling per day",
          name: "ceiling",
          value: String(repo.autonomyCeilingUsd),
          type: "number",
          hint: "Dollars of agent spend on this app per UTC day. At the ceiling the crew stops picking until midnight; nothing in flight is cut.",
        })}
        ${field({
          label: "Slots",
          name: "slots",
          value: String(repo.autonomySlots),
          type: "number",
          hint: "Agent runs at once here. This is the WIP limit.",
        })}
        <div class="form-actions">${btn("Save", { variant: "primary" })}</div>
      </form>`;
  return card(html`${state}${form}`, {
    id: "autonomy",
    head: html`${icon("play")}
      <h2>On its own</h2>`,
  });
}

/**
 * The settings page's lead, for anyone who can read the repository: what it
 * says it is, the crew and how far it may go on its own — forms for an
 * admin, the facts for a writer, and a line saying whose they are for
 * anyone else.
 */
export function settingsLead(ctx: Ctx, repo: Repo): Html {
  const base = repoBase(repo);
  const ownerFacts = canSeeOwnerFacts(ctx.app.db, repo, ctx.auth.user);
  const admin = ownerFacts && canAdmin(ctx.app.db, repo, ctx.auth.user);
  const isApp = getAppByRepo(ctx.app.db, repo.id) !== undefined;
  if (!ownerFacts)
    return html`<div class="card">
      <p class="muted small">
        The crew and how this ${isApp ? "app" : "repository"} runs itself are
        visible to people who can write here.
      </p>
    </div>`;
  return html`<div class="stack">
    ${aboutCard(repo, base, admin, isApp)}
    ${crewCard(ctx, repo, base, admin)}
    ${autonomyCard(ctx, repo, base, admin)}
  </div>`;
}

/**
 * One sentence when the crew has no model credential, so it cannot start:
 * what is missing and where it is added — for the admin, a link to it; for
 * anyone else, who can. Nothing when the crew can run.
 */
export function crewKeyNote(ctx: Ctx): Html | null {
  if (crewHasCredential(ctx.app.db)) return null;
  return html`<p class="small muted" id="crew-key-note" role="status">
    ${icon("alert")} The crew has no model key yet, so it cannot start work.
    ${ctx.auth.user?.isAdmin
      ? html`<a href="/settings/subscriptions">Add one in Subscriptions</a>.`
      : "Ask this forge's admin to add one."}
  </p>`;
}
