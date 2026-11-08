/**
 * GET /:owner/:name/settings/machines — the machines a repository declares
 * (`crew/machines.ts`), each with "Open shell", and its last shell sessions
 * (`machines/shell.ts`): who opened which machine, when, and when and why it
 * ended. Writers only: a session is a shell on the repository's machine, so a
 * reader sees none.
 *
 * GET /:owner/:name/machines/:machine/shell — the shell itself: a terminal in
 * the browser (ghostty-web, `web/machine-term-client.ts`) on the WebSocket at
 * the same path (an upgrade there is answered by `machines/shell.ts` before
 * any route). Writers only, as the socket is. A reload joins the same tmux
 * session. The one page whose CSP admits WebAssembly (`'wasm-unsafe-eval'`).
 */

import type { Machine } from "../../crew/machines.ts";
import { canAdmin, canWrite, type Repo } from "../../core/repos.ts";
import { nameFrame, notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { repoMachines } from "../../crew/machines_read.ts";
import type { Ctx } from "../../http/context.ts";
import { ENDED, lastSessions, type SessionRecord } from "../../machines/shell.ts";
import {
  crumbsFor,
  forbiddenPage,
  loadRepo,
  notFoundPage,
  pageHead,
  repoHeader,
  repoNotFound,
  repoPalette,
  NOT_YOURS_TO_DO,
} from "../chrome.ts";
import { page } from "../layout.ts";
import { html } from "../html.ts";
import { btn, card, icon, time } from "../ui.ts";
import { ghosttyWasmAsset, machineTermAsset } from "../machine-term-asset.ts";
import { settingsPageResponse } from "./settings.ts";

/** The shell page's own rules: a terminal box that fills the window below the head and never moves. */
// --machine-term-above is everything over the box: the site bar (48), the
// compact repository header (88), the page head with its sub line (96), the
// status line with its margins (40), and the page's top and bottom padding
// (28). Padding and margins are the 4px scale's 8 (DESIGN §4).
export const MACHINE_SHELL_CSS = /* css */ `
.machine-term { --machine-term-above: 300px; height: calc(100dvh - var(--machine-term-above)); min-height: 320px; padding: 8px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg); overflow: hidden; }
.machine-term-status { min-height: 1.5em; margin: 8px 0; color: var(--muted-fg); }
`;

/** Where a machine's shell page (and its socket) lives. */
export function shellPath(repo: Repo, machine: string): string {
  return `/${repo.ownerName}/${repo.name}/machines/${machine}/shell`;
}

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
        next. A shell outlives its tab: reload, or open it again, and you are back in it.
      </p>
      <div class="table-scroll">
        <table class="table">
          <thead><tr><th>Machine</th><th>Tools</th><th>Reach</th><th><span class="sr-only">Shell</span></th></tr></thead>
          <tbody>
            ${list.map(
              (m) => html`<tr>
                <td><strong>${m.name}</strong></td>
                <td class="muted">${m.tools.length === 0 ? "none" : m.tools.join(", ")}</td>
                <td class="muted">${m.reach.length === 0 ? "the forge only" : "the forge and its apps"}</td>
                <td>${btn("Open shell", { href: shellPath(repo, m.name), icon: "terminal", size: "sm" })}</td>
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

export async function machineShellPage(ctx: Ctx): Promise<Response> {
  nameFrame(ctx.request);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = timePhase(ctx.request, "repo", () => loadRepo(ctx));
  if (!repo) return repoNotFound(ctx);
  if (!canWrite(ctx.app.db, repo, ctx.auth.user)) return forbiddenPage(ctx, NOT_YOURS_TO_DO);
  const config = await timePhaseAsync(ctx.request, "machines", () => repoMachines(ctx.app, repo));
  const machine = config.machines.find((m) => m.name === ctx.params.machine);
  if (machine === undefined) return notFoundPage(ctx);
  const script = await timePhaseAsync(ctx.request, "asset", () => machineTermAsset());
  return timePhase(ctx.request, "render", () => renderShell(ctx, repo, machine, script?.path));
}

function renderShell(ctx: Ctx, repo: Repo, machine: Machine, script: string | undefined): Response {
  const base = `/${repo.ownerName}/${repo.name}`;
  const term =
    script === undefined
      ? html`<p class="muted" role="status">The terminal could not load on this forge.</p>`
      : html`<p id="machine-term-status" class="machine-term-status" role="status" aria-live="polite"></p>
          <noscript><p class="machine-term-status">This shell runs in the browser and needs JavaScript; with it off, nothing connects.</p></noscript>
          <div id="machine-term" class="machine-term" data-wasm="${ghosttyWasmAsset().path}"></div>`;
  return page({
    ctx,
    title: `Shell · ${machine.name} · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    wide: true,
    styleCss: MACHINE_SHELL_CSS,
    ...(script === undefined ? {} : { scriptAsset: script, wasm: true }),
    body: html`${repoHeader(ctx, repo, "settings", { compact: true })}
      ${pageHead(html`${icon("terminal")}Shell on ${machine.name}`, {
        sub: machine.tools.length === 0 ? "No tools beyond the shell." : `Tools: ${machine.tools.join(", ")}.`,
        actions: btn("All machines", { href: `${base}/settings/machines`, size: "sm" }),
      })}
      ${term}`,
  });
}
