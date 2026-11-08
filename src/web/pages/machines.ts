/**
 * GET /:owner/:name/settings/machines — the machines a repository declares
 * (`crew/machines.ts`) and its last shell sessions (`machines/shell.ts`):
 * who opened which machine, when, and when and why it ended. Writers only:
 * a session is a shell on the repository's machine, so a reader sees none.
 */

import type { Machine } from "../../crew/machines.ts";
import { canAdmin, canWrite, type Repo } from "../../core/repos.ts";
import { nameFrame, notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { repoMachines } from "../../crew/machines_read.ts";
import type { Ctx } from "../../http/context.ts";
import { ENDED, lastSessions, type SessionRecord } from "../../machines/shell.ts";
import { crumbsFor, forbiddenPage, loadRepo, repoHeader, repoNotFound, repoPalette, NOT_YOURS_TO_DO } from "../chrome.ts";
import { page } from "../layout.ts";
import { html } from "../html.ts";
import { card, icon, time } from "../ui.ts";
import { settingsPageResponse } from "./settings.ts";


export async function machinesSettingsPage(ctx: Ctx): Promise<Response> {
  nameFrame(ctx.request);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = timePhase(ctx.request, "repo", () => loadRepo(ctx));
  if (!repo) return repoNotFound(ctx);
  if (!canWrite(ctx.app.db, repo, ctx.auth.user)) return forbiddenPage(ctx, NOT_YOURS_TO_DO);
  const config = await timePhaseAsync(ctx.request, "machines", () => repoMachines(ctx.app, repo));
  const sessions = timePhase(ctx.request, "sessions", () => lastSessions(ctx.app.db, repo.id));
  return timePhase(ctx.request, "render", () => render(ctx, repo, config.machines, sessions));
}

function render(ctx: Ctx, repo: Repo, list: readonly Machine[], sessions: readonly SessionRecord[]): Response {
  const machines = card(
    html`<p class="muted">
        A machine is where the crew's shell runs. A writer can open a shell into one; each
        writer has a directory and home of their own on each machine, never shared with the
        next. The browser terminal that opens it is not built yet.
      </p>
      <div class="table-scroll">
        <table class="table">
          <thead><tr><th>Machine</th><th>Tools</th><th>Reach</th></tr></thead>
          <tbody>
            ${list.map(
              (m) => html`<tr>
                <td><strong>${m.name}</strong></td>
                <td class="muted">${m.tools.length === 0 ? "none" : m.tools.join(", ")}</td>
                <td class="muted">${m.reach.length === 0 ? "the forge only" : "the forge and its apps"}</td>
              </tr>`,
            )}
          </tbody>
        </table>
      </div>`,
    { head: html`${icon("terminal")}<h2>Machines</h2>` },
  );
  const recent = card(
    sessions.length === 0
      ? html`<p class="muted">No shell has been opened here yet.</p>`
      : html`<div class="table-scroll">
          <table class="table">
            <thead><tr><th>Machine</th><th>Who</th><th>Started</th><th>Ended</th></tr></thead>
            <tbody>
              ${sessions.map(
                (s) => html`<tr>
                  <td><strong>${s.machine}</strong></td>
                  <td>${s.ownerName}</td>
                  <td class="muted">${time(s.startedAt)}</td>
                  <td class="muted">${s.endedAt === undefined
                    ? "running"
                    : html`${time(s.endedAt)} · ${ENDED[s.endReason ?? "stopped"]}`}</td>
                </tr>`,
              )}
            </tbody>
          </table>
        </div>`,
    { head: html`${icon("history")}<h2>Last sessions</h2>` },
  );
  const body = html`${machines}<div class="mt">${recent}</div>`;
  // The settings frame and its sections are an admin's; a writer who is not
  // one sees this pane alone, so no link offers them a page that refuses.
  if (canAdmin(ctx.app.db, repo, ctx.auth.user))
    return settingsPageResponse(ctx, repo, "machines", "Machines", body);
  return page({
    ctx,
    title: `Machines · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body: html`${repoHeader(ctx, repo, "settings", { compact: true })}${body}`,
  });
}
