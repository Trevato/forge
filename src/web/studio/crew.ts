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
import { listCrewRoles, type Agent, type CrewRole } from "../../core/agents.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { canAdmin, canSeeOwnerFacts, type Repo } from "../../core/repos.ts";
import { seatsOf, type Seat } from "../../crew/seats.ts";
import { autonomyStatus } from "../../crew/autonomy.ts";
import { governorSeen } from "../../crew/governed.ts";
import { crewOffInPreview } from "../../crew/preview.ts";
import type { Ctx } from "../../http/context.ts";
import { repoBase } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { icon } from "../icons.ts";
import { crewReadiness } from "../pages/crew.ts";
import { grantsSection } from "../pages/subscriptions.ts";
import { seatSlotsOf, seatSlotsWords, SEAT_UNIT } from "../../crew/seat_slots.ts";
import { directionStall } from "../../crew/planner.ts";
import { directionMarked } from "./direction.ts";
import { fileHoldsCard } from "./file_holds.ts";
import { markOf } from "../../core/marks.ts";
import {
  badge,
  btn,
  type Tone,
  field,
  row,
  selectField,
  userLink,
} from "../ui.ts";

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
  return html`<section class="settings-block">
    <h2>About</h2>
    <form method="post" action="${base}/settings">
      ${field({
        label: "Description",
        name: "description",
        value: repo.description,
        hint: `One line, shown wherever this ${noun} is listed.`,
      })}
      ${selectField({
        label: "Visibility",
        name: "visibility",
        hint:
          repo.visibility === "private"
            ? `A private ${noun} and one that does not exist look identical to anyone else. Making it public shows everyone its code, issues, pulls and run logs; a private app, its previews, its status and its run logs stay open only to people who can write here.`
            : "Public: anyone can read the code, issues, pulls and run logs. A private app, its previews, its status and its run logs stay open only to people who can write here.",
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
      <input type="hidden" name="card" value="about" />
      <div class="form-actions">${btn("Save", { variant: "primary" })}</div>
    </form>
  </section>`;
}

const SEAT_LEAD: Record<Seat["state"], "check" | "alert" | "plus"> = {
  filled: "check",
  warn: "alert",
  invite: "plus",
};

const SEAT_BADGE: Record<Seat["state"], { text: string; tone: Tone }> = {
  filled: { text: "filled", tone: "success" },
  warn: { text: "empty", tone: "attn" },
  invite: { text: "open seat", tone: "default" },
};

/** The script: choosing in a team list, or setting its number, saves at once. */
export const teamJs = /* js */ `
(function () {
  document.querySelectorAll("form[data-team] select, form[data-team] input[type=number]").forEach(function (el) {
    el.addEventListener("change", function () { el.form.requestSubmit(); });
  });
  document.querySelectorAll("form[data-team] button[type=submit]").forEach(function (b) { b.hidden = true; });
})();
`;

const SEAT_TITLE: Record<CrewRole, string> = {
  planner: "Planners",
  builder: "Builders",
  reviewer: "Reviewers",
  maintainer: "Maintainers",
};

/**
 * Your team, as three lists: Planners, Builders, Reviewers (`seatsOf`, the
 * same facts the MCP `crew` tool returns). Each list holds who fills it, a
 * picker of only the agents that declare that role, and how many may work at
 * once; each choice posts at once (`teamJs`; without script, the button is
 * there). A seat with nobody warns when the team is on its own.
 */
function teamCard(
  ctx: Ctx,
  repo: Repo,
  base: string,
  admin: boolean,
  everyone: readonly Agent[],
): Html {
  const team = seatsOf(ctx.app.db, repo, crewOffInPreview());
  const crew = listCrewRoles(ctx.app.db, repo.id);
  const held = new Map(crew.map((c) => [c.agent.user.username, c.role]));
  const byName = new Map(crew.map((c) => [c.agent.user.username, c.agent]));
  const seatSlots = new Map(seatSlotsOf(ctx.app.db, repo).map((p) => [p.role, p]));
  const rows = team.seats.map((p) => {
    const slots = seatSlots.get(p.role)!;
    const paused = slots.slots === 0;
    const b = SEAT_BADGE[p.state];
    const picks = everyone.filter(
      (a) => a.roles.includes(p.role) && held.get(a.user.username) !== p.role,
    );
    const add =
      !admin || picks.length === 0
        ? null
        : html`<form class="row-fields" method="post" action="${base}/settings/crew" data-team>
            <input type="hidden" name="role" value="${p.role}" />
            <label class="sr-only" for="f-add-${p.role}">Add to ${SEAT_TITLE[p.role]}</label>
            <select class="input input-sm" id="f-add-${p.role}" name="agent">
              <option value="" disabled selected>Add…</option>
              ${picks.map((a) => html`<option value="${a.user.username}">${a.user.username}</option>`)}
            </select>
            ${btn("Add", { size: "sm" })}
          </form>`;
    const setter = !admin
      ? null
      : html`<form class="row-fields" method="post" action="${base}/settings/pillars" data-team>
          <input type="hidden" name="seat" value="${p.role}" />
          <label class="sr-only" for="f-seat-${p.role}">${p.role}: ${SEAT_UNIT[p.role]}</label>
          <input class="input input-sm" id="f-seat-${p.role}" name="slots" type="number" inputmode="numeric"
            min="0" max="${String(slots.max)}" value="${String(slots.slots)}" />
          ${btn("Set", { size: "sm" })}
        </form>`;
    const members = p.by.map((u) => {
      const agent = byName.get(u);
      const said = [agent?.model ?? "", agent?.brief ?? ""].filter((w) => w !== "").join(" · ");
      return row({
        lead: icon("bot"),
        title: agent ? userLink(u, { mark: markOf(agent.user) }) : userLink(u),
        ...(said === "" ? {} : { meta: html`<span title="${said}">${said}</span>` }),
        ...(admin
          ? {
              trail: html`<form class="row-actions" method="post" action="${base}/settings/crew/${encodeURIComponent(u)}/remove">
                ${btn("Remove", { size: "sm", icon: "x" })}
              </form>`,
            }
          : {}),
        data: { member: u, seat: p.role },
      });
    });
    return row({
      lead: icon(SEAT_LEAD[p.state]),
      title: SEAT_TITLE[p.role],
      meta: html`${p.does}${p.state === "warn" ? ` No ${p.role}: ${p.without}.` : null}`,
      trail: html`${paused ? badge("paused", { tone: "attn" }) : badge(b.text, { tone: b.tone })}${add}`,
      data: { seat: p.role, state: p.state },
      children: [
        ...members,
        row({
          title: paused ? "Paused" : `${String(slots.slots)} ${SEAT_UNIT[p.role]}`,
          meta: html`${seatSlotsWords(slots)}`,
          ...(setter ? { trail: setter } : {}),
          data: { slots: p.role, at: String(slots.slots) },
        }),
      ],
    });
  });
  const maintainers = maintainerRow(base, admin, everyone, crew, held);
  if (maintainers !== null) rows.push(maintainers);
  const intro = crewOffInPreview()
    ? "The crew is off in a preview."
    : team.auto
      ? `Auto mode is on (${team.mode}): the team works on its own.`
      : "Auto mode is off: the team works when asked. Turn it on under On its own. A list's number is how many work at once; 0 pauses it.";
  const nobody = crew.length > 0 ? null : nobodyLine(everyone.length > 0, ctx.auth.user?.isAdmin === true);
  return html`<section class="settings-block" id="team">
    <h2>Your team</h2>
    <p class="small" id="auto-mode" data-auto="${team.auto ? "on" : "off"}">
        ${intro}
      </p>
      ${nobody}
      <ul class="list setting-list">
        ${rows}
      </ul>
  </section>`;
}

/**
 * The maintainers: agents that tend the code (refactors, upkeep) and hold no
 * pillar, so no number of them works at once and an empty list warns of
 * nothing; the row appears once there is one to seat or seated. They are never handed a build, a plan or a review, and never
 * merge or push the default branch.
 */
function maintainerRow(
  base: string,
  admin: boolean,
  everyone: readonly Agent[],
  crew: ReturnType<typeof listCrewRoles>,
  held: ReadonlyMap<string, CrewRole>,
): Html | null {
  const picks = everyone.filter((a) => a.roles.includes("maintainer") && held.get(a.user.username) !== "maintainer");
  const add =
    !admin || picks.length === 0
      ? null
      : html`<form class="row-fields" method="post" action="${base}/settings/crew" data-team>
          <input type="hidden" name="role" value="maintainer" />
          <label class="sr-only" for="f-add-maintainer">Add to ${SEAT_TITLE.maintainer}</label>
          <select class="input input-sm" id="f-add-maintainer" name="agent">
            <option value="" disabled selected>Add…</option>
            ${picks.map((a) => html`<option value="${a.user.username}">${a.user.username}</option>`)}
          </select>
          ${btn("Add", { size: "sm" })}
        </form>`;
  const members = crew
    .filter((c) => c.role === "maintainer")
    .map((c) =>
      row({
        lead: icon("bot"),
        title: userLink(c.agent.user.username, { mark: markOf(c.agent.user) }),
        ...(admin
          ? {
              trail: html`<form class="row-actions" method="post" action="${base}/settings/crew/${encodeURIComponent(c.agent.user.username)}/remove">
                ${btn("Remove", { size: "sm", icon: "x" })}
              </form>`,
            }
          : {}),
        data: { member: c.agent.user.username, seat: "maintainer" },
      }),
    );
  // No maintainer seated and none to add: the row would say nothing, so it is not drawn.
  if (members.length === 0 && add === null) return null;
  return row({
    lead: icon("bot"),
    title: SEAT_TITLE.maintainer,
    meta: html`Keeps the code easy to change.`,
    trail: html`${add}`,
    data: { seat: "maintainer" },
    children: members,
  });
}

/**
 * What an empty crew is told, in one line: pick from a list above, or — when
 * no agent exists on the forge — where one is made (a forge admin) or who
 * can make one (anyone else).
 */
function nobodyLine(agentsExist: boolean, forgeAdmin: boolean): Html {
  return html`<p class="small" id="crew-nobody">
    <strong>Nobody yet.</strong>
    ${agentsExist
      ? "Pick an agent in a list below."
      : forgeAdmin
        ? html`No agents exist on this forge yet. <a href="/settings/crew">Add an agent</a>.`
        : "No agents exist on this forge yet. An admin can add one."}
  </p>`;
}

/** The team, what the crew still needs, and — for a forge admin — whose subscription it spends. */
function crewCard(ctx: Ctx, repo: Repo, base: string, admin: boolean): Html {
  const allListed = listAllAgents(ctx.app, ctx.auth.user);
  const forgeAdmin = ctx.auth.user?.isAdmin === true;
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
  return html`<div id="crew" data-crew-settings>
    ${teamCard(ctx, repo, base, admin, allListed.ok ? allListed.value : [])}
    ${admin ? crewReadiness(ctx) : null}
    ${grants}
  </div>`;
}

function autonomyCard(ctx: Ctx, repo: Repo, base: string, admin: boolean): Html {
  const planner = listCrewRoles(ctx.app.db, repo.id).find(
    (c) => c.role === "planner",
  );
  const stall = admin ? directionStall(ctx.app, repo) : null;
  const status = repo.autonomy === "off" ? undefined : autonomyStatus(ctx.app, repo);
  const governor = governorSeen(ctx.app, ctx.auth.user, repo, new Date());
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
          ${governor === undefined
            ? null
            : html`<dt>Governor</dt>
                <dd>${governor.why}</dd>`}
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
          ${directionMarked(repo.autonomyDirection)}
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
              ? html`Planner here:
                ${userLink(planner.agent.user.username, {
                  mark: markOf(planner.agent.user),
                })}.`
              : html`No planner on the crew yet — set one under Crew, or the
                map is only what people write.`}
          </p>
          ${stall === null ? null : html`<p class="hint" id="direction-stall">${stall}</p>`}
        </div>
        ${selectField({
          label: "Decisions here",
          name: "decisions",
          hint: "Who answers the hand-overs this asks of you. The decider answers in the ledger with its reason and context; ‘tell me’ sets a card aside only when it is sure and leaves the unsure ones on your board. A shelved repository (autonomy off) has its parked cards closed by rule, with no model call, when decisions go to the decider. Needs a decider set up on this forge.",
          options: [
            { value: "me", label: "Me", selected: repo.decisionsBy === "me" },
            {
              value: "decider",
              label: "The decider",
              selected: repo.decisionsBy === "decider",
            },
            {
              value: "decider_tell",
              label: "The decider, and tell me the ones it was unsure of",
              selected: repo.decisionsBy === "decider_tell",
            },
          ],
        })}
        ${field({
          label: "Ceiling per day",
          name: "ceiling",
          value: String(repo.autonomyCeilingUsd),
          type: "number",
          hint: `Dollars of agent spend on this ${getAppByRepo(ctx.app.db, repo.id) === undefined ? "repository" : "app"} per UTC day. At the ceiling the crew stops picking until midnight; nothing in flight is cut.`,
        })}
        <div class="form-actions">${btn("Save", { variant: "primary" })}</div>
      </form>`;
  return html`<section class="settings-block" id="autonomy">
    <h2>On its own</h2>
    ${state}${form}
  </section>`;
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
    return html`<section class="settings-block">
      <p class="muted small">
        The crew and how this ${isApp ? "app" : "repository"} runs itself are
        visible to people who can write here.
      </p>
    </section>`;
  return html`<div class="stack">
    ${aboutCard(repo, base, admin, isApp)}
    ${crewCard(ctx, repo, base, admin)}
    ${autonomyCard(ctx, repo, base, admin)}
    ${admin ? fileHoldsCard(ctx, repo, base) : null}
  </div>`;
}
