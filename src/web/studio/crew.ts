/**
 * The studio's own settings: who is on the crew, and how far it may go on
 * its own — the two decisions that belong to the studio's story, told from
 * one page reached from its head. Everything here posts to the very same
 * routes dev's Crew and Autonomy pages already use (`crewAdd`, `crewRemove`,
 * `crewRoleUpdate`, `autonomySettingsUpdate`) — same same-origin check, same
 * authorization, same errors. This module only draws the page; it never
 * decides anything a mutation already decides.
 *
 * Crew and autonomy are the owner's own book-keeping, same as the app page's
 * rail (`canSeeOwnerFacts`): a viewer who cannot write here is told that,
 * not shown the roster or the day's spend. The forms that change either are
 * drawn only for who the actions themselves would let post — an admin —
 * so nothing here offers a control that would just come back refused.
 * Everything else about the repository — visibility, branches, labels,
 * webhooks, deletion — stays dev's, one link away.
 */

import { listAllAgents } from "../../actions/crew.ts";
import { CREW_ROLES, listCrewRoles, type CrewRole } from "../../core/agents.ts";
import type { AppRecord } from "../../core/apps.ts";
import { canAdmin, canSeeOwnerFacts, type Repo } from "../../core/repos.ts";
import { autonomyStatus } from "../../crew/autonomy.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, repoBase, repoHeader, repoPalette } from "../chrome.ts";
import { html, raw, type Html } from "../html.ts";
import { icon } from "../icons.ts";
import { page } from "../layout.ts";
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

function crewCard(ctx: Ctx, repo: Repo, base: string, admin: boolean): Html {
  const db = ctx.app.db;
  const crew = listCrewRoles(db, repo.id);
  const onCrew = new Set(crew.map((c) => c.agent.user.id));
  const allListed = listAllAgents(ctx.app, ctx.auth.user);
  const available = (allListed.ok ? allListed.value : []).filter(
    (agent) => !onCrew.has(agent.user.id),
  );

  const rows =
    crew.length === 0
      ? empty({
          icon: "bot",
          title: "Nobody yet",
          note: "Add an agent below and tell it what you want.",
        })
      : listCard(
          crew.map((c) =>
            row({
              lead: icon("bot"),
              title: html`${userLink(c.agent.user.username)}`,
              meta: html`<span title="${c.agent.brief}"
                >${ROLE_WORD[c.role]}${c.agent.brief === ""
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

  return html`${card(html`${rows}`, {
    head: html`${icon("bot")}
      <h2>Crew</h2>`,
    pad: false,
  })}
  ${add}`;
}

function autonomyCard(ctx: Ctx, repo: Repo, base: string, admin: boolean): Html {
  const status = repo.autonomy === "off" ? undefined : autonomyStatus(ctx.app, repo);
  const state =
    status === undefined
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
        <input
          type="hidden"
          name="direction"
          value="${repo.autonomyDirection}"
        />
        ${field({
          label: "Ceiling per day",
          name: "ceiling",
          value: String(repo.autonomyCeilingUsd),
          type: "number",
          hint: "Dollars of agent spend on this repository per UTC day. At the ceiling the crew stops picking until midnight; nothing in flight is cut.",
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
    head: html`${icon("play")}
      <h2>On its own</h2>`,
  });
}

/**
 * GET /:owner/:name/settings in studio mode, for an app: the crew and the
 * ceiling, over the same actions dev's Crew and Autonomy pages use.
 */
export function studioCrewSettings(
  ctx: Ctx,
  repo: Repo,
  _record: AppRecord,
): Response {
  const base = repoBase(repo);
  const ownerFacts = canSeeOwnerFacts(ctx.app.db, repo, ctx.auth.user);
  const admin = ownerFacts && canAdmin(ctx.app.db, repo, ctx.auth.user);
  const body = !ownerFacts
    ? html`${repoHeader(ctx, repo, "settings", { compact: true })}
      <div class="card">
        <p class="muted small">
          The crew and how this app runs itself are visible to people who can
          write here.
        </p>
      </div>`
    : html`${repoHeader(ctx, repo, "settings", { compact: true })}
      <div class="stack">
        ${crewCard(ctx, repo, base, admin)}
        ${autonomyCard(ctx, repo, base, admin)}
        <p class="muted small">
          <a href="${base}/settings?mode=dev">The rest of the settings</a>
        </p>
      </div>`;
  return page({
    ctx,
    title: `Settings · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body,
  });
}
