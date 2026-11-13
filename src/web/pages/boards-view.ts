/**
 * Boards, drawn: `/boards` lists them and makes one, `/boards/:slug` is the
 * grid with each panel's chart and, under it, the panels' management (edit,
 * move, remove) and the board's own (rename, range, live, duplicate,
 * delete). The grid is a live region with an address of its own
 * (`/boards/:slug/live`): a board that is live is refetched, by the same
 * swap the wall uses, when a run, pull, check, issue or usage event arrives.
 * No client framework. Every form posts to `boards-edit.ts`. Anyone but a
 * person who is an admin gets the not-found page.
 */
import { CHART_NAMES } from "../../boards/chart.ts";
import { isSlug, MAX_H, MAX_PANELS, MAX_TITLE, MAX_W, RANGES, type Board, type Panel } from "../../boards/store.ts";
import type { App } from "../../app.ts";
import type { Ctx } from "../../http/context.ts";
import { driftSection } from "./boards-drift.ts";
import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { liveRegionsJs } from "../client.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { html, when, type Html } from "../html.ts";
import { fragment, page } from "../layout.ts";
import { btn, chartFrame, confirmAction, field, selectField } from "../ui.ts";
import { fold, reading, readingFailed, readingJs } from "../figure.ts";
import { formatValue } from "../../boards/chart.ts";
import { flowPanel, outAsked } from "./flow-panel.ts";
import { boardsHoldsCard } from "./boards-holds.ts";
import { alarmLines } from "../studio/alarm_lines.ts";
import { boardPicture, boardsPicture, isFailed, LONG_WAIT_MS, waitAnswer } from "../../flow/pages.ts";
import { isPinned, listPins } from "../../boards/pins.ts";
import { drawnPanel, panelData, runFor, type PanelDrawn } from "../../boards/panel_data.ts";
import { readParams } from "../../boards/params.ts";
import { paramsOf, queryFields } from "./boards.ts";

/** The events the panels' queries read (runs, pulls, checks, issues, usage): any of them may change a chart. */
const READS = "run.queued,run.started,run.finished,pull.*,check.*,issue.*,usage.*";

const sizes = (max: number, word: string, now: number) =>
  [1, 2, 3].slice(0, max).map((n) => ({ value: String(n), label: `${String(n)} ${word}`, selected: n === now }));

/** Where a panel lives: its board's slug and its place on it, which name its data door. */
export type PanelAt = { slug: string; index: number };

export function drawPanel(
  app: App,
  board: Board,
  panel: Panel,
  at: PanelAt,
  aside: Html | null = null,
  run: typeof runFor = runFor,
  /** The panel as a worker read and drew it (`flow/pages.ts`); without it the rows are read and drawn here, for a direct caller. */
  drawn: PanelDrawn = drawnPanel(panel, panelData(app.db, board, panel, {}, Date.now(), run)),
): Html {
  const q = paramsOf(panel.query, panel.chart);
  const body = !drawn.ok ? html`<p class="muted small">${drawn.error}</p>` : chartFrame(panel.chart, drawn.chart);
  const latest = drawn.ok ? drawn.latest : null;
  const explore = new URLSearchParams(Object.entries(q).filter(([k, v]) => v !== "" && k !== "rows"));
  const data = `/api/v1/boards/${at.slug}/panels/${String(at.index)}`;
  return html`<div class="card bp bp-w${String(panel.w)} bp-h${String(panel.h)}">
    <div class="bp-head"><h2>${panel.title}</h2>
      ${latest === null ? null : html`<span class="bp-now"><span class="num">${formatValue(latest)}</span> latest</span>`}</div>
    <div class="bp-body">${body}</div>
    <p class="bp-foot card-links"><a href="/boards/data?${explore.toString()}" aria-label="${panel.title}: explore">Explore</a>
        <a href="${data}" aria-label="${panel.title}: data as JSON">JSON</a>
        <a href="${data}?format=csv" download="${at.slug}-${String(at.index)}.csv" aria-label="${panel.title}: data as CSV">CSV</a></p>
    ${aside}
  </div>`;
}

/** The grid alone: what the page shows and what the live address answers with. */
function grid(app: App, slug: string, board: Board, panels: readonly PanelDrawn[]): Html {
  return html`<section
    class="bgrid"
    id="board-grid"
    ${board.refresh === "off"
      ? null
      : html`data-live="${READS}" data-live-src="/boards/${slug}/live"`}
  >
    ${board.panels.length === 0
      ? html`<p class="muted bp-w3">This board has no panel yet. Add the first one under "Add a panel" below, or pin a chart from <a href="/boards/data">Explore the data</a>.</p>`
      : board.panels.map((p, index) => drawPanel(app, board, p, { slug, index }, null, runFor, panels[index]))}
  </section>`;
}

const denied = (ctx: Ctx) => {
  const u = ctx.auth.user;
  return u?.isAdmin !== true || u.kind === "agent";
};

/**
 * Start reading `/boards`' picture now and draw the panel once from it, so the
 * first person to open the page after a restart finds both the picture and a
 * warm renderer: the forge calls this once it is listening (never `bun test`,
 * where the picture is read inline).
 */
export function warmBoards(app: App): void {
  if (process.env["NODE_ENV"] === "test") return;
  void boardsPicture(app, "owner", null, LONG_WAIT_MS)
    .then((picture) => {
      if (picture !== undefined && !isFailed(picture)) flowPanel(app, { kind: "owner" }, new URL("http://forge/boards"), "/boards", { picture });
    })
    .catch(() => {});
}

// GET /boards
export async function boardsList(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const user = ctx.auth.user;
  if (user === undefined) return signInFirst(ctx);
  if (denied(ctx)) {
    // Not a forge admin: the page is the holds of the repositories they administer, or not found.
    const holds = boardsHoldsCard(ctx.app.db, user);
    if (holds === null) return notFoundPage(ctx);
    return page({ ctx, title: "Boards", body: html`<div class="page-head"><h1>Boards</h1></div>${holds}` });
  }
  // What a "Reading…" page asks: it answers when the worker has the picture, and draws nothing.
  if (ctx.url.searchParams.has("wait")) {
    return waitAnswer(await boardsPicture(ctx.app, "owner", outAsked(ctx.url), LONG_WAIT_MS));
  }
  // The page's picture is read by a worker and kept: nothing here walks the pulls, the runs or git.
  const picture = await timePhaseAsync(ctx.request, "picture", () => boardsPicture(ctx.app, "owner", outAsked(ctx.url)));
  if (picture === undefined || isFailed(picture)) {
    const again = `/boards${ctx.url.search}`;
    return page({
      ctx,
      title: "Boards",
      wide: true,
      body: html`<div class="hf bd"><header class="hf-head"><div class="hf-title"><h1>Boards</h1></div></header>
        <section class="bd-now">${picture === undefined ? reading("Reading how work is moving through the forge…", `/boards${ctx.url.search === "" ? "?" : `${ctx.url.search}&`}wait=1`, again) : readingFailed(picture.failed, again)}</section></div>`,
      ...(picture === undefined ? { scriptJs: readingJs } : {}),
    });
  }
  const listed = { value: picture.boards };
  const boards = html`<section class="bd-block" id="boards-all" aria-labelledby="boards-all-h">
    <header class="bd-head"><h2 id="boards-all-h">Your boards</h2><p class="bd-sub">A board is a page of charts over the forge's own numbers, saved as a file in forge/boards.</p></header>
    ${listed.value.length === 0
      ? html`<p class="muted">No board yet. Make one below, or start from a question on <a href="/boards/data">Explore the data</a>.</p>`
      : html`<ul class="bd-boards">
          ${listed.value.map(
            ({ slug, board }) => html`<li class="tile"><a href="/boards/${slug}" class="tile-link" data-nav tabindex="-1">
              <span class="tile-top"><span class="tile-app">${board.title}</span><span class="tile-clock">${String(board.panels.length)} ${board.panels.length === 1 ? "chart" : "charts"}</span></span>
              <span class="tile-hint">${RANGE_WORDS[board.range]}${board.refresh === "off" ? "" : ", redrawn as things happen"}</span>
            </a></li>`,
          )}
        </ul>`}
    <details class="disclosure" id="boards-new"><summary>Make a board</summary>
      <form method="post" action="/boards/new" class="bar">
        ${field({ label: "New board", name: "title", id: "new-board-title", required: true, maxlength: MAX_TITLE, placeholder: "Title" })}
        ${btn("Make board", { variant: "primary" })}
      </form></details>
  </section>`;
  const drift = driftSection(picture.drifting ?? []);
  const flow = timePhase(ctx.request, "flow", () =>
    flowPanel(ctx.app, { kind: "owner" }, ctx.url, "/boards", { picture, now: alarmLines(picture.alarms), between: boards, first: drift, last: boardsHoldsCard(ctx.app.db, user, true) }));
  const rendering = performance.now();
  const response = page({
    ctx,
    title: "Boards",
    wide: true,
    body: html`<div class="hf bd">
      <header class="hf-head">
        <div class="hf-title"><h1>Boards</h1><p class="hf-live muted">How work is moving through the forge right now, and the charts behind it.</p></div>
        <nav class="bd-nav" aria-label="Deeper">${btn("Flow", { href: "/flow", variant: "ghost" })}${btn("Explore the data", { href: "/boards/data", variant: "ghost" })}</nav>
      </header>
      ${flow}
    </div>`,
    scriptJs: liveRegionsJs,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

/** A board's range as words. */
const RANGE_WORDS: Readonly<Record<Board["range"], string>> = { "1h": "The last hour", "24h": "The last 24 hours", "7d": "The last 7 days", "30d": "The last 30 days", all: "All of time" };

function panelForm(slug: string, op: string, p: Panel | undefined, index: number, fields: Html): Html {
  const id = op === "edit" ? `panel-${String(index)}` : "panel-new";
  return html`<form method="post" action="/boards/${slug}/${op}" class="bd-query">
    ${op === "edit" ? html`<input type="hidden" name="index" value="${String(index)}" />` : null}
    ${field({ label: "Panel title", name: "title", id: `${id}-title`, required: true, maxlength: MAX_TITLE, value: p?.title ?? "", placeholder: "Panel title" })}
    ${selectField({ label: "Width", name: "w", id: `${id}-w`, options: sizes(MAX_W, "wide", p?.w ?? 1) })}
    ${selectField({ label: "Height", name: "h", id: `${id}-h`, options: sizes(MAX_H, "high", p?.h ?? 1) })}
    ${fields}
    ${btn(op === "edit" ? "Save panel" : "Add panel", { variant: "primary" })}
  </form>`;
}

/** Pin to home / Unpin: one same-origin POST, back to this board. */
function pinForm(slug: string, title: string, pinned: boolean): Html {
  const verb = pinned ? "Unpin" : "Pin to home";
  return html`<form method="post" action="/boards/${pinned ? "unpin-panel" : "pin-panel"}" class="row-actions">
    <input type="hidden" name="slug" value="${slug}" /><input type="hidden" name="title" value="${title}" />
    <input type="hidden" name="back" value="/boards/${slug}" />
    ${btn(verb, { size: "sm", label: `${verb}: ${title}` })}
  </form>`;
}

function manage(slug: string, board: Board, adding: Html, pins: ReturnType<typeof listPins>): Html {
  const one = (p: Panel, i: number) => html`<li class="row">
    <details class="row-main">
      <summary><strong class="break">${p.title}</strong> <span class="muted small">${CHART_NAMES[p.chart]} · ${String(p.w)}×${String(p.h)}</span></summary>
      ${panelForm(slug, "edit", p, i, queryFields(paramsOf(p.query, p.chart)))}
    </details>
    <div class="row-trail bar">
      ${pinForm(slug, p.title, isPinned(pins, slug, p.title))}
      <form method="post" action="/boards/${slug}/move" class="row-actions">
        <input type="hidden" name="index" value="${String(i)}" />
        ${btn("Up", { size: "sm", name: "by", value: "-1", label: `Move ${p.title} up` })}
        ${btn("Down", { size: "sm", name: "by", value: "1", label: `Move ${p.title} down` })}
      </form>
      ${confirmAction({ action: `/boards/${slug}/remove?index=${String(i)}&title=${encodeURIComponent(p.title)}`, verb: "Remove", size: "sm", label: `Remove ${p.title}` })}
    </div>
  </li>`;
  const n = board.panels.length;
  return html`<section class="bd-block" id="board-edit" aria-labelledby="board-edit-h">
    <header class="bd-head"><h2 id="board-edit-h">Change this board</h2><p class="bd-sub">It is saved as a file in forge/boards, so every change is a commit.</p></header>
    <div class="folds">
    ${n === 0 ? null : fold("Panels", `${String(n)} ${n === 1 ? "panel" : "panels"}: edit, move, pin to home or remove`, html`<ul class="list setting-list">${board.panels.map(one)}</ul>`, { id: "board-panels" })}
    ${when(
      n < MAX_PANELS,
      () => fold("Add a panel", `room for ${String(MAX_PANELS - n)} more`, panelForm(slug, "add", undefined, 0, adding), { id: "board-add", open: n === 0 }),
    )}
    ${fold("Board", `${RANGE_WORDS[board.range].toLowerCase()}, ${board.refresh === "off" ? "not redrawn until reloaded" : "redrawn as things happen"}`, html`
      <div class="bar"><form method="post" action="/boards/${slug}/rename" class="bar">
          ${field({ label: "Board title", name: "title", id: "board-title", required: true, maxlength: MAX_TITLE, value: board.title })}
          ${btn("Rename")}
        </form>
        <form method="post" action="/boards/${slug}/settings" class="bar">
          ${selectField({ label: "Range", name: "range", id: "board-range", options: RANGES.map((r) => ({ value: r, label: r, selected: r === board.range })) })}
          ${selectField({ label: "Live", name: "refresh", id: "board-refresh", options: [
            { value: "off", label: "off", selected: board.refresh === "off" },
            { value: "10s", label: "on: redraw when events arrive", selected: board.refresh !== "off" },
          ] })}
          ${btn("Save settings")}
        </form>
        <form method="post" action="/boards/${slug}/duplicate">${btn("Duplicate")}</form>
        ${confirmAction({ action: `/boards/${slug}/delete`, verb: "Delete this board" })}</div>`, { id: "board-manage" })}
    </div>
  </section>`;
}

// GET /boards/:slug
export async function boardShow(ctx: Ctx): Promise<Response> {
  const slug = ctx.params.slug ?? "";
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  if (denied(ctx) || !isSlug(slug)) return notFoundPage(ctx);
  // What a "Reading…" page asks: it answers when the worker has the board, and draws nothing.
  if (ctx.url.searchParams.has("wait")) {
    return waitAnswer(await boardPicture(ctx.app, slug, LONG_WAIT_MS));
  }
  // The board's file and every panel's rows are read by a worker and kept: no query and no git on this thread.
  const picture = await timePhaseAsync(ctx.request, "picture", () => boardPicture(ctx.app, slug));
  if (picture === undefined || isFailed(picture)) {
    return page({
      ctx,
      title: "Boards",
      wide: true,
      body: html`<div class="hf bd"><header class="hf-head"><div class="hf-title"><h1>Boards</h1></div>
          <nav class="bd-nav" aria-label="Elsewhere">${btn("All boards", { href: "/boards", variant: "ghost" })}</nav></header>
        <section class="bd-now">${picture === undefined ? reading("Reading this board's charts…", `/boards/${slug}?wait=1`, `/boards/${slug}`) : readingFailed(picture.failed, `/boards/${slug}`)}</section></div>`,
      ...(picture === undefined ? { scriptJs: readingJs } : {}),
    });
  }
  if (picture.board === null) return notFoundPage(ctx);
  const board = picture.board;
  const panels = timePhase(ctx.request, "grid", () => grid(ctx.app, slug, board, picture.panels));
  const rendering = performance.now();
  const n = board.panels.length;
  const response = page({
    ctx,
    title: board.title,
    wide: true,
    body: html`<div class="hf bd">
      <header class="hf-head">
        <div class="hf-title"><h1>${board.title}</h1><p class="hf-live muted">${String(n)} ${n === 1 ? "chart" : "charts"} over ${RANGE_WORDS[board.range].toLowerCase()}${board.refresh === "off" ? "" : ", redrawn as things happen"}. Times are UTC.</p></div>
        <nav class="bd-nav" aria-label="Elsewhere">${btn("All boards", { href: "/boards", variant: "ghost" })}${btn("Explore the data", { href: "/boards/data", variant: "ghost" })}</nav>
      </header>
      ${panels}
      ${manage(slug, board, queryFields(readParams(ctx.url.searchParams)), listPins(ctx.app.db, ctx.auth.user?.id ?? ""))}
    </div>`,
    scriptJs: liveRegionsJs,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// GET /boards/:slug/live
export async function boardLive(ctx: Ctx): Promise<Response> {
  if (denied(ctx)) return fragment(html``, { status: 404 });
  const slug = ctx.params.slug ?? "";
  if (!isSlug(slug)) return fragment(html``, { status: 404 });
  const picture = await boardPicture(ctx.app, slug);
  if (picture === undefined || isFailed(picture)) return fragment(html``, { status: 503 });
  if (picture.board === null) return fragment(html``, { status: 404 });
  return fragment(grid(ctx.app, slug, picture.board, picture.panels), { request: ctx.request });
}
