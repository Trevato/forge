/**
 * The crew, in account settings: the forge's agents. A forge admin's
 * section — an agent is an account that acts — so a non-admin gets the one
 * 404 rather than a door they cannot open, and the nav never shows it to
 * them. Every write is an action; the page says whether the runner behind
 * the crew is actually there, in words, before anyone assigns anything.
 */

import {
  createAgent,
  deleteAgent,
  getAgentView,
  listAllAgents,
  updateAgent,
} from "../../actions/crew.ts";
import {
  BRIEF_MAX,
  MODEL_MAX,
  type Agent,
} from "../../core/agents.ts";
import {
  agentSplits,
  agentTotals,
  type AgentTotals,
  type SplitTotals,
} from "../../core/runs.ts";
import {
  crewScorecards,
  crewScorecardSplits,
  teamScorecards,
  splitLabel,
  RECENT_DAYS,
  recentWindow,
  spanText,
  type Scorecard,
  type SplitScorecard,
} from "../../core/scorecard.ts";
import { modelDays, type ModelDay } from "../../core/model_days.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { listTeams, type Team } from "../../core/teams.ts";
import { crewFor } from "../../crew/dispatch.ts";
import { crewHandover, type CrewHandover } from "../../crew/handed.ts";
import { MODELS } from "../../crew/models.ts";
import type { Ctx } from "../../http/context.ts";
import { autonomyStatus, type AutonomyStatus } from "../../crew/autonomy.ts";
import { listAutonomousRepos, type Repo } from "../../core/repos.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { field, readForm, type Form } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import {
  btn,
  card,
  confirmAction,
  empty,
  icon,
  time,
  field as uiField,
  selectField,
  userLink,
} from "../ui.ts";
import { accountSections } from "./origins.ts";
import { markOf } from "../../core/marks.ts";
import { limitValue } from "../../settings/limits.ts";
import { USERNAME_TAKEN } from "../../actions/signup_words.ts";
import { forgeCeiling } from "../../flow/ceiling.ts";

/** The admin, or the response that turns everyone else away. */
function requireAdmin(ctx: Ctx): Response | undefined {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  return undefined;
}

/** The gate every crew POST passes: an admin, same-origin, admin scope. */
async function adminForm(ctx: Ctx): Promise<Form | Response> {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  return readForm(ctx, "admin");
}

function shell(ctx: Ctx, title: string, body: Html, status = 200): Response {
  return page(
    {
      ctx,
      title,
      body: html`<div class="page-head"><h1>${title}</h1></div>
        ${settingsLayout(
          accountSections("crew", { admin: true }),
          body,
          "Account settings",
        )}`,
    },
    status,
  );
}

/**
 * Whether anything will pick up an agent's work. The runner is detected
 * once at boot; this is that answer, said before an issue is assigned
 * rather than after it sits there.
 */
export function crewReadiness(ctx: Ctx): Html {
  const crew = crewFor(ctx.app);
  if (crew === undefined)
    return card(
      html`<p>
        ${icon("alert")} No crew runner is up on this forge, so assigned issues
        will wait. Start the forge with apps on (the default) and Claude Code
        on <span class="mono">PATH</span> or at
        <span class="mono">FORGE_CLAUDE</span>.
      </p>`,
      { tone: "danger", extra: "mb" },
    );
  if (!crew.ready)
    return card(
      html`<p>
        ${icon("alert")} The crew cannot run: ${crew.detail}. Agents can be
        created, but nothing picks up their work until this is fixed.
      </p>`,
      { tone: "danger", extra: "mb" },
    );
  return html`<p class="muted small mb">
    ${icon("check")} ${crew.detail} is ready to run the crew.
  </p>
  ${when(
    !crew.sandbox.enforced,
    () =>
      card(
        html`<p>
          ${icon("alert")} Unsandboxed: agents' shells run unrestricted here
          (${crew.sandbox.reason}). They can read this forge's data and reach
          any host.
        </p>`,
        { tone: "danger", extra: "mb", id: "crew-unsandboxed" },
      ),
  )}`;
}

// ---- the form ----

interface AgentValues {
  username: string;
  displayName: string;
  model: string;
  brief: string;
  budgetUsd: string;
}

const agentErrors = (ctx: Ctx): Record<string, string> => ({
  invalid_username: "Usernames are letters, digits, dots, dashes.",
  username_taken: USERNAME_TAKEN,
  email_taken: USERNAME_TAKEN,
  invalid_model: `A model is up to ${MODEL_MAX} characters with no spaces.`,
  brief_too_long: `A brief is at most ${BRIEF_MAX} characters.`,
  invalid_budget: `A budget is a number of dollars between 0 and ${limitValue(ctx.app.db, "agent.budget_max_usd")}.`,
});

function agentFields(values: AgentValues, error?: string): Html {
  return html`${selectField({
    label: "Model",
    name: "model",
    options: MODELS.map((m) => ({
      value: m.id,
      label: m.label,
      selected: m.id === values.model,
    })),
    hint: "An alias names the newest of its line, so the choice does not age.",
    ...(error !== undefined && error.startsWith("A model") ? { error } : {}),
  })}
  ${uiField({
    label: "Brief",
    name: "brief",
    type: "textarea",
    rows: 5,
    value: values.brief,
    hint: "Who this agent is, in its own voice — appended to the prompt of every run. The repository's AGENTS.md says what the work is; this says who does it.",
    ...(error !== undefined && error.startsWith("A brief") ? { error } : {}),
  })}
  ${uiField({
    label: "Budget per run (USD)",
    name: "budgetUsd",
    type: "number",
    value: values.budgetUsd,
    hint: "What one run may spend. 0 uses the forge's default (FORGE_CREW_BUDGET_USD).",
    ...(error !== undefined && error.startsWith("A budget") ? { error } : {}),
  })}`;
}

const valuesOf = (agent: Agent): AgentValues => ({
  username: agent.user.username,
  displayName: agent.user.displayName,
  model: agent.model,
  brief: agent.brief,
  budgetUsd: agent.budgetUsd === 0 ? "" : String(agent.budgetUsd),
});

const budgetOf = (form: Form): number | undefined => {
  const raw = field(form, "budgetUsd").trim();
  return raw === "" ? undefined : Number(raw);
};

// ---- the list ----

/**
 * How an agent does, in the numbers that matter: runs and how many landed,
 * pulls a person merged, and what a run costs in money, minutes and turns.
 * A quiet dash before any.
 */
function totalsCells(t: AgentTotals | undefined): Html {
  if (t === undefined || t.runs === 0)
    return html`<td class="num muted">—</td>
      <td class="num muted">—</td>
      <td class="num muted">—</td>
      <td class="num muted">—</td>
      <td class="num muted">—</td>`;
  const mean =
    t.meanSeconds === null
      ? "—"
      : t.meanSeconds < 90
        ? `${Math.round(t.meanSeconds)}s`
        : `${Math.round(t.meanSeconds / 60)}m`;
  const perRun = t.meanCostUsd === null ? "—" : `$${t.meanCostUsd.toFixed(2)}`;
  const turns =
    t.meanTurns === null ? "" : ` · ${Math.round(t.meanTurns)} turns`;
  return html`<td class="num">
      ${t.runs}
      <span class="muted small"
        >${t.ok} ok${t.failed > 0 ? html`, ${t.failed} failed` : null}</span
      >
    </td>
    <td class="num">
      ${t.merged}
      ${when(
        t.retries > 0,
        () =>
          html`<span class="muted small"
            >${Math.round((100 * t.retries) / t.runs)}% retries</span
          >`,
      )}
    </td>
    <td class="num">$${t.spentUsd.toFixed(2)}</td>
    <td class="num">
      ${t.merged === 0 ? "—" : `$${(t.spentUsd / t.merged).toFixed(0)}`}
    </td>
    <td class="num">
      ${perRun}
      <span class="muted small">${mean}${turns}</span>
    </td>`;
}

const pairKey = (p: SplitScorecard) => `${p.model}\0${p.promptVersion}`;

/**
 * The scorecard: how each agent's pulls fare once opened — so the owner
 * can tune who does what. Landed, review rounds and red checks stand as the
 * last 30 days beside all time, so a change to an agent shows as movement.
 * What they cost is the table above's ("Per landed"), not repeated here. An
 * agent with no pull yet is a row of dashes, never a row of misleading
 * zeros. Under each agent, one sub-row per model and prompt version its pulls
 * ran on, with the same figures; pulls from before runs recorded either read
 * "unrecorded". The agent's name stays in view while a phone scrolls the figures
 * sideways.
 */
function scorecardCard(
  agents: readonly Agent[],
  teams: readonly Team[],
  teamCards: ReadonlyMap<string, Scorecard>,
  recentTeamCards: ReadonlyMap<string, Scorecard>,
  cards: ReadonlyMap<string, Scorecard>,
  recent: ReadonlyMap<string, Scorecard>,
  splits: ReadonlyMap<string, readonly SplitScorecard[]>,
  recentSplits: ReadonlyMap<string, readonly SplitScorecard[]>,
): Html {
  const dash = html`<td class="num muted">—</td>`;
  const lately = `${RECENT_DAYS} days`;
  const windowHead = (label: string, span: string) =>
    html`<th>${label}<br /><span class="muted small">${span}</span></th>`;
  const landed = (s: Scorecard | undefined) =>
    s === undefined
      ? dash
      : html`<td class="num">
          ${s.landed}
          <span class="muted small">of ${s.opened}</span>
        </td>`;
  const rounds = (s: Scorecard | undefined) =>
    s?.reviewRounds == null
      ? dash
      : html`<td class="num">${s.reviewRounds.toFixed(1)}</td>`;
  const red = (s: Scorecard | undefined) =>
    s?.redCheckRate == null
      ? dash
      : html`<td class="num">${Math.round(100 * s.redCheckRate)}%</td>`;
  const figures = (r: Scorecard | undefined, s: Scorecard | undefined) =>
    html`${landed(r)}${landed(s)}${rounds(r)}${rounds(s)}${red(r)}${red(s)}
    ${s === undefined
      ? html`${dash}${dash}`
      : html`<td class="num">${s.reverts}</td>
          ${s.meanLandMs === null
            ? dash
            : html`<td class="num">${spanText(s.meanLandMs)}</td>`}`}`;
  return card(
    html`<div class="table-scroll">
      <table class="table" id="crew-scorecard" data-sticky-lead>
        <thead>
          <tr>
            <th>Agent / team</th>
            ${windowHead("Pulls landed", lately)}
            ${windowHead("Pulls landed", "all time")}
            ${windowHead("Review rounds", lately)}
            ${windowHead("Review rounds", "all time")}
            ${windowHead("Red checks", lately)}
            ${windowHead("Red checks", "all time")}
            <th>Reverts</th>
            <th>Time to land</th>
          </tr>
        </thead>
        <tbody>
          ${agents.map((agent) => {
            const s = cards.get(agent.user.id);
            const r = recent.get(agent.user.id);
            const pairs = splits.get(agent.user.id) ?? [];
            const lately = new Map(
              (recentSplits.get(agent.user.id) ?? []).map((p) => [pairKey(p), p]),
            );
            return html`<tr>
                <td>
                  ${userLink(agent.user.username, {
                    avatar: false,
                    mark: markOf(agent.user),
                  })}
                </td>
                ${figures(r, s)}
              </tr>
              ${pairs.map((p) => {
                const label = splitLabel(p);
                return html`<tr data-sub>
                  <td class="muted small mono" title="${label}">${label}</td>
                  ${figures(lately.get(pairKey(p)), p)}
                </tr>`;
              })}`;
          })}
          ${teams
            .filter((team) => teamCards.has(team.slug))
            .map((team) => html`<tr data-team="${team.slug}">
              <td>${team.name} <span class="muted small">team</span></td>
              ${figures(recentTeamCards.get(team.slug), teamCards.get(team.slug))}
            </tr>`)}
        </tbody>
      </table>
    </div>`,
    {
      pad: false,
      extra: "mt mb",
      head: html`${icon("activity")}
        <h2>Scorecard</h2>
        <span class="muted small"
          >Over the pulls each agent opened, and each team's members pooled (an
          agent on two teams counts in both), in the last ${RECENT_DAYS} days
          and over all time: review rounds are change requests per landed pull, red checks
          the share of finished checks that failed; reverts (the landed pulls
          a merged pull took back) and time to land (the mean from opening to
          merge) are all time.</span
        >`,
    },
  );
}

/** Today's spend against each ceiling: the drain, and the knob for it. */
function spendingCard(
  spending: readonly { repo: Repo; status: AutonomyStatus }[],
  forgeCap: number | undefined,
): Html {
  const total = spending.reduce((n, s) => n + s.status.spentTodayUsd, 0);
  const cap = spending.reduce((n, s) => n + s.status.ceilingUsd, 0);
  return card(
    html`<ul class="list">
      ${spending.map(
        ({ repo, status }) =>
          html`<li>
            <a
              href="/${repo.ownerName}/${repo.name}/settings/autonomy"
              class="row"
              data-nav
              tabindex="-1"
            >
              <span class="row-lead">${icon("rocket")}</span>
              <span class="row-main">
                <span class="row-title">${repo.ownerName}/${repo.name}</span>
                <span class="row-meta"
                  >${repo.autonomy} · ${status.slots}
                  ${status.slots === 1 ? "slot" : "slots"} · ${status.active}
                  active${status.paused === "ceiling"
                    ? " · paused at the ceiling until 00:00 UTC"
                    : status.paused === "forge ceiling"
                      ? " · paused at the forge's ceiling until 00:00 UTC"
                      : ""}</span
                >
              </span>
              <span class="row-trail">
                <b>$${status.spentTodayUsd.toFixed(0)}</b>
                <span class="muted"
                  >/ $${status.ceilingUsd.toFixed(0)} today</span
                >
              </span>
            </a>
          </li>`,
      )}
    </ul>`,
    {
      pad: false,
      extra: "mb",
      head: html`${icon("activity")}
        <h2>Spending today</h2>
        <span class="muted small"
          >$${total.toFixed(0)} of $${cap.toFixed(0)} across ${spending.length}
          ${spending.length === 1 ? "app" : "apps"} running on their
          own${forgeCap === undefined
            ? "; no forge-wide ceiling is set (FORGE_CREW_CEILING_USD)"
            : `, under the forge's $${forgeCap.toFixed(0)} a day`};
          the ceilings reset at 00:00 UTC</span
        >`,
    },
  );
}

/** What the scorecard and split cards read. */
function loadScorecards(ctx: Ctx) {
  return {
    totals: agentTotals(ctx.app.db),
    teams: listTeams(ctx.app.db),
    teamCards: teamScorecards(ctx.app.db),
    recentTeamCards: teamScorecards(ctx.app.db, recentWindow()),
    scorecards: crewScorecards(ctx.app.db),
    recentScorecards: crewScorecards(ctx.app.db, recentWindow()),
    splitScorecards: crewScorecardSplits(ctx.app.db),
    recentSplitScorecards: crewScorecardSplits(ctx.app.db, recentWindow()),
    byModel: agentSplits(ctx.app.db, "model"),
    byPrompt: agentSplits(ctx.app.db, "prompt_version"),
    byModelDay: modelDays(ctx.app.db),
  };
}

/**
 * Where the money goes today: every app running on its own, its spend
 * against its ceiling. The ceilings are the one control on the drain, and
 * this is the page where the crew is wielded, so they are read here.
 */
function loadSpending(ctx: Ctx) {
  return listAutonomousRepos(ctx.app.db).map((repo) => ({
    repo,
    status: autonomyStatus(ctx.app, repo),
  }));
}

interface CrewData {
  scorecards: ReturnType<typeof loadScorecards>;
  spending: ReturnType<typeof loadSpending>;
}

function crewView(
  ctx: Ctx,
  values: AgentValues,
  error?: string,
  data: CrewData = { scorecards: loadScorecards(ctx), spending: loadSpending(ctx) },
): Html {
  const listed = listAllAgents(ctx.app, ctx.auth.user);
  const agents = listed.ok ? listed.value : [];
  const {
    totals,
    teams,
    teamCards,
    recentTeamCards,
    recentScorecards,
    splitScorecards,
    recentSplitScorecards,
  } = data.scorecards;
  const { scorecards, byModel, byPrompt, byModelDay } = data.scorecards;
  const { spending } = data;
  const usernameError =
    error !== undefined && /username/i.test(error) ? error : undefined;
  const handover = crewHandover(ctx.app.db);
  return html`${crewReadiness(ctx)}
  ${when(spending.length > 0, () =>
    spendingCard(spending, forgeCeiling(ctx.app.config) ?? undefined),
  )}
  ${agents.length === 0
    ? empty({
        icon: "bot",
        title: "No agents yet",
        note: "An agent is an account that works on a repository while you are elsewhere. Make one below, then put it on a repository's crew in that repository's settings.",
      })
    : card(
        html`<div class="table-scroll">
          <table class="table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Model</th>
                <th>Budget</th>
                <th>Runs</th>
                <th>Landed</th>
                <th>Spent</th>
                <th>Per landed</th>
                <th>Per run</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${agents.map(
                (agent) =>
                  html`<tr>
                    <td>
                      ${icon("bot")}
                      ${userLink(agent.user.username, {
                        avatar: false,
                        mark: markOf(agent.user),
                      })}
                      ${when(
                        agent.user.displayName !== agent.user.username,
                        () =>
                          html`<span class="muted small"
                            >${agent.user.displayName}</span
                          >`,
                      )}
                      ${when(
                        agent.brief !== "",
                        () =>
                          html`<div
                            class="muted small truncate"
                            title="${agent.brief}"
                          >
                            ${agent.brief}
                          </div>`,
                      )}
                    </td>
                    <td class="mono">
                      ${agent.model === ""
                        ? html`<span class="muted">default</span>`
                        : agent.model}
                    </td>
                    <td class="num">
                      ${agent.budgetUsd === 0
                        ? html`<span class="muted">default</span>`
                        : `$${agent.budgetUsd.toFixed(2)}`}
                    </td>
                    ${totalsCells(totals.get(agent.user.id))}
                    <td class="muted">${time(agent.createdAt)}</td>
                    <td>
                      <span class="bar">
                        ${btn("Edit", {
                          href: `/settings/crew/${encodeURIComponent(agent.user.username)}`,
                          size: "sm",
                          icon: "pencil",
                        })}
                        ${confirmAction({
                          action: `/settings/crew/${encodeURIComponent(agent.user.username)}/delete`,
                          verb: "Retire",
                          size: "sm",
                        })}
                      </span>
                    </td>
                  </tr>`,
              )}
            </tbody>
          </table>
        </div>`,
        { pad: false },
      )}
  ${when(agents.length > 0, () =>
    scorecardCard(
      agents,
      teams,
      teamCards,
      recentTeamCards,
      scorecards,
      recentScorecards,
      splitScorecards,
      recentSplitScorecards,
    ),
  )}
  ${splitsCard(
    "Per model",
    "Model",
    byModel,
    () => html`<span class="muted">default</span>`,
  )}
  ${modelDaysCard(byModelDay)}
  ${splitsCard(
    "Per prompt version",
    "Prompt version",
    byPrompt,
    () => html`<span class="muted">not recorded</span>`,
  )}
  ${handedCard(handover.parked)}${drillCard(handover.drill)}
  ${card(
    html`<form method="post" action="/settings/crew">
      ${uiField({
        label: "Username",
        name: "username",
        value: values.username,
        required: true,
        pattern: "[A-Za-z0-9][A-Za-z0-9._-]*",
        hint: "Its handle: the author on the pull requests it opens, and the first half of its branch names.",
        ...(usernameError ? { error: usernameError } : {}),
      })}
      ${uiField({
        label: "Display name",
        name: "displayName",
        value: values.displayName,
        hint: "Optional. Shown beside the username.",
      })}
      ${agentFields(values, usernameError === undefined ? error : undefined)}
      <div class="form-actions">
        ${btn("Create agent", { variant: "primary", icon: "bot" })}
        ${btn("Teams", { href: "/settings/teams", variant: "ghost" })}
      </div>
    </form>`,
    {
      head: html`${icon("bot")}
        <h2>New agent</h2>`,
    },
  )}`;
}

/** Issues the crew parked twice and the planner now holds; nothing when there are none. */
function handedCard(parked: CrewHandover["parked"]): Html {
  if (parked.length === 0) return html``;
  return card(
    html`<div class="table-scroll"><table class="table">
      <thead>
        <tr>
          <th>Issue</th>
          <th>Last parked</th>
          <th>Why</th>
        </tr>
      </thead>
      <tbody>
        ${parked.map(
          (r) => html`<tr>
            <td>
              <span class="mono">${r.repo}</span>
              <a href="/${r.repo}/issues/${r.number}">#${r.number} ${r.title}</a>
            </td>
            <td>${time(r.at)}</td>
            <td>
              ${r.reasons.map((why) => html`<div class="small">${why}</div>`)}
            </td>
          </tr>`,
        )}
      </tbody>
    </table></div>`,
    {
      pad: false,
      id: "crew-handed",
      head: html`${icon("bot")}
        <h2>Handed to the planner</h2>`,
    },
  );
}

/** The last restore drill's verdict; nothing before a first drill. */
function drillCard(drill: CrewHandover["drill"]): Html {
  if (drill === undefined) return html``;
  return card(
    html`<p>${drill.verdict === "green" ? "Passed" : "Failed"} ${time(drill.at)}.</p>`,
    {
      id: "crew-drill",
      tone: drill.verdict === "green" ? "default" : "danger",
      attrs: html`data-drill="${drill.verdict}"`,
      head: html`${icon("clock")}
        <h2>Restore drill</h2>`,
    },
  );
}

/** Spend and landed pulls per model per day: the escalation, measured. */
function modelDaysCard(rows: readonly ModelDay[]): Html {
  if (rows.length === 0) return html``;
  return card(
    html`<div class="table-scroll">
      <table class="table" id="crew-model-days">
        <thead>
          <tr>
            <th>Day</th>
            <th>Model</th>
            <th>Runs</th>
            <th>Spent</th>
            <th>Landed</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(
            (r) => html`<tr>
              <td class="mono">${r.day}</td>
              <td class="mono">${r.model === "" ? html`<span class="muted">default</span>` : r.model}</td>
              <td class="num">${r.runs}</td>
              <td class="num">$${r.spentUsd.toFixed(2)}</td>
              <td class="num">${r.landed}</td>
            </tr>`,
          )}
        </tbody>
      </table>
    </div>`,
    { pad: false, head: html`<h2>Per model per day</h2>` },
  );
}

/** The scorecard cut by one thing the runs ran on; nothing before a first run. */
function splitsCard(
  title: string,
  column: string,
  rows: readonly SplitTotals[],
  blank: (key: string) => Html,
): Html {
  if (rows.length === 0) return html``;
  return card(
    html`<div class="table-scroll">
      <table class="table">
        <thead>
          <tr>
            <th>${column}</th>
            <th>Runs</th>
            <th>Landed</th>
            <th>Failed</th>
            <th>Spent</th>
            <th>Per run</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(
            (r) => html`<tr>
              <td class="mono">${r.key === "" ? blank(r.key) : r.key}</td>
              <td class="num">${r.runs}</td>
              <td class="num">${r.ok}</td>
              <td class="num">${r.failed}</td>
              <td class="num">$${r.spentUsd.toFixed(2)}</td>
              <td class="num">$${(r.spentUsd / r.runs).toFixed(2)}</td>
            </tr>`,
          )}
        </tbody>
      </table>
    </div>`,
    { pad: false, head: html`<h2>${title}</h2>` },
  );
}

const EMPTY: AgentValues = {
  username: "",
  displayName: "",
  model: "",
  brief: "",
  budgetUsd: "",
};

// GET /settings/crew
export function crewPage(ctx: Ctx): Response {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  let at = performance.now();
  const scorecards = loadScorecards(ctx);
  notePhase(ctx.request, "scorecards", performance.now() - at);
  at = performance.now();
  const spending = loadSpending(ctx);
  notePhase(ctx.request, "spending", performance.now() - at);
  at = performance.now();
  const res = shell(
    ctx,
    "Crew",
    crewView(ctx, EMPTY, undefined, { scorecards, spending }),
  );
  notePhase(ctx.request, "render", performance.now() - at);
  return res;
}

// POST /settings/crew
export async function agentCreate(ctx: Ctx): Promise<Response> {
  const form = await adminForm(ctx);
  if (form instanceof Response) return form;
  const values: AgentValues = {
    username: field(form, "username").trim(),
    displayName: field(form, "displayName").trim(),
    model: field(form, "model").trim(),
    brief: field(form, "brief"),
    budgetUsd: field(form, "budgetUsd").trim(),
  };
  const budgetUsd = budgetOf(form);
  const made = await createAgent(ctx.app, ctx.auth.user, {
    username: values.username,
    ...(values.displayName === "" ? {} : { displayName: values.displayName }),
    model: values.model,
    brief: values.brief,
    ...(budgetUsd === undefined ? {} : { budgetUsd }),
  });
  if (!made.ok) {
    if (made.error === "forbidden" || made.error === "unauthorized")
      return notFoundPage(ctx);
    return shell(
      ctx,
      "Crew",
      crewView(
        ctx,
        values,
        agentErrors(ctx)[made.error] ?? "That agent could not be created.",
      ),
      422,
    );
  }
  return flashTo(ctx, "/settings/crew", {
    message: `${made.value.user.username} is on the forge. Put it on a repository's crew under that repository's settings.`,
  });
}

// ---- one agent ----

function agentView(agent: Agent, values: AgentValues, error?: string): Html {
  const at = `/settings/crew/${encodeURIComponent(agent.user.username)}`;
  return html`${card(
    html`<form method="post" action="${at}">
      <div class="field">
        <label for="f-username">Username</label>
        <input
          class="input"
          id="f-username"
          value="${agent.user.username}"
          readonly
        />
      </div>
      ${agentFields(values, error)}
      <div class="form-actions">
        ${btn("Save changes", { variant: "primary" })}
        ${btn("Back to the crew", { href: "/settings/crew", variant: "ghost" })}
      </div>
    </form>`,
    {
      head: html`${icon("bot")}
        <h2>${agent.user.username}</h2>
        <span class="muted small">added ${time(agent.createdAt)}</span>`,
    },
  )}
  ${card(
    html`<p>
        Retiring <strong>${agent.user.username}</strong> destroys its tokens and
        takes it off every crew. What it wrote stays, under its name.
      </p>
      <div class="form-actions">
        ${confirmAction({ action: `${at}/delete`, verb: "Retire this agent" })}
      </div>`,
    {
      tone: "danger",
      head: html`${icon("alert")}
        <h2>Retire</h2>`,
    },
  )}`;
}

function loadAgent(ctx: Ctx): Agent | undefined {
  const found = getAgentView(ctx.app, ctx.auth.user, ctx.params.username ?? "");
  return found.ok ? found.value : undefined;
}

// GET /settings/crew/:username
export function agentPage(ctx: Ctx): Response {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const agent = loadAgent(ctx);
  if (!agent) return notFoundPage(ctx);
  return shell(ctx, agent.user.username, agentView(agent, valuesOf(agent)));
}

// POST /settings/crew/:username
export async function agentUpdate(ctx: Ctx): Promise<Response> {
  const form = await adminForm(ctx);
  if (form instanceof Response) return form;
  const agent = loadAgent(ctx);
  if (!agent) return notFoundPage(ctx);
  const values: AgentValues = {
    ...valuesOf(agent),
    model: field(form, "model").trim(),
    brief: field(form, "brief"),
    budgetUsd: field(form, "budgetUsd").trim(),
  };
  const updated = updateAgent(ctx.app, ctx.auth.user, agent.user.username, {
    model: values.model,
    brief: values.brief,
    budgetUsd: budgetOf(form) ?? 0,
  });
  if (!updated.ok) {
    if (updated.error === "not_found") return notFoundPage(ctx);
    return shell(
      ctx,
      agent.user.username,
      agentView(
        agent,
        values,
        agentErrors(ctx)[updated.error] ?? "Those changes could not be saved.",
      ),
      422,
    );
  }
  return flashTo(
    ctx,
    `/settings/crew/${encodeURIComponent(agent.user.username)}`,
    { message: "Agent updated." },
  );
}

// POST /settings/crew/:username/delete
export async function agentDelete(ctx: Ctx): Promise<Response> {
  const form = await adminForm(ctx);
  if (form instanceof Response) return form;
  const username = ctx.params.username ?? "";
  const removed = deleteAgent(ctx.app, ctx.auth.user, username);
  return flashTo(ctx, "/settings/crew", {
    ...(removed.ok
      ? { message: `${username} was retired.` }
      : { tone: "danger" as const, message: "No such agent." }),
  });
}
