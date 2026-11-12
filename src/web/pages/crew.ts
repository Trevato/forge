/**
 * The crew, in account settings: the forge's agents. A forge admin's
 * section — an agent is an account that acts — so a non-admin gets the one
 * 404 rather than a door they cannot open, and the nav never shows it to
 * them. Every write is an action; the page says whether the runner behind
 * the crew is actually there, in words, before anyone assigns anything.
 */

import { budgetsCard } from "../studio/crew_budgets.ts";
import { fundingOf, fundingWords } from "../../spawn/funding.ts";
import {
  createAgent,
  deleteAgent,
  getAgentView,
  listAllAgents,
  updateAgent,
} from "../../actions/crew.ts";
import {
  BRIEF_MAX,
  CREW_ROLES,
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
import { keeperDays, type KeeperDay } from "../../flow/keeper_rate.ts";
import { weekCard, weekReturns, WEEK_DAYS, type ReturnedPull, type WeekLine } from "../../crew/week_card.ts";
import { knobsCard } from "./knobs.ts";
import { decideChange, readReview } from "../../actions/model_review.ts";
import { wastedDays, type WastedDay } from "../../core/wasted_days.ts";
import { modelDays, type ModelDay } from "../../core/model_days.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { listTeams, type Team } from "../../core/teams.ts";
import { isHostedChild } from "../../spawn/hosted-mark.ts";
import { crewFor } from "../../crew/dispatch.ts";
import { crewHandover, type CrewHandover } from "../../crew/handed.ts";
import { MODELS } from "../../crew/models.ts";
import type { Ctx } from "../../http/context.ts";
import { autonomyStatus, type AutonomyStatus } from "../../crew/autonomy.ts";
import { listAutonomousRepos, type Repo } from "../../core/repos.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { field, readForm, type Form } from "../form.ts";
import { html, raw, when, type Html } from "../html.ts";
import { helpAsked, pageHelp } from "../page_help.ts";
import { flashTo, page } from "../layout.ts";
import {
  btn,
  confirmAction,
  disclosure,
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

interface PanelOptions {
  title: string;
  /** One muted sentence under the heading. */
  note?: Html;
  id?: string;
  /** Extra attributes on the section (the restore drill's verdict). */
  attrs?: Html;
}

/** A titled block of the crew list: heading, a quiet note, then the body, no box. */
function panel(body: Html, o: PanelOptions): Html {
  return html`<section
    class="settings-block"
    ${o.id ? html`id="${o.id}"` : null}
    ${o.attrs ?? null}
  >
    <h2>${o.title}</h2>
    ${o.note ? html`<p class="muted small">${o.note}</p>` : null}
    ${body}
  </section>`;
}

/**
 * Whether anything will pick up an agent's work. The runner is detected
 * once at boot; this is that answer, said before an issue is assigned
 * rather than after it sits there.
 */
export function crewReadiness(ctx: Ctx): Html {
  const crew = crewFor(ctx.app);
  if (crew === undefined && isHostedChild(ctx.app))
    return html`<div class="toast" data-tone="danger" role="alert">${icon("alert")}<div class="toast-body">This forge is hosted inside another forge's process,
        which has no crew runner for it: assigned issues will wait. The crew
        runs once this forge has a process of its own.</div></div>`;
  if (crew === undefined)
    return html`<div class="toast" data-tone="danger" role="alert">${icon("alert")}<div class="toast-body">No crew runner is up on this forge, so assigned issues
        will wait. Start the forge with apps on (the default) and Claude Code
        on <span class="mono">PATH</span> or at
        <span class="mono">FORGE_CLAUDE</span>.</div></div>`;
  if (!crew.ready)
    return html`<div class="toast" data-tone="danger" role="alert">${icon("alert")}<div class="toast-body">The crew cannot run: ${crew.detail}. Agents can be
        created, but nothing picks up their work until this is fixed.</div></div>`;
  const funded = fundingOf(ctx.app.config.dataDir);
  // A word and a glyph; a forge its parent funds says so on the same line (#10484).
  return html`<p class="mb">
    ${icon("check")} <strong>Ready</strong> <span class="muted">${crew.detail}</span>${funded === undefined ? null : html` <span class="muted" data-funded>${fundingWords(funded)}</span>`}
  </p>
  ${when(
    !crew.sandbox.enforced,
    () =>
      html`<div class="toast" data-tone="danger" role="alert" id="crew-unsandboxed">${icon("alert")}<div class="toast-body">Unsandboxed: agents' shells run unrestricted here
          (${crew.sandbox.reason}). They can read this forge's data and reach
          any host.</div></div>`,
  )}`;
}

// ---- the form ----

interface AgentValues {
  username: string;
  displayName: string;
  model: string;
  brief: string;
  budgetUsd: string;
  roles: readonly string[];
}

const agentErrors = (ctx: Ctx): Record<string, string> => ({
  invalid_username: "Usernames are letters, digits, dots, dashes.",
  username_taken: USERNAME_TAKEN,
  email_taken: USERNAME_TAKEN,
  invalid_model: `A model is up to ${MODEL_MAX} characters with no spaces.`,
  brief_too_long: `A brief is at most ${BRIEF_MAX} characters.`,
  invalid_roles: "Pick at least one job: planner, builder, reviewer or maintainer.",
  role_held: "That agent still holds a seat it would lose on a repository. Move it there first, under Settings → Crew.",
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
  <fieldset class="field" id="agent-roles">
    <legend>Jobs</legend>
    ${CREW_ROLES.map(
      (r) => html`<label class="check"><input type="checkbox" name="roles" value="${r}" ${values.roles.includes(r) ? raw("checked") : null} />
        <span>${r}</span></label>`,
    )}
    <p class="hint">What this agent does. A repository's team lists offer it only for these, and a dispatch never hands it another kind of job.${error !== undefined && error.startsWith("Pick at least") ? html` <strong>${error}</strong>` : null}</p>
  </fieldset>
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
  roles: agent.roles,
});

const rolesOf = (form: Form): string[] => form.getAll("roles").map(String);

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
  return panel(
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
      title: "Scorecard",
    },
  );
}

/** A Returned count above zero links to its fold below; zero stays a bare 0. Only the count sits in the numeric cell. */
function returnedCount(l: WeekLine, pulls: readonly ReturnedPull[]): Html | number {
  if (l.returned === 0 || pulls.length === 0) return l.returned;
  return html`<a href="#returned-${l.username}">${l.returned}</a>`;
}

/** The pulls that came back and why, folded in a full-width row under the member's: one link per pull. */
function returnedRow(l: WeekLine, pulls: readonly ReturnedPull[]): Html | null {
  if (l.returned === 0 || pulls.length === 0) return null;
  const more = l.returned - pulls.length;
  return html`<tr data-returned="${l.username}">
    <td colspan="4">${disclosure(
      `${l.returned} returned to ${l.username}`,
      html`<ul class="list">
        ${pulls.map(
          (p) => html`<li>
            <span class="muted">${p.repo}</span>
            <a href="/${p.repo}/pulls/${p.number}">#${p.number}</a> ${p.title}${p.why ? html` <span class="muted">— ${p.why}</span>` : null}
          </li>`,
        )}
        ${more > 0 ? html`<li class="muted">and ${more} more</li>` : null}
      </ul>`,
      { id: `returned-${l.username}`, small: true },
    )}</td>
  </tr>`;
}

/** The week at a glance: one dense row per member; a member with nothing reads "idle". */
function weekCardPanel(lines: readonly WeekLine[], returns: ReadonlyMap<string, readonly ReturnedPull[]>): Html {
  return panel(
    html`<div class="table-scroll">
      <table class="table" id="crew-week" data-sticky-lead>
        <thead>
          <tr><th>Member</th><th class="num">Merged</th><th class="num">Returned</th><th class="num">Spent</th></tr>
        </thead>
        <tbody>
          ${lines.map((l) =>
            l.idle
              ? html`<tr data-idle>
                  <td>${userLink(l.username, { avatar: false })}</td>
                  <td colspan="3" class="muted">idle</td>
                </tr>`
              : html`<tr>
                  <td>${userLink(l.username, { avatar: false })}</td>
                  <td class="num">${l.merged}</td>
                  <td class="num">${returnedCount(l, returns.get(l.username) ?? [])}</td>
                  <td class="num">$${l.spentUsd.toFixed(2)}</td>
                </tr>
                ${returnedRow(l, returns.get(l.username) ?? [])}`,
          )}
        </tbody>
      </table>
    </div>`,
    { title: `This week · ${WEEK_DAYS} days`, id: "crew-week-card" },
  );
}

/** Today's spend against each ceiling: the drain, and the knob for it. */
function spendingCard(
  spending: readonly { repo: Repo; status: AutonomyStatus }[],
  forgeCap: number | undefined,
): Html {
  const total = spending.reduce((n, s) => n + s.status.spentTodayUsd, 0);
  const cap = spending.reduce((n, s) => n + s.status.ceilingUsd, 0);
  return panel(
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
      title: "Spending today",
      note: html`$${total.toFixed(0)} of $${cap.toFixed(0)} across ${spending.length}
          ${spending.length === 1 ? "app" : "apps"} running on their
          own${forgeCap === undefined
            ? "; no forge-wide ceiling is set (FORGE_CREW_CEILING_USD)"
            : `, under the forge's $${forgeCap.toFixed(0)} a day`};
          the ceilings reset at 00:00 UTC`,
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
    keeperDays: keeperDays(ctx.app.db, new Date()),
    wasted: wastedDays(ctx.app.db),
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

/** The weekly model review (#7815): each member's models side by side, the verdict, the button, the trail. */
function modelReviewCard(ctx: Ctx): Html {
  const r = readReview(ctx.app);
  const names = new Map(listAllAgentsByName(ctx));
  const cell = (n: number | null, f: (n: number) => string) =>
    n === null ? html`<td class="num muted">—</td>` : html`<td class="num">${f(n)}</td>`;
  const asked = r.changes.filter((c) => c.state === "asked");
  return panel(
    html`<div class="table-scroll">
        <table class="table" id="model-review">
          <thead>
            <tr><th>Agent</th><th>Model</th><th>Landed</th><th>Per landed</th><th>Red</th><th>Rework</th><th>Reverts</th><th>Hard</th></tr>
          </thead>
          <tbody>
            ${r.agents.flatMap((a) =>
              a.models.map(
                (m) => html`<tr>
                  <td>${a.username}</td>
                  <td class="mono">${m.model === "" ? "unrecorded" : m.model}</td>
                  <td class="num">${m.landed} <span class="muted small">of ${m.opened}</span></td>
                  ${cell(m.costPerLanded, (n) => `$${n.toFixed(2)}`)}
                  ${cell(m.redRate, (n) => `${Math.round(100 * n)}%`)}
                  ${cell(m.reworkRounds, (n) => n.toFixed(1))}
                  <td class="num">${m.reverts}</td>
                  ${cell(m.hardShare, (n) => `${Math.round(100 * n)}%`)}
                </tr>`,
              ),
            )}
          </tbody>
        </table>
      </div>
      <div class="table-scroll">
        <table class="table" id="model-review-verdicts">
          <thead><tr><th>Agent</th><th>Model</th><th>Verdict</th></tr></thead>
          <tbody>
            ${r.agents.map(
              (a) => html`<tr data-agent="${a.username}">
                <td>${a.username}</td>
                <td class="mono">${a.model === "" ? "default" : a.model}</td>
                <td>${a.verdict.kind === "hold"
                  ? a.verdict.note
                  : `Would move to ${a.verdict.to}. ${a.verdict.why}`}</td>
              </tr>`,
            )}
          </tbody>
        </table>
      </div>
      ${asked.length === 0
        ? null
        : html`<ul class="list" id="model-review-asks">
            ${asked.map(
              (c) => html`<li data-change="${c.id}">
                <div class="row">
                  <span class="row-main">
                    <span class="row-title">${names.get(c.agentId) ?? "an agent"}: ${c.fromModel} → ${c.toModel}</span>
                    <span class="row-meta">${c.why}</span>
                  </span>
                  <div class="row-actions">
                    <form method="post" action="/settings/crew/model-review/${c.id}/take">
                      ${btn(`Move to ${c.toModel}`, { type: "submit", size: "sm" })}
                    </form>
                    <form method="post" action="/settings/crew/model-review/${c.id}/decline">
                      ${btn("Leave it", { type: "submit", size: "sm", variant: "ghost" })}
                    </form>
                  </div>
                </div>
              </li>`,
            )}
          </ul>`}
      <div class="table-scroll">
        <table class="table" id="model-review-trail">
          <thead><tr><th>When</th><th>Agent</th><th>Change</th><th>State</th><th>Why and result</th></tr></thead>
          <tbody>
            ${r.changes.map(
              (c) => html`<tr data-change="${c.id}">
                <td>${time(c.createdAt)}</td>
                <td>${names.get(c.agentId) ?? "an agent"}</td>
                <td class="mono">${c.fromModel} → ${c.toModel}</td>
                <td>${c.state}</td>
                <td>${c.why}${c.result === "" ? "" : ` Result: ${c.result}`}</td>
              </tr>`,
            )}
          </tbody>
        </table>
      </div>`,
    {
      title: "Model review",
    },
  );
}

function listAllAgentsByName(ctx: Ctx): [string, string][] {
  const listed = listAllAgents(ctx.app, ctx.auth.user);
  return (listed.ok ? listed.value : []).map((a) => [a.user.id, a.user.username]);
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
  const { scorecards, byModel, byPrompt, byModelDay, wasted, keeperDays: forgeDays } = data.scorecards;
  const { spending } = data;
  const usernameError =
    error !== undefined && /username/i.test(error) ? error : undefined;
  const handover = crewHandover(ctx.app.db);
  const review = readReview(ctx.app);
  return html`${crewReadiness(ctx)}
  ${pageHelp([
    ["Knobs", "Dials for the crew; a change applies on the next pump."],
    ["New agent", "The username is its handle: the author on the pull requests it opens, and the first half of its branch names. The display name is shown beside it. A model alias names the newest of its line, so the choice does not age."],
    ["Scorecard", `Over the pulls each agent opened, and each team's members pooled (an agent on two teams counts in both), in the last ${RECENT_DAYS} days and over all time: review rounds are change requests per landed pull, red checks the share of finished checks that failed; reverts (the landed pulls a merged pull took back) and time to land (the mean from opening to merge) are all time.`],
    ["Model review", `At most one change of model per agent a week, to the cheapest that holds its quality. A step up always asks; a step down ${review.limits.auto ? "applies on its own" : "asks too"} (Settings → Limits). Under ${review.limits.minLanded} landed changes nothing. A week after a change the result is reported, and the change undone if quality fell. An ask nobody answers lapses after two weeks. Weekly, from the last ${review.windowDays} days of the ledger.`],
  ], helpAsked(ctx.request.url))}
  ${budgetsCard(ctx)}
  ${knobsCard(ctx)}
  ${when(spending.length > 0, () =>
    spendingCard(spending, forgeCeiling(ctx.app.config) ?? undefined),
  )}
  ${agents.length === 0
    ? html`<section class="mb" id="crew-empty">
        <h2 class="mb">No agents yet</h2>
        <p class="muted">Make one below.</p>
      </section>`
    : panel(
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
        { title: "Agents", id: "crew-agents" },
      )}
  ${when(agents.length > 0 && ctx.auth.user?.isAdmin === true, () => weekCardPanel(weekCard(ctx.app.db), weekReturns(ctx.app.db)))}
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
  ${when(agents.length > 0, () => modelReviewCard(ctx))}
  ${splitsCard(
    "Per model",
    "Model",
    byModel,
    () => html`<span class="muted">default</span>`,
  )}
  ${modelDaysCard(byModelDay)}
  ${keeperDaysCard(forgeDays)}
  ${wastedDaysCard(wasted)}
  ${splitsCard(
    "Per prompt version",
    "Prompt version",
    byPrompt,
    () => html`<span class="muted">not recorded</span>`,
  )}
  ${handedCard(handover.parked)}${drillCard(handover.drill)}
  <section class="mt" id="crew-new">
    <h2>New agent</h2>
    <form method="post" action="/settings/crew">
      ${uiField({
        label: "Username",
        name: "username",
        value: values.username,
        required: true,
        pattern: "[A-Za-z0-9][A-Za-z0-9._-]*",
        ...(usernameError ? { error: usernameError } : {}),
      })}
      ${uiField({
        label: "Display name (optional)",
        name: "displayName",
        value: values.displayName,
      })}
      ${agentFields(values, usernameError === undefined ? error : undefined)}
      <div class="form-actions">
        ${btn("Create agent", { variant: "primary", icon: "bot" })}
        ${btn("Teams", { href: "/settings/teams", variant: "ghost" })}
      </div>
    </form>
  </section>`;
}

/** Issues the crew parked twice and the planner now holds; nothing when there are none. */
function handedCard(parked: CrewHandover["parked"]): Html {
  if (parked.length === 0) return html``;
  return panel(
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
      id: "crew-handed",
      title: "Handed to the planner",
    },
  );
}

/** The last restore drill's verdict; nothing before a first drill. */
function drillCard(drill: CrewHandover["drill"]): Html {
  if (drill === undefined) return html``;
  return panel(
    html`<p>${drill.verdict === "green" ? "Passed" : "Failed"} ${time(drill.at)}.</p>`,
    {
      id: "crew-drill",
      attrs: html`data-drill="${drill.verdict}"`,
      title: "Restore drill",
    },
  );
}

/** Hours the forge ran and pulls it landed, per day of the last week (#7645). */
function keeperDaysCard(rows: readonly KeeperDay[]): Html {
  return panel(
    html`<div class="table-scroll">
      <table class="table" id="crew-keeper-days">
        <thead>
          <tr>
            <th>Day</th>
            <th>Hours running</th>
            <th>Landed</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(
            (r) => html`<tr>
              <td class="mono">${r.day}</td>
              <td class="num">${r.hoursRunning}</td>
              <td class="num">${r.landed}</td>
            </tr>`,
          )}
        </tbody>
      </table>
    </div>`,
    { title: "Forge per day" },
  );
}

/** Spend and landed pulls per model per day: the escalation, measured. */
function modelDaysCard(rows: readonly ModelDay[]): Html {
  if (rows.length === 0) return html``;
  return panel(
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
    { title: "Per model per day" },
  );
}

/** Runs that ended on work not theirs to do, per day: the pull closed, nothing pushed, already done. */
function wastedDaysCard(rows: readonly WastedDay[]): Html {
  if (rows.length === 0) return html``;
  return panel(
    html`<div class="table-scroll">
      <table class="table" id="crew-wasted-days">
        <thead>
          <tr>
            <th>Day</th>
            <th>Wasted runs</th>
            <th>Of runs</th>
            <th>Spent</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(
            (r) => html`<tr>
              <td class="mono">${r.day}</td>
              <td class="num">${r.wasted}</td>
              <td class="num">${r.runs}</td>
              <td class="num">$${r.spentUsd.toFixed(2)}</td>
            </tr>`,
          )}
        </tbody>
      </table>
    </div>`,
    { title: "Wasted runs per day" },
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
  return panel(
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
    { title },
  );
}

const EMPTY: AgentValues = {
  username: "",
  displayName: "",
  model: "",
  brief: "",
  budgetUsd: "",
  roles: ["builder"],
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
    roles: rolesOf(form),
  };
  const budgetUsd = budgetOf(form);
  const made = await createAgent(ctx.app, ctx.auth.user, {
    username: values.username,
    ...(values.displayName === "" ? {} : { displayName: values.displayName }),
    model: values.model,
    brief: values.brief,
    roles: values.roles,
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
  return html`<section class="settings-block">
      <h2>Settings</h2>
      <span class="muted small">added ${time(agent.createdAt)}</span>
      ${pageHelp([["Model", "An alias names the newest of its line, so the choice does not age."]])}
      <form method="post" action="${at}">
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
      </form>
    </section>
    <section class="settings-block">
      <h2>Retire</h2>
      <p>
        Retiring <strong>${agent.user.username}</strong> destroys its tokens and
        takes it off every crew. What it wrote stays, under its name.
      </p>
      <div class="form-actions">
        ${confirmAction({ action: `${at}/delete`, verb: "Retire this agent" })}
      </div>
    </section>`;
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
    roles: rolesOf(form),
  };
  const updated = updateAgent(ctx.app, ctx.auth.user, agent.user.username, {
    model: values.model,
    brief: values.brief,
    budgetUsd: budgetOf(form) ?? 0,
    roles: values.roles,
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

// POST /settings/crew/model-review/:id/take and /decline
export async function modelReviewDecide(ctx: Ctx, take: boolean): Promise<Response> {
  const form = await adminForm(ctx);
  if (form instanceof Response) return form;
  const done = decideChange(ctx.app, ctx.auth.user, ctx.params.id ?? "", take);
  return flashTo(ctx, "/settings/crew", {
    ...(done.ok
      ? { message: take ? `${done.value.toModel} it is.` : "Left as it was." }
      : { tone: "danger" as const, message: "That change is no longer waiting." }),
  });
}
export const modelReviewTake = (ctx: Ctx) => modelReviewDecide(ctx, true);
export const modelReviewDecline = (ctx: Ctx) => modelReviewDecide(ctx, false);
