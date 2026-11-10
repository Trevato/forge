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
import { badge, btn, icon, row, time } from "../ui.ts";
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

/** One data-nav link per machine, to its shell; none when there are no machines. */
export function machineRows(repo: Repo, list: readonly Machine[]) {
  return html`${list.map((m) =>
    row({
      lead: icon("terminal"),
      title: m.name,
      meta: html`Tools: ${m.tools.length === 0 ? "none" : m.tools.join(", ")} · Reach: ${m.reach.length === 0 ? "the forge only" : "the forge and its apps"}`,
      href: shellPath(repo, m.name),
      nav: true,
      data: { machine: m.name },
    }),
  )}`;
}

function render(ctx: Ctx, repo: Repo, list: readonly Machine[], sessions: readonly SessionRecord[]): Response {
  const machines = html`<section class="settings-block">
    <h2>Machines</h2>
    <p class="muted">A machine is where the crew shell runs; each writer gets a directory and home of their own on it.</p>
    <ul class="list setting-list" id="machines">
      ${machineRows(repo, list)}
    </ul>
  </section>`;
  // The mark is not colour alone: a running shell carries the word in a badge,
  // an ended one says why in words and a dash.
  const recent = html`<section class="settings-block">
    <h2>Last sessions</h2>
    ${sessions.length === 0
      ? html`<p class="small">No shell has been opened here yet.</p>`
      : html`<ul class="list setting-list" id="machine-sessions">
          ${sessions.map((s) =>
            row({
              lead: html`<span aria-hidden="true">${s.endedAt === undefined ? "●" : "–"}</span>`,
              title: html`${s.machine} · ${s.ownerName}`,
              meta: html`Started ${time(s.startedAt)}${s.endedAt === undefined
                ? null
                : html` · ended ${time(s.endedAt)} · ${ENDED[s.endReason ?? "stopped"]}`}`,
              ...(s.endedAt === undefined ? { trail: badge("running", { tone: "success" }) } : {}),
              data: { session: s.id },
            }),
          )}
        </ul>`}
  </section>`;
  const body = html`${machines}${recent}`;
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
