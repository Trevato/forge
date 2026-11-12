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
import { ENDED, lastSessions, machineStates, stateLine, type MachineState, type SessionRecord } from "../../machines/shell.ts";
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
import { readMachine } from "../../actions/disk_readings.ts";
import { WEAR_ALERT_PERCENT } from "../../machines/disk_health.ts";
import type { DeviceSummary } from "../../machines/disk_readings.ts";
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
  const states = machineStates(ctx.app, repo.id, ctx.auth.user!.id);
  // Readings are the host's, keyed by machine name alone, so they are shown
  // to the owner (`mayHandleDisks`) and to no other writer: a name two
  // repositories share must not carry one repository's disks to the other.
  const disks = timePhase(ctx.request, "disks", () => {
    const seen = new Map<string, readonly DeviceSummary[]>();
    for (const m of config.machines) {
      const r = readMachine(ctx.app, ctx.auth.user, m.name);
      if (r.ok) seen.set(m.name, r.value.devices);
    }
    return seen;
  });
  return timePhase(ctx.request, "render", () => render(ctx, repo, config.machines, sessions, states, disks));
}

/** Terabytes as vendors state them (1 TB = 10^12 bytes), to two places. */
const tb = (bytes: number): string => (bytes / 1e12).toFixed(2);

/**
 * One disk, a `row()` under its machine's row: device and model as the title,
 * written of rated TBW with its percentage and the temperature as the meta
 * (each wraps on its own in a `.setting-list`, so 360px never scrolls
 * sideways). The row folds open to every figure beside its rating. An alert
 * adds a badge, and its reasons in words on a muted line in the row's `after`
 * slot, outside the `<details>`, so they read with the line closed; nothing
 * else changes colour.
 */
export function diskRow(machine: string, d: DeviceSummary) {
  if (d.kind === "behind-controller")
    return row({ title: d.device, meta: html`behind a controller; SMART not visible`, data: { disk: d.device } });
  const r = d.reading;
  const spec = d.spec;
  const written = spec
    ? `${tb(r.bytesWritten)} of ${spec.ratedTbw} TBW (${((r.bytesWritten / (spec.ratedTbw * 1e12)) * 100).toFixed(1)}%)`
    : `${tb(r.bytesWritten)} TB written · no spec sheet`;
  const alert = d.assessment.level === "alert";
  const rated = (v: string, r2: string | undefined) => (r2 === undefined ? html`${v} <span class="muted">(no spec sheet)</span>` : html`${v} <span class="muted">(rated ${r2})</span>`);
  const figures: [string, ReturnType<typeof html>][] = [
    ["Percentage used", html`${r.percentageUsed}% <span class="muted">(alert at ${WEAR_ALERT_PERCENT}%)</span>`],
    ["Available spare", html`${r.availableSpare}% <span class="muted">(threshold ${r.spareThreshold}%)</span>`],
    ["Media errors", html`${r.mediaErrors}`],
    ["Minutes above warning", rated(`${r.warnTempMinutes}`, spec ? `warning ${spec.warnTempC} °C` : undefined)],
    ["Minutes above critical", rated(`${r.critTempMinutes}`, spec ? `critical ${spec.critTempC} °C` : undefined)],
    ["Power-on hours", html`${r.powerOnHours}`],
    ["Unsafe shutdowns", html`${r.unsafeShutdowns}`],
    ["Written", rated(`${tb(r.bytesWritten)} TB`, spec ? `${spec.ratedTbw} TBW, ${spec.warrantyYears}-year warranty` : undefined)],
    ["Projected TBW date", html`${d.ratedReachedAt ?? (spec ? "no projection yet" : "no spec sheet")}`],
  ];
  return row({
    lead: icon("chevronRight"),
    title: `${d.device} · ${r.model}`,
    meta: html`${written} · ${r.temperatureC} °C`,
    ...(alert ? { trail: badge("needs a look", { tone: "attn" }) } : {}),
    // The body's id is a link to the line open: a fragment that names
    // something inside a closed <details> opens it (HTML's ancestor-details
    // revealing), so `#disk-<machine>-<device>-figures` shares it opened.
    fold: {
      id: `disk-${machine}-${d.device}`,
      open: false,
      body: html`<div class="card-body" id="disk-${machine}-${d.device}-figures"><dl class="row-facts" data-disk-figures>${figures.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl></div>`,
    },
    ...(alert ? { after: html`<p class="muted small" data-disk-reasons>${d.assessment.reasons.join("; ")}</p>` } : {}),
    data: { disk: d.device },
  });
}

/** A machine's disk rows, or one line saying there is no reading yet; nothing when its disks are not this person's to see. */
function diskChildren(name: string, devices: readonly DeviceSummary[] | undefined) {
  if (devices === undefined) return undefined;
  if (devices.length === 0) return [row({ title: html`<span class="muted">No disk reading yet.</span>`, data: { "disks-empty": name } })];
  return devices.map((d) => diskRow(name, d));
}

/** The state line as muted text in a row's meta, which wraps; nothing when no shell is live. */
function stateMeta(state: MachineState | undefined) {
  const line = stateLine(state);
  if (state === undefined || line === undefined) return html``;
  return html` · <span class="muted" data-shell-state="${state.attached ? "attached" : "detached"}">${line}</span>`;
}

/** One data-nav link per machine, to its shell; none when there are no machines. */
export function machineRows(
  repo: Repo,
  list: readonly Machine[],
  states: ReadonlyMap<string, MachineState> = new Map(),
  disks: ReadonlyMap<string, readonly DeviceSummary[]> = new Map(),
) {
  return html`${list.map((m) => {
    const children = diskChildren(m.name, disks.get(m.name));
    return row({
      lead: icon("terminal"),
      title: m.name,
      meta: html`Tools: ${m.tools.length === 0 ? "none" : m.tools.join(", ")} · Reach: ${m.reach.length === 0 ? "the forge only" : "the forge and its apps"}${stateMeta(states.get(m.name))}`,
      href: shellPath(repo, m.name),
      nav: true,
      data: { machine: m.name },
      ...(children === undefined ? {} : { children }),
    });
  })}`;
}

function render(ctx: Ctx, repo: Repo, list: readonly Machine[], sessions: readonly SessionRecord[], states: ReadonlyMap<string, MachineState>, disks: ReadonlyMap<string, readonly DeviceSummary[]>): Response {
  const machines = html`<section class="settings-block">
    <h2>Machines</h2>
    <ul class="list setting-list" id="machines">
      ${machineRows(repo, list, states, disks)}
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
