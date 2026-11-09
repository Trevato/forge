/**
 * Crew teams, for a forge admin (`core/teams.ts`): each team's charter, its
 * dial and who is on it, set on one page linked from the crew page. Anyone
 * else gets the not-found page, before a body is read.
 */

import { changeTeam, readTeamQueue, readTeams, teamChanges, TEAM_SAYS } from "../../actions/teams.ts";
import { CHARTER_MAX, DIAL_MAX } from "../../core/teams.ts";
import { timeAgo } from "../ui.ts";
import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { notFoundPage, settingsLayout } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { eventStream } from "../../http/sse.ts";
import { html, raw, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, icon } from "../ui.ts";
import { accountSections } from "./origins.ts";

const isAdminPerson = (ctx: Ctx): boolean =>
  ctx.auth.user?.isAdmin === true && ctx.auth.user.kind !== "agent";

/** The page's three regions, as HTML text: what the first paint and the stream both send. */
function regions(ctx: Ctx, timed = false): Record<string, string> | undefined {
  const phase = <T>(name: string, work: () => T): T =>
    timed ? timePhase(ctx.request, name, work) : work();
  const read = phase("teams", () => readTeams(ctx.app, ctx.auth.user));
  if (!read.ok) return undefined;
  const { teams, agents } = read.value;
  const changes = phase("changes", () => teamChanges(ctx.app, 10));
  const total = teams.reduce((n, t) => n + t.dial, 0);
  const queues = phase("queue", () =>
    new Map(teams.map((t) => {
      const q = readTeamQueue(ctx.app, ctx.auth.user, t.slug);
      return [t.slug, q.ok ? q.value : []] as const;
    })),
  );
  const cards = teams.map((t) => {
    const waiting = queues.get(t.slug) ?? [];
    return html`<section>
      <h2>${icon("bot")} ${t.name}</h2>
      ${waiting.length === 0
        ? html`<p class="muted small">Nothing is waiting on this team.</p>`
        : html`<p class="muted small">Waiting on this team, oldest first</p>
          <dl class="status-rows">${waiting.map(
            (w) => html`<div class="status-row">
              <dt><a href="/${w.owner}/${w.repo}/pulls/${String(w.number)}">${w.owner}/${w.repo} #${String(w.number)}</a></dt>
              <dd>${w.title} <span class="muted">${timeAgo(w.createdAt)}</span></dd>
            </div>`,
          )}</dl>`}
      <form method="post" action="/settings/teams/${t.slug}">
        <div class="field">
          <label for="charter-${t.slug}">Charter</label>
          <textarea class="input" id="charter-${t.slug}" name="charter" rows="3" maxlength="${String(CHARTER_MAX)}">${t.charter}</textarea>
          <span class="hint">What it owns, what it reviews.</span>
        </div>
        <div class="field">
          <label for="dial-${t.slug}">Dial (%)</label>
          <input class="input mono" id="dial-${t.slug}" type="number" name="dial" min="0" max="${String(DIAL_MAX)}" step="1" value="${String(t.dial)}" />
          <span class="hint">Its share of builder slots and budget.</span>
        </div>
        <fieldset class="field">
          <legend>Members</legend>
          ${agents.length === 0
            ? html`<span class="muted small">No agents yet.</span>`
            : agents.map(
                (a) => html`<label class="small">
                  <input type="checkbox" name="member" value="${a.user.id}" ${t.members.includes(a.user.id) ? "checked" : ""} />
                  ${a.user.username}
                  <span class="muted mono">${a.model === "" ? "default" : a.model}</span>
                </label><br />`,
              )}
        </fieldset>
        <div class="form-actions">
          ${btn("Save", { variant: "primary", label: `Save ${t.name}` })}
        </div>
      </form>
    </section>`;
  });
  const out: Record<string, Html> = {
    "teams-total": html`${String(total)}%`,
    "teams-cards": html`${cards}`,
    "teams-changes":
      changes.length === 0
        ? html``
        : html`<section>
            <h2>Recent changes</h2>
            <ul class="small">${changes.map(
              (c) => html`<li><span class="mono">${c.at.slice(0, 16)}</span> ${c.slug}: ${c.from} → ${c.to} <span class="muted">${c.actorName}</span></li>`,
            )}</ul>
          </section>`,
  };
  return Object.fromEntries(Object.entries(out).map(([k, h]) => [k, h.text]));
}

/**
 * The client: one EventSource; a pushed region replaces the element of its
 * id. The cards are left alone while one of their fields has focus, so a
 * viewer's half-typed edit is never lost. Our own server's escaped markup.
 */
export const teamsLiveJs = /* js */ `
(function () {
  if (typeof EventSource === 'undefined') return;
  var es = new EventSource('/settings/teams/stream');
  es.addEventListener('teams', function (e) {
    var data;
    try { data = JSON.parse(e.data); } catch (_) { return; }
    var regions = data && data.regions;
    if (!regions) return;
    for (var id in regions) {
      var el = document.getElementById(id);
      if (!el || el.innerHTML === regions[id]) continue;
      if (id === 'teams-cards' && el.contains(document.activeElement)) continue;
      el.innerHTML = regions[id];
    }
  });
})();
`;

// GET /settings/teams/stream: the page's regions again, each time a team changes.
export function teamsStream(ctx: Ctx): Response {
  if (!isAdminPerson(ctx)) return notFoundPage(ctx);
  return eventStream(ctx.app, ctx.request, (emit, _close, ready) => {
    const send = () => {
      const r = regions(ctx);
      if (r && ready()) emit("teams", { regions: r });
    };
    return ctx.app.bus.subscribe((event) => {
      if (event.kind === "team.changed") send();
    });
  });
}

// GET /settings/teams
export function teamsPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const r = regions(ctx, true);
  if (!r) return notFoundPage(ctx);
  const rendering = performance.now();
  const at = (id: string): Html => raw(r[id]!);
  const out = page({
    ctx,
    title: "Teams",
    scriptJs: teamsLiveJs,
    body: html`<div class="page-head"><h1>Teams</h1></div>
      ${settingsLayout(
        accountSections("crew", { admin: true }),
        html`<p class="muted small">
            A team is a named group of agents with a charter and a dial: its
            share of builder slots and budget. The dials together may not pass
            ${String(DIAL_MAX)}%; now <span class="mono" id="teams-total">${at("teams-total")}</span>.
            An agent can be on more than one team. ${btn("Back to the crew", { href: "/settings/crew", variant: "ghost" })}
          </p>
          <div id="teams-cards">${at("teams-cards")}</div>
          <div id="teams-changes">${at("teams-changes")}</div>`,
        "Account settings",
      )}`,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return out;
}

// POST /settings/teams/:slug
export async function teamSet(ctx: Ctx): Promise<Response> {
  // Checked before the body is read: a non-admin learns nothing of the door.
  if (!isAdminPerson(ctx)) return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const slug = ctx.params.slug ?? "";
  const changed = changeTeam(ctx.app, ctx.auth.user, slug, {
    charter: field(form, "charter").replace(/\r\n/g, "\n").trim(),
    dial: field(form, "dial"),
    members: form.getAll("member").filter((v): v is string => typeof v === "string"),
  });
  if (!changed.ok && changed.error === "not_found") return notFoundPage(ctx);
  return flashTo(
    ctx,
    "/settings/teams",
    changed.ok
      ? { message: `${changed.value.name} saved at ${changed.value.dial}%.` }
      : { tone: "danger", message: TEAM_SAYS[changed.error] },
  );
}
