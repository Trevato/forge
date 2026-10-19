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
import { listAllBoards, showBoard } from "../../actions/boards.ts";
import { CHART_NAMES } from "../../boards/chart.ts";
import { MAX_H, MAX_PANELS, MAX_TITLE, MAX_W, RANGES, type Board, type Panel } from "../../boards/store.ts";
import type { App } from "../../app.ts";
import type { Ctx } from "../../http/context.ts";
import { liveRegionsJs } from "../client.ts";
import { notFoundPage } from "../chrome.ts";
import { html, raw, when, type Html } from "../html.ts";
import { fragment, page } from "../layout.ts";
import { btn, card, empty } from "../ui.ts";
import { flowPanel, flowPanelCss } from "./flow-panel.ts";
import { cellsOf, chartBox, paramsOf, queryFields, readParams, runFor } from "./boards.ts";

const RANGE_MS = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 } as const;
/** The events the panels' queries read (runs, pulls, checks, issues, usage): any of them may change a chart. */
const READS = "run.queued,run.started,run.finished,pull.*,check.*,issue.*,usage.*";

const option = (value: string, selected: boolean) =>
  html`<option value="${value}" ${selected ? raw("selected") : null}>${value}</option>`;

/** The panel's query as asked, with the board's range as its start when it names none. */
function ranged(query: Record<string, unknown>, range: Board["range"]): Record<string, unknown> {
  if (range === "all" || query.from !== undefined) return query;
  return { ...query, from: new Date(Date.now() - RANGE_MS[range]).toISOString() };
}

function drawPanel(app: App, board: Board, panel: Panel): Html {
  const answer = runFor(app.db, panel.chart, ranged(panel.query, board.range));
  const q = paramsOf(panel.query, panel.chart);
  const body = !answer.ok
    ? html`<p class="muted small">${answer.error}</p>`
    : chartBox(panel.chart, cellsOf(answer.rows), panel.title);
  const explore = new URLSearchParams(Object.entries(q).filter(([k, v]) => v !== "" && k !== "rows"));
  return html`<div class="card bp-w${String(panel.w)} bp-h${String(panel.h)}">
    <div class="card-head"><h2>${panel.title}</h2>
      <a class="muted small" href="/boards/data?${explore.toString()}">explore</a></div>
    <div class="card-body">${body}</div>
  </div>`;
}

/** The grid alone: what the page shows and what the live address answers with. */
function grid(app: App, slug: string, board: Board): Html {
  return html`<section
    class="bgrid"
    id="board-grid"
    ${board.refresh === "off"
      ? null
      : html`data-live="${READS}" data-live-src="/boards/${slug}/live"`}
  >
    ${board.panels.length === 0
      ? html`<p class="muted">No panels yet. Add one below.</p>`
      : board.panels.map((p) => drawPanel(app, board, p))}
  </section>`;
}

const denied = (ctx: Ctx) => {
  const u = ctx.auth.user;
  return u?.isAdmin !== true || u.kind === "agent";
};

// GET /boards
export async function boardsList(ctx: Ctx): Promise<Response> {
  const listed = await listAllBoards(ctx.app, ctx.auth.user);
  if (!listed.ok) return notFoundPage(ctx);
  const make = html`<form method="post" action="/boards/new" class="bform">
    <label class="qf"><span>New board</span><input class="input" name="title" required maxlength="${String(MAX_TITLE)}" placeholder="Title" /></label>
    ${btn("Make board", { variant: "primary" })}
  </form>`;
  const body =
    listed.value.length === 0
      ? empty({ icon: "activity", title: "No boards yet", note: "Make one above; it is saved as a file in forge/boards." })
      : card(
          html`<ul class="list">
            ${listed.value.map(
              ({ slug, board }) => html`<li class="row">
                <a href="/boards/${slug}"><strong>${board.title}</strong></a>
                <span class="muted small">${String(board.panels.length)} panel${board.panels.length === 1 ? "" : "s"} · ${board.range} · refresh ${board.refresh}</span>
              </li>`,
            )}
          </ul>`,
          { pad: false },
        );
  return page({
    ctx,
    title: "Boards",
    body: html`<div class="page-head"><h1>Boards</h1>
        ${btn("Explore the data", { href: "/boards/data", variant: "ghost" })}</div>
      ${card(make)} ${body} ${flowPanel(ctx.app, { kind: "owner" }, ctx.url, "/boards")}`,
    styleCss: flowPanelCss,
  });
}

function panelForm(slug: string, op: string, p: Panel | undefined, index: number, fields: Html): Html {
  return html`<form method="post" action="/boards/${slug}/${op}" class="bform">
    ${op === "edit" ? html`<input type="hidden" name="index" value="${String(index)}" />` : null}
    <label class="qf"><span>Panel title</span><input class="input" name="title" required maxlength="${String(MAX_TITLE)}" value="${p?.title ?? ""}" placeholder="Panel title" /></label>
    <label class="qf"><span>Width</span><select class="input" name="w">
      ${[1, 2, 3].slice(0, MAX_W).map((n) => html`<option value="${String(n)}" ${n === (p?.w ?? 1) ? raw("selected") : null}>${String(n)} wide</option>`)}
    </select></label>
    <label class="qf"><span>Height</span><select class="input" name="h">
      ${[1, 2, 3].slice(0, MAX_H).map((n) => html`<option value="${String(n)}" ${n === (p?.h ?? 1) ? raw("selected") : null}>${String(n)} high</option>`)}
    </select></label>
    ${fields}
    ${btn(op === "edit" ? "Save panel" : "Add panel", { variant: "primary" })}
  </form>`;
}

function manage(slug: string, board: Board, adding: Html): Html {
  const one = (p: Panel, i: number) => html`<li class="row bmanage">
    <details>
      <summary><strong>${p.title}</strong> <span class="muted small">${CHART_NAMES[p.chart]} · ${String(p.w)}×${String(p.h)}</span></summary>
      ${panelForm(slug, "edit", p, i, queryFields(paramsOf(p.query, p.chart)))}
    </details>
    <form method="post" action="/boards/${slug}/move" class="row-actions">
      <input type="hidden" name="index" value="${String(i)}" />
      ${btn("Up", { size: "sm", name: "by", value: "-1", label: `Move ${p.title} up` })}
      ${btn("Down", { size: "sm", name: "by", value: "1", label: `Move ${p.title} down` })}
    </form>
    <form method="post" action="/boards/${slug}/remove">
      <input type="hidden" name="index" value="${String(i)}" />
      ${btn("Remove", { size: "sm", variant: "danger", label: `Remove ${p.title}` })}
    </form>
  </li>`;
  return html`${card(
      html`<ul class="list">${board.panels.map(one)}</ul>`,
      { head: html`<h2>Panels</h2>`, pad: false },
    )}
    ${when(
      board.panels.length < MAX_PANELS,
      () => card(panelForm(slug, "add", undefined, 0, adding), { head: html`<h2>Add a panel</h2>` }),
    )}
    ${card(
      html`<form method="post" action="/boards/${slug}/rename" class="bform">
          <label class="qf"><span>Board title</span><input class="input" name="title" required maxlength="${String(MAX_TITLE)}" value="${board.title}" /></label>
          ${btn("Rename")}
        </form>
        <form method="post" action="/boards/${slug}/settings" class="bform">
          <label class="qf"><span>Range</span><select class="input" name="range">${RANGES.map((r) => option(r, r === board.range))}</select></label>
          <label class="qf"><span>Live</span><select class="input" name="refresh"><option value="off" ${board.refresh === "off" ? raw("selected") : null}>off</option><option value="10s" ${board.refresh === "off" ? null : raw("selected")}>on: redraw when events arrive</option></select></label>
          ${btn("Save settings")}
        </form>
        <form method="post" action="/boards/${slug}/duplicate" class="bform">${btn("Duplicate")}</form>
        <form method="post" action="/boards/${slug}/delete" class="bform">${btn("Delete this board", { variant: "danger" })}</form>`,
      { head: html`<h2>Board</h2>` },
    )}`;
}

// GET /boards/:slug
export async function boardShow(ctx: Ctx): Promise<Response> {
  const slug = ctx.params.slug ?? "";
  const shown = await showBoard(ctx.app, ctx.auth.user, slug);
  if (!shown.ok) return notFoundPage(ctx);
  const board = shown.value;
  return page({
    ctx,
    title: board.title,
    body: html`<div class="page-head"><h1>${board.title}</h1>
        ${btn("All boards", { href: "/boards", variant: "ghost" })}</div>
      ${grid(ctx.app, slug, board)}
      ${manage(slug, board, queryFields(readParams(ctx.url.searchParams)))}`,
    scriptJs: liveRegionsJs,
  });
}

// GET /boards/:slug/live
export async function boardLive(ctx: Ctx): Promise<Response> {
  if (denied(ctx)) return fragment(html``, { status: 404 });
  const slug = ctx.params.slug ?? "";
  const shown = await showBoard(ctx.app, ctx.auth.user, slug);
  if (!shown.ok) return fragment(html``, { status: 404 });
  return fragment(grid(ctx.app, slug, shown.value), { request: ctx.request });
}
