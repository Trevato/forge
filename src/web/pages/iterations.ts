/**
 * Iterations: a fork family's build pins as fork cards in columns by fork
 * depth, or as a downward tree of runs (Tree) with drag, Align and Reset;
 * zoom with Fit, Collapse and Expand forks, folds kept per browser, and
 * Notes. A build picked plays in the player under the graph, beside its info
 * panel (`build_info.ts`). The layout is
 * records/design/1031-forgej-iterations/LAYOUT.md (iteration H) and
 * records/design/1101-forgej-graph-layout (B, C, D).
 *
 * The cards, rows and folds are drawn here; the script opens folds, swaps
 * the picked build's player and panel in from their templates, and draws the
 * lines between cards. Displays (the picker, Showcased, Edit display
 * selections) are not on this forge yet.
 */

import { notePin } from "../../actions/builds.ts";
import { iterationsOf, lanesOf, type IterationBuild, type IterationFork, type IterationLane } from "../../core/iterations.ts";
import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { NOTES_MAX, splitPinNote, wholeNotes } from "../../git/builds.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, loadRepo, notFoundPage, repoBase, repoHeader, repoPalette, signInFirst } from "../chrome.ts";
import { backTo, field, prefersJson, readForm } from "../form.ts";
import { html, raw, when, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { infoOf, INFO_CSS, INFO_JS, noteListOf, playerOf, shortDate } from "./build_info.ts";

export { shortDate };
export type { IterationBuild };


// ---- drawing ----

/** What a row needs to draw itself. */
interface Draw {
  readonly index: Map<string, number>;
  readonly selected: string | undefined;
}

function row(b: IterationBuild, d: Draw): Html {
  return html`<button type="button" class="it-b${b.key === d.selected ? " it-sel" : ""}" data-i="${String(d.index.get(b.key)!)}" data-key="${b.key}">
    <span class="it-l mono">${b.label}</span><span class="it-d">${shortDate(b.at)}</span>
    ${when(b.note !== "", () => html`<span class="it-n">${b.note}</span>`)}
  </button>`;
}

/** A card's rows, and a line for each branch with no pin at its tip. */
function rows(f: { readonly builds: readonly IterationBuild[]; readonly tips: readonly string[] }, d: Draw): Html {
  return html`${f.builds.map((b) => row(b, d))}${f.tips.map(
    (t) => html`<div class="it-b it-tip"><span class="it-l mono">${t}</span><span class="it-d">branch</span><span class="it-n">No pin</span></div>`,
  )}`;
}

function card(f: IterationFork, d: Draw): Html {
  return html`<section class="it-fork" data-repo="${f.repo}">
    <button type="button" class="it-head"><b class="mono">${f.name}</b></button>
    <div class="it-rows">${rows(f, d)}</div>
  </section>`;
}

/** One run of the downward tree: its head, its rows, and the one node it folds to. */
function lane(l: IterationLane, branches: number, d: Draw): Html {
  const keys = l.builds.map((b) => b.key).join(" ");
  const n = l.builds.length;
  const head = l.main
    ? html`<button type="button" class="it-nm" data-act="fork" title="Fold this fork"><i aria-hidden="true"></i><b class="mono">${l.title}</b></button>${when(
        branches > 0 && n > 1,
        () => html`<button type="button" class="it-ct" data-act="run" title="Fold this run"></button>`,
      )}`
    : html`<span class="it-sub mono">${l.title}</span>`;
  const first = l.builds[0], last = l.builds.at(-1);
  return html`<section class="it-lane${l.main ? "" : " it-branch"}" data-lane="${l.id}" data-repo="${l.repo}">
    <header class="it-lh">${head}</header>
    <div class="it-rows">${rows(l, d)}</div>
    ${when(l.main, () => html`<button type="button" class="it-coll it-fcoll" data-act="fork" data-keys="${keys}"><b>${String(n)} ${n === 1 ? "build" : "builds"}</b><span>${branches > 0 ? `${String(branches)} ${branches === 1 ? "branch" : "branches"} · ` : ""}folded</span></button>`)}
    ${when(first !== undefined && last !== undefined && n > 1, () => html`<button type="button" class="it-coll it-rcoll" data-act="run" data-keys="${keys}"><b class="mono">${first!.label} → ${last!.label}</b><span>${String(n)} builds in a run</span></button>`)}
  </section>`;
}

export const ITERATIONS_CSS = INFO_CSS + /* css */ `
.it-seg{display:inline-flex;border:1px solid var(--border);border-radius:8px;overflow:hidden}
.it-seg a{padding:4px 10px;font-size:13px;color:var(--muted-fg);text-decoration:none}
.it-seg a[aria-current="page"]{background:var(--muted);color:var(--fg);font-weight:600}
.it-key .it-sp{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.it-zc{display:inline-flex;gap:2px;margin-right:6px}
.it-zc .btn{min-width:30px;justify-content:center;font-variant-numeric:tabular-nums}
#it-zval{min-width:52px}
.it-zoom{position:relative}
#it-grid{transform-origin:0 0}
/* One card is as wide as a conventional commit subject: 50 characters of monospace, plus its padding. */
#it-grid{--it-card:calc(50ch + 26px);font-family:var(--mono);font-size:12.5px}
#it-grid .it-fork,#it-grid .it-lane,#it-grid .it-b,#it-grid .it-coll,#it-grid .it-head,#it-grid .it-nm,#it-grid .it-tip{font-family:var(--mono)}
.it-fork.it-shut .it-rows{display:none}
.it-fork.it-shut .it-head{border-bottom:0}
.it-key i.it-thin{border-top-width:1px}
.it-tree{position:relative;min-width:100%}
.it-lane{position:absolute;width:var(--it-card);background:var(--card);border:1px solid var(--border);border-radius:10px;z-index:1;cursor:grab;touch-action:none}
.it-lane.it-dragging{z-index:5;cursor:grabbing;box-shadow:0 0 0 2px var(--accent)}
.it-lh{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--border);min-height:32px}
.it-nm{display:flex;gap:6px;align-items:baseline;min-width:0;padding:0;background:none;border:0;color:inherit;font:inherit;text-align:left;cursor:pointer}
.it-nm i{font-style:normal;color:var(--muted-fg);font-size:11.5px;width:10px}
.it-nm i::before{content:"\\25BE"}
.it-lane.it-shut .it-nm i::before{content:"\\25B8"}
.it-nm b{font-size:13px;overflow-wrap:anywhere}
.it-sub{color:var(--muted-fg);font-size:11.5px}
.it-ct{margin-left:auto;background:none;border:1px solid var(--border);border-radius:999px;color:var(--muted-fg);font:inherit;font-size:11.5px;padding:0 7px;cursor:pointer;white-space:nowrap}
.it-ct::before{content:"fold run"}
.it-lane.it-runshut .it-ct::before{content:"open run"}
.it-coll{display:none;flex-direction:column;gap:1px;width:100%;background:none;border:0;border-left:3px solid transparent;color:inherit;font:inherit;text-align:left;padding:8px 10px;cursor:pointer}
.it-coll b{font-size:13px}
.it-coll span{color:var(--muted-fg);font-size:11.5px}
.it-lane.it-shut .it-fcoll,.it-lane.it-runshut:not(.it-shut) .it-rcoll{display:flex}
.it-lane.it-shut .it-rows,.it-lane.it-runshut .it-rows,.it-lane.it-shut .it-ct{display:none}
.it-lane.it-shut .it-lh{border-bottom:0}
.it-lane.it-hid{display:none}
body.it-nosel{user-select:none;-webkit-user-select:none}
.it-checks{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.it-checks label{display:flex;gap:6px;align-items:center;cursor:pointer}
.it-key{display:flex;gap:16px;color:var(--muted-fg);font-size:12.5px;margin:4px 0 8px;flex-wrap:wrap}
.it-key i{display:inline-block;width:22px;height:0;border-top:2px solid var(--muted-fg);vertical-align:middle;margin-right:6px}
.it-key i.it-dash{border-top-style:dashed}
.it-stage{position:relative;padding:16px;border:1px solid var(--border);border-radius:12px;overflow:auto;max-height:60vh}
.it-grid{position:relative;display:grid;grid-auto-flow:column;grid-auto-columns:var(--it-card);column-gap:64px;align-items:start;width:max-content}
.it-col{display:flex;flex-direction:column;gap:18px}
.it-edges{position:absolute;left:0;top:0;pointer-events:none;overflow:visible}
.it-edges path{fill:none;stroke:var(--muted-fg);stroke-width:2}
.it-edges path[data-kind="concept"]{stroke-dasharray:6 5}
.it-edges path[data-kind="branch"]{stroke-width:1.25}
.it-fork{background:var(--card);border:1px solid var(--border);border-radius:10px;position:relative;z-index:1}
.it-head{display:flex;align-items:baseline;gap:8px;padding:8px 10px;width:100%;background:none;border:0;border-bottom:1px solid var(--border);color:inherit;font:inherit;text-align:left;cursor:pointer}
.it-head b{font-size:13px;min-width:0;overflow-wrap:anywhere}
.it-rows{display:flex;flex-direction:column}
.it-b{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:8px;padding:7px 10px;border:0;border-top:1px solid var(--border);border-left:3px solid transparent;background:none;color:inherit;font:inherit;text-align:left;width:100%;cursor:pointer}
.it-rows > .it-b:first-child{border-top:0}
.it-l{font-weight:700;font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.it-d{color:var(--muted-fg);font-size:12.5px;text-align:right;white-space:nowrap}
.it-n{grid-column:1/-1;color:var(--muted-fg);font-size:12.5px;overflow-wrap:anywhere}
.it-b.it-sel{background:var(--muted);border-left-color:var(--accent)}
.it-b.it-tip{opacity:.55;cursor:default}
.it-b.it-tip .it-l{font-weight:400}
.it-page[data-notes="0"] button.it-b .it-n,.it-page[data-notes="0"] .it-notes{display:none}
.it-pane{display:grid;grid-template-columns:320px minmax(0,1fr);gap:16px;margin-top:16px;align-items:start}
@media (max-width:760px){.it-pane{grid-template-columns:minmax(0,1fr)}}
/* A phone. The page never scrolls sideways (base.ts clips the body); what is wider than the screen scrolls inside .it-stage.
   The one box wider than a 390 px screen is a card (50ch of mono is about 400 px): hold it to the canvas, 100vw less the
   shell's padding (2 x 16), the stage's padding (2 x 16) and its border (2). The toolbar wraps and its buttons are 44 px. */
@media (max-width:760px){
#it-grid{--it-card:min(calc(50ch + 26px),calc(100vw - 66px))}
.it-key .it-sp{margin-left:0;width:100%}
.it-zc{flex-wrap:wrap;gap:6px;margin-right:0}
.it-page .it-zc .btn[data-size="sm"],.it-page .it-sp > .btn[data-size="sm"]{min-height:44px;min-width:44px}
.it-seg a{display:inline-flex;align-items:center;min-height:44px}
}
`;

/**
 * The lines between fork cards, from each card's head to the next: a
 * string of browser code.
 * `drawEdges(grid, edges)` redraws them over `grid`.
 */
export const EDGES_JS = `
  function drawEdges(grid, list, z) {
    z = z || 1;
    var NS = 'http://www.w3.org/2000/svg';
    function head(repo) {
      var cards = grid.querySelectorAll('.it-fork');
      for (var i = 0; i < cards.length; i++) if (cards[i].getAttribute('data-repo') === repo) return cards[i].querySelector('.it-head');
      return null;
    }
    var old = grid.querySelector('svg.it-edges'); if (old) old.remove();
    var svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'it-edges');
    var o = grid.getBoundingClientRect();
    list.forEach(function (e) {
      var a = head(e.from), b = head(e.to); if (!a || !b) return;
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      var x1 = (ra.right - o.left) / z, y1 = (ra.top - o.top + ra.height / 2) / z, x2 = (rb.left - o.left) / z, y2 = (rb.top - o.top + rb.height / 2) / z, mx = (x1 + x2) / 2;
      var p = document.createElementNS(NS, 'path');
      p.setAttribute('d', 'M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2);
      p.setAttribute('data-kind', e.kind);
      svg.appendChild(p);
    });
    svg.setAttribute('width', grid.scrollWidth); svg.setAttribute('height', grid.scrollHeight);
    grid.insertBefore(svg, grid.firstChild);
  }
`;

/**
 * Zoom for the graph: − and + step through fixed scales, the percentage goes
 * back to 100%, Fit shows the whole graph in the stage, and ⌘ or Ctrl with
 * the wheel (a trackpad pinch) zooms where the pointer is. The scale is kept
 * in this browser. `zoom(stage, box, grid, redraw)` returns { z, fit } where
 * z() is the scale and fit() resizes the scrolled box to the scaled graph.
 */
export const ZOOM_MIN = 0.1;
/** Fit alone may go below ZOOM_MIN, so a very wide tree still fits whole; a saved zoom reopens at ZOOM_MIN or more. */
export const ZOOM_FLOOR = 0.01;

export const ZOOM_JS = `
  function zoom(stage, box, grid, redraw) {
    var MIN = ${ZOOM_MIN}, FLOOR = ${ZOOM_FLOOR}, STEPS = [0.25, 0.33, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 2], KEY = 'forge:iterations-zoom';
    var Z = 1;
    try { Z = Math.min(2, Math.max(MIN, Number(localStorage.getItem(KEY)) || 1)); } catch (e) { Z = 1; }
    var val = document.getElementById('it-zval');
    function fit() {
      grid.style.transform = Z === 1 ? '' : 'scale(' + Z + ')';
      box.style.width = Math.ceil(grid.offsetWidth * Z) + 'px'; box.style.height = Math.ceil(grid.offsetHeight * Z) + 'px';
      if (val) val.textContent = Math.round(Z * 100) + '%';
    }
    // Change the scale, keeping the point (px, py) of the stage where it is: its centre unless given.
    function set(z, px, py, free) {
      z = Math.min(2, Math.max(free ? FLOOR : MIN, Math.round(z * 100) / 100));
      if (z === Z) return;
      if (px === undefined) { px = stage.clientWidth / 2; py = stage.clientHeight / 2; }
      var gx = (stage.scrollLeft + px) / Z, gy = (stage.scrollTop + py) / Z;
      Z = z;
      try { if (Z === 1) localStorage.removeItem(KEY); else localStorage.setItem(KEY, String(Z)); } catch (e) {}
      fit(); redraw();
      stage.scrollLeft = gx * Z - px; stage.scrollTop = gy * Z - py;
    }
    function step(dir) {
      var next = dir > 0 ? STEPS.find(function (s) { return s > Z + 0.001; }) : STEPS.slice().reverse().find(function (s) { return s < Z - 0.001; });
      if (next !== undefined) set(next);
    }
    function on(id, f) { var b = document.getElementById(id); if (b) b.addEventListener('click', f); }
    on('it-zin', function () { step(1); });
    on('it-zout', function () { step(-1); });
    on('it-zval', function () { set(1); });
    on('it-zfit', function () {
      var w = grid.offsetWidth, h = grid.offsetHeight; if (!w || !h) return;
      var cs = getComputedStyle(stage), padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight), padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      // The height the stage may grow to, not the height it has: a stage that shrank to a small graph would shrink it again on every Fit.
      var tall = parseFloat(cs.maxHeight); if (!(tall > 0)) tall = window.innerHeight * 0.6;
      var bw = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth), bh = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      set(Math.floor(Math.min(1, (stage.clientWidth - padX - 2) / w, (tall - bh - padY - 2) / h) * 100) / 100, undefined, undefined, true);
      stage.scrollLeft = 0; stage.scrollTop = 0;
    });
    stage.addEventListener('wheel', function (e) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      var r = stage.getBoundingClientRect();
      set(Z * Math.exp(-e.deltaY / 300), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    fit();
    return { z: function () { return Z; }, fit: fit };
  }
`;

/**
 * The downward tree's script (records/design/1101-forgej-graph-layout: B,
 * with C's Reset and D's Align): places each run under the build it grew
 * from, draws the lines, folds a fork or a run, and lets a run be dragged
 * anywhere. Where runs were dragged is kept in this browser only, per
 * repository. Reset puts every run back in B's place; Align keeps the
 * dragged order and snaps columns and spacing to a grid.
 * `tree(grid, lanes, store)` returns relayout().
 */
export const TREE_JS = `
  function tree(grid, lanes, store, zoomOf) {
    var NS = 'http://www.w3.org/2000/svg', W = 220, G = 36, PAD = 16, GAPY = 16;
    function width() { var one = grid.querySelector('.it-lane'); if (one && one.offsetWidth) W = one.offsetWidth; }
    var byId = {}; lanes.forEach(function (l) { byId[l.id] = l; });
    var pins = {};
    try { pins = JSON.parse(localStorage.getItem(store) || '{}') || {}; } catch (e) { pins = {}; }
    function save() { try { if (Object.keys(pins).length) localStorage.setItem(store, JSON.stringify(pins)); else localStorage.removeItem(store); } catch (e) {} }
    function laneEl(id) { var all = grid.querySelectorAll('.it-lane'); for (var i = 0; i < all.length; i++) if (all[i].getAttribute('data-lane') === id) return all[i]; return null; }
    function seen(el) { return el && el.offsetParent !== null; }
    // Where a line starts: the build's row, else the fold or folded node that holds it, else its run's head.
    function anchor(key) {
      var rows = grid.querySelectorAll('[data-key]');
      for (var i = 0; i < rows.length; i++) if (rows[i].getAttribute('data-key') === key && rows[i].classList.contains('it-b') && seen(rows[i])) return rows[i];
      var holds = grid.querySelectorAll('[data-keys]');
      for (var k = 0; k < holds.length; k++) if ((' ' + holds[k].getAttribute('data-keys') + ' ').indexOf(' ' + key + ' ') >= 0 && seen(holds[k])) return holds[k];
      return null;
    }
    function mainOf(repo) { var l = byId[repo]; return l ? laneEl(l.id) : null; }
    function parentEl(l) {
      if (l.from) { var a = anchor(l.from); return a ? { a: a, lane: a.closest('.it-lane') } : null; }
      if (l.fromRepo) { var m = mainOf(l.fromRepo); return m && seen(m) ? { a: m.querySelector('.it-lh'), lane: m } : null; }
      return null;
    }
    function visible() { return lanes.filter(function (l) { var el = laneEl(l.id); return seen(el); }); }
    // B: each run its own column, hung just under the build it grew from.
    function strict() {
      width();
      var pos = {};
      visible().forEach(function (l, i) {
        var y = PAD, p = parentEl(l);
        if (p && p.lane && pos[p.lane.getAttribute('data-lane')]) y = pos[p.lane.getAttribute('data-lane')].y + p.a.offsetTop + p.a.offsetHeight + 10;
        pos[l.id] = { x: PAD + i * (W + G), y: y };
      });
      return pos;
    }
    function place() {
      var hid = {};
      grid.querySelectorAll('.it-lane.it-shut').forEach(function (el) { hid[el.getAttribute('data-repo')] = true; });
      grid.querySelectorAll('.it-lane.it-branch').forEach(function (el) { el.classList.toggle('it-hid', !!hid[el.getAttribute('data-repo')]); });
      var pos = strict();
      visible().forEach(function (l) { var p = pins[l.id] || pos[l.id], el = laneEl(l.id); el.style.left = p.x + 'px'; el.style.top = p.y + 'px'; });
      var w = 0, h = 0;
      grid.querySelectorAll('.it-lane').forEach(function (el) { if (!seen(el)) return; w = Math.max(w, el.offsetLeft + el.offsetWidth); h = Math.max(h, el.offsetTop + el.offsetHeight); });
      grid.style.width = (w + PAD) + 'px'; grid.style.height = (h + PAD) + 'px';
      lines();
    }
    function lines() {
      var old = grid.querySelector('svg.it-edges'); if (old) old.remove();
      var svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'it-edges');
      var o = grid.getBoundingClientRect();
      var z = zoomOf();
      function R(el) { var r = el.getBoundingClientRect(); return { l: (r.left - o.left) / z, t: (r.top - o.top) / z, r: (r.right - o.left) / z, b: (r.bottom - o.top) / z, cx: ((r.left + r.right) / 2 - o.left) / z, cy: ((r.top + r.bottom) / 2 - o.top) / z }; }
      visible().forEach(function (l) {
        var p = parentEl(l), le = laneEl(l.id); if (!p || !le) return;
        var a = R(p.a), h = R(le.querySelector('.it-lh')), sx, sy, ex = h.cx, ey = h.t, d;
        if (h.cx > a.r) { sx = a.r; sy = a.cy; } else if (h.cx < a.l) { sx = a.l; sy = a.cy; } else { sx = a.cx; sy = a.b; }
        if (sx === a.cx) { if (ey < sy) ey = h.b; var my = (sy + ey) / 2; d = 'M' + sx + ',' + sy + ' C' + sx + ',' + my + ' ' + ex + ',' + my + ' ' + ex + ',' + ey; }
        else if (ey > sy + 8) { var dir = ex > sx ? 1 : -1, r = Math.min(12, Math.abs(ex - sx) / 2, (ey - sy) / 2); d = 'M' + sx + ',' + sy + ' H' + (ex - dir * r) + ' Q' + ex + ',' + sy + ' ' + ex + ',' + (sy + r) + ' V' + ey; }
        else { ey = h.b; d = 'M' + sx + ',' + sy + ' C' + ex + ',' + sy + ' ' + ex + ',' + sy + ' ' + ex + ',' + ey; }
        var path = document.createElementNS(NS, 'path'); path.setAttribute('d', d); path.setAttribute('data-kind', l.kind || 'fork'); svg.appendChild(path);
      });
      svg.setAttribute('width', grid.scrollWidth); svg.setAttribute('height', grid.scrollHeight);
      grid.insertBefore(svg, grid.firstChild);
    }
    // Fold a fork, or a run, to one node.
    grid.addEventListener('click', function (ev) {
      var t = ev.target.closest && ev.target.closest('[data-act]'); if (!t) return;
      var el = t.closest('.it-lane'); if (!el) return;
      el.classList.toggle(t.getAttribute('data-act') === 'fork' ? 'it-shut' : 'it-runshut');
      place();
    });
    // C and D: drag a run anywhere. A drag is never a click.
    var swallow = false;
    grid.addEventListener('click', function (ev) { if (swallow) { ev.stopPropagation(); ev.preventDefault(); } }, true);
    grid.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      var el = e.target.closest && e.target.closest('.it-lane'); if (!el) return;
      var id = el.getAttribute('data-lane'), sx = e.clientX, sy = e.clientY, x0 = el.offsetLeft, y0 = el.offsetTop, on = false;
      function move(ev) {
        var dx = (ev.clientX - sx) / zoomOf(), dy = (ev.clientY - sy) / zoomOf();
        if (!on) { if (Math.hypot(dx, dy) * zoomOf() < 5) return; on = true; el.classList.add('it-dragging'); document.body.classList.add('it-nosel'); }
        var x = Math.max(0, x0 + dx), y = Math.max(0, y0 + dy);
        el.style.left = x + 'px'; el.style.top = y + 'px'; pins[id] = { x: x, y: y };
        lines();
      }
      function done() {
        removeEventListener('pointermove', move); removeEventListener('pointerup', done); removeEventListener('pointercancel', done);
        if (!on) return;
        el.classList.remove('it-dragging'); document.body.classList.remove('it-nosel');
        swallow = true; setTimeout(function () { swallow = false; }, 0);
        save(); place();
      }
      addEventListener('pointermove', move); addEventListener('pointerup', done); addEventListener('pointercancel', done);
    });
    // C: Reset puts every run back where B puts it.
    function reset() { pins = {}; save(); place(); }
    // D: Align keeps the order you dragged, and snaps columns and spacing to a grid.
    function align() {
      width();
      var ls = visible().map(function (l) { var el = laneEl(l.id); return { id: l.id, l: l, x: el.offsetLeft, y: el.offsetTop, h: el.offsetHeight }; });
      var by = {}; ls.forEach(function (x) { by[x.id] = x; });
      ls.forEach(function (x) { var p = parentEl(x.l); if (p && p.lane) { x.par = p.lane.getAttribute('data-lane'); x.off = p.a.offsetTop + p.a.offsetHeight + 10; } });
      ls.sort(function (a, b) { return a.x - b.x; });
      var cols = [];
      ls.forEach(function (x) { if (!cols.length || x.x - cols[cols.length - 1].x0 > W * 0.5) cols.push({ x0: x.x, items: [] }); cols[cols.length - 1].items.push(x); });
      cols.forEach(function (c, ci) { c.items.sort(function (a, b) { return a.y - b.y; }).forEach(function (x, oi) { x.ci = ci; x.oi = oi; x.Y = PAD; }); });
      // Each run sits just under the build it grew from, unless the order you set in its column pushes it lower.
      for (var pass = 0; pass < 5; pass++) cols.forEach(function (c) {
        var floor = PAD;
        c.items.forEach(function (x) { var p = x.par && by[x.par]; var want = p && !(p.ci === x.ci && p.oi > x.oi) ? p.Y + x.off : PAD; x.Y = Math.max(floor, want); floor = x.Y + x.h + GAPY; });
      });
      pins = {};
      cols.forEach(function (c, i) { c.items.forEach(function (x) { pins[x.id] = { x: PAD + i * (W + G), y: x.Y }; }); });
      save(); place();
    }
    var r = document.getElementById('it-reset'); if (r) r.addEventListener('click', reset);
    var al = document.getElementById('it-align'); if (al) al.addEventListener('click', align);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(place);
    return place;
  }
`;

/** The page's script: the picker and Notes into the URL, folds, the picked build, the toggle chips, the lines. */
export const ITERATIONS_JS = `
(function () {
  var root = document.getElementById('it-page');
  var grid = document.getElementById('it-grid');
  var dataEl = document.getElementById('it-data');
  if (!root || !grid || !dataEl) return;
  var data = JSON.parse(dataEl.textContent || '{}');
  var player = document.getElementById('it-player'), info = document.getElementById('it-info');
  function setParam(k, v) {
    var u = new URL(location.href);
    if (v === null) u.searchParams.delete(k); else u.searchParams.set(k, v);
    history.replaceState(null, '', u.pathname + u.search + u.hash);
  }
  ${EDGES_JS}
  ${ZOOM_JS}
  ${TREE_JS}
  ${INFO_JS}
  var zoomed = zoom(document.getElementById('it-stage'), document.getElementById('it-zoom'), grid, function () { edges(); });
  var relayout = data.lanes ? tree(grid, data.lanes, 'forge:iterations-tree:' + data.here, zoomed.z) : null;
  function edges() { if (relayout) relayout(); else drawEdges(grid, data.edges, zoomed.z()); zoomed.fit(); }
  // Collapse forks folds every fork to its name; Expand forks opens every one, and every folded run in the tree.
  function foldAll(shut) {
    if (relayout) grid.querySelectorAll('.it-lane:not(.it-branch)').forEach(function (el) { el.classList.toggle('it-shut', shut); if (!shut) el.classList.remove('it-runshut'); });
    else grid.querySelectorAll('.it-fork').forEach(function (el) { el.classList.toggle('it-shut', shut); if (shut) el.classList.remove('it-open'); });
    edges(); saveFolds();
  }
  // Folds are kept in this browser, per repository and layout. A fork that gained or lost a pin
  // since it was folded opens again, so new work is never hidden behind an old fold.
  var FOLDS = 'forge:iterations-folds:' + data.here + (relayout ? ':tree' : ':columns');
  function pinsOf(repo) {
    var n = 0, all = grid.querySelectorAll('button.it-b');
    for (var i = 0; i < all.length; i++) { var k = all[i].getAttribute('data-key') || ''; if (k.slice(0, k.lastIndexOf(':')) === repo) n++; }
    return n;
  }
  function foldable() { return grid.querySelectorAll(relayout ? '.it-lane' : '.it-fork'); }
  function saveFolds() {
    var out = {};
    foldable().forEach(function (el) {
      var shut = el.classList.contains('it-shut'), run = el.classList.contains('it-runshut'); if (!shut && !run) return;
      var repo = el.getAttribute('data-repo');
      out[el.getAttribute('data-lane') || repo] = { shut: shut, run: run, pins: pinsOf(repo) };
    });
    try { if (Object.keys(out).length) localStorage.setItem(FOLDS, JSON.stringify(out)); else localStorage.removeItem(FOLDS); } catch (e) {}
  }
  function loadFolds() {
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem(FOLDS) || '{}') || {}; } catch (e) { saved = {}; }
    foldable().forEach(function (el) {
      var repo = el.getAttribute('data-repo'), f = saved[el.getAttribute('data-lane') || repo];
      if (!f || f.pins !== pinsOf(repo)) return;
      if (f.shut) el.classList.add('it-shut');
      if (f.run) el.classList.add('it-runshut');
    });
    saveFolds();
  }
  grid.addEventListener('click', function () { setTimeout(saveFolds, 0); });
  var fa = document.getElementById('it-fold-all'); if (fa) fa.addEventListener('click', function () { foldAll(true); });
  var oa = document.getElementById('it-open-all'); if (oa) oa.addEventListener('click', function () { foldAll(false); });
  var current = null;
  var shown = panel(player, info, function (j) { if (current) noteRow(current.btn, j.note); });
  var notes = document.getElementById('it-notes');
  notes.addEventListener('change', function () { root.setAttribute('data-notes', notes.checked ? '1' : '0'); setParam('notes', notes.checked ? null : '0'); edges(); });
  function select(btn) {
    var i = btn.getAttribute('data-i');
    var p = document.getElementById('it-p-' + i), f = document.getElementById('it-i-' + i);
    if (!p || !f) return;
    var sel = grid.querySelectorAll('.it-sel');
    for (var k = 0; k < sel.length; k++) sel[k].classList.remove('it-sel');
    btn.classList.add('it-sel');
    current = { i: i, btn: btn };
    setParam('build', btn.getAttribute('data-key'));
    shown.show(p, f);
  }
  function noteRow(btn, note) {
    var line = btn.querySelector('.it-n');
    if (note === '') { if (line) line.remove(); return; }
    if (!line) { line = document.createElement('span'); line.className = 'it-n'; btn.querySelector('.it-d').after(line); }
    line.textContent = note;
  }
  grid.addEventListener('click', function (ev) {
    var t = ev.target;
    var h = t.closest && t.closest('.it-head');
    // A card folds to its name and back.
    if (h) { h.parentNode.classList.toggle('it-shut'); edges(); return; }
    var b = t.closest && t.closest('button.it-b');
    if (b) select(b);
  });
  loadFolds();
  edges();
  window.addEventListener('resize', edges);
  var asked = new URL(location.href).searchParams.get('build');
  if (asked) {
    var all = grid.querySelectorAll('button.it-b');
    for (var n = 0; n < all.length; n++) if (all[n].getAttribute('data-key') === asked) {
      // A build asked for by its link is shown even inside a kept fold.
      var repoOf = all[n].getAttribute('data-key'); repoOf = repoOf.slice(0, repoOf.lastIndexOf(':'));
      foldable().forEach(function (el) { if (el.getAttribute('data-repo') === repoOf) el.classList.remove('it-shut', 'it-runshut'); });
      select(all[n]); edges();
      // Back from a build, or a link to one: the player is in view.
      player.scrollIntoView({ block: 'nearest' });
      break;
    }
  } else {
    // This repository's own card in view, as a new fork lands here.
    var own = grid.querySelector('[data-repo="' + CSS.escape(data.here) + '"]');
    var stage = document.getElementById('it-stage');
    if (own && stage) {
      var so = stage.getBoundingClientRect(), ro = own.getBoundingClientRect();
      if (ro.left < so.left || ro.right > so.right) stage.scrollLeft += ro.left - so.left - (so.width - ro.width) / 2;
      if (ro.top < so.top || ro.top > so.bottom - 40) stage.scrollTop += ro.top - so.top - 16;
    }
  }
})();
`;

/** Collapse forks and Expand forks: every fork folded to its name, or every one open. */
const ZOOM_CONTROLS = `<span class="it-zc" role="group" aria-label="Zoom"><button type="button" class="btn" data-size="sm" id="it-zout" title="Zoom out" aria-label="Zoom out">−</button><button type="button" class="btn" data-size="sm" id="it-zval" title="Back to 100%">100%</button><button type="button" class="btn" data-size="sm" id="it-zin" title="Zoom in" aria-label="Zoom in">+</button><button type="button" class="btn" data-size="sm" id="it-zfit" title="Fit the whole graph in view">Fit</button></span>`;

const FORK_CONTROLS = `<span class="it-zc" role="group" aria-label="Forks"><button type="button" class="btn" data-size="sm" id="it-fold-all" title="Fold every fork to its name">Collapse forks</button><button type="button" class="btn" data-size="sm" id="it-open-all" title="Open every fork">Expand forks</button></span>`;

// GET /:owner/:name/iterations?notes=0&build=owner/name:label&layout=tree
export async function iterationsPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  if (!repo) return timePhase(ctx.request, "render", () => notFoundPage(ctx));
  const got = await timePhaseAsync(ctx.request, "graph", () => iterationsOf(ctx, repo));
  if (got === undefined) return timePhase(ctx.request, "render", () => notFoundPage(ctx));
  const base = repoBase(repo);
  const notes = ctx.url.searchParams.get("notes") !== "0";
  const selected = ctx.url.searchParams.get("build") ?? undefined;
  const builds = got.forks.flatMap((f) => f.builds.map((b) => ({ b, f })));
  const draw: Draw = { index: new Map(builds.map(({ b }, i) => [b.key, i])), selected };
  const layout = ctx.url.searchParams.get("layout") === "tree" ? "tree" : "columns";
  const lanes = layout === "tree" ? lanesOf(got.forks) : [];
  const maxDepth = Math.max(0, ...got.forks.map((f) => f.depth));
  const columns = Array.from({ length: maxDepth + 1 }, (_, d) => got.forks.filter((f) => f.depth === d));
  const linkOf = (key: string) => {
    const u = new URL(`${ctx.url.origin}${base}/iterations`);
    u.searchParams.set("build", key);
    return u.toString();
  };
  const backOf = (key: string) => `${base}/iterations?build=${encodeURIComponent(key)}`;
  const data = JSON.stringify({
    here: `${repo.ownerName}/${repo.name}`,
    edges: got.edges,
    ...(layout === "tree" ? { lanes: lanes.map((l) => ({ id: l.id, from: l.from, fromRepo: l.fromRepo, kind: l.kind })) } : {}),
  });
  const layoutLink = (to: "columns" | "tree", label: string) => {
    const u = new URL(ctx.url.toString());
    if (to === "tree") u.searchParams.set("layout", "tree");
    else u.searchParams.delete("layout");
    return html`<a href="${u.pathname}${u.search}" ${layout === to ? raw('aria-current="page"') : null}>${label}</a>`;
  };
  const body = html`${repoHeader(ctx, repo, "branches", { compact: true })}
    <div class="it-page" id="it-page" data-notes="${notes ? "1" : "0"}">
      <div class="page-head mt">
        <h2>Iterations</h2>
        <div class="it-checks">
          <span class="it-seg" role="group" aria-label="Layout">${layoutLink("columns", "Columns")}${layoutLink("tree", "Tree")}</span>
          <label><input type="checkbox" id="it-notes" ${notes ? raw("checked") : null} /> Notes</label>
          <a href="${base}/builds">Builds</a>
        </div>
      </div>
      ${layout === "tree"
        ? html`<div class="it-key"><span><i></i>fork of</span><span><i class="it-thin"></i>branch</span><span><i class="it-dash"></i>built on a pin of</span>
            <span class="it-sp">${raw(FORK_CONTROLS)}${raw(ZOOM_CONTROLS)}<span>Drag a run to move it. Kept in this browser.</span><button type="button" class="btn" data-size="sm" id="it-align" title="Keep the order you dragged; snap columns and spacing to a grid">Align</button><button type="button" class="btn" data-size="sm" id="it-reset" title="Put every run back in the tree's own place">Reset</button></span></div>
          <div class="it-stage" id="it-stage"><div class="it-zoom" id="it-zoom"><div class="it-tree" id="it-grid">${lanes.map((l) => lane(l, l.main ? lanes.filter((x) => !x.main && x.repo === l.repo).length : 0, draw))}</div></div></div>`
        : html`<div class="it-key"><span><i></i>fork of</span><span><i class="it-dash"></i>built on a pin of</span><span class="it-sp">${raw(FORK_CONTROLS)}${raw(ZOOM_CONTROLS)}</span></div>
          <div class="it-stage" id="it-stage"><div class="it-zoom" id="it-zoom"><div class="it-grid" id="it-grid">
            ${columns.map((c) => html`<div class="it-col">${c.map((f) => card(f, draw))}</div>`)}
          </div></div></div>`}
      <div class="it-pane">
        <aside class="it-info" id="it-info"><h3>Build info</h3><section><p>No build selected</p></section></aside>
        <div class="it-player" id="it-player" aria-live="polite"><div class="it-empty">No build selected</div></div>
      </div>
      ${builds.map(
        ({ b, f }, i) =>
          html`<template id="it-p-${String(i)}">${playerOf(b)}</template><template id="it-i-${String(i)}">${infoOf(ctx, b, f.forkOf, linkOf(b.key), backOf(b.key))}</template>`,
      )}
      ${raw(`<script type="application/json" id="it-data">${data.replaceAll("<", "\\u003c")}</script>`)}
    </div>`;
  return timePhase(ctx.request, "render", () =>
    page({
      ctx,
      title: `Iterations · ${repo.name}`,
      crumbs: crumbsFor(repo),
      palette: repoPalette(ctx, repo),
      body,
      styleCss: ITERATIONS_CSS,
      scriptJs: ITERATIONS_JS,
      wide: true,
    }),
  );
}

const NOTE_ERRORS: Record<string, string> = {
  invalid_note: `Not saved: a note needs text, at most ${NOTES_MAX / 1024} KB.`,
  notes_lost: "Not saved: this repository's notes lost a note. Ask its admin to restore refs/forge/notes.",
  mirrored: "Not saved: this repository is a mirror.",
  moved: "Not saved: the pin changed meanwhile. Reload and try again.",
};

// POST /:owner/:name/builds/:label/note — add a note to a build, as a writer; `note` and `body` still join into it.
export async function noteSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const to = backTo(form, `${repoBase(repo)}/iterations`);
  const given = (k: string) => (typeof form.get(k) === "string" ? { [k]: field(form, k) } : {});
  const done = await notePin(ctx.app, ctx.auth.user, repo, ctx.params.label ?? "", { ...given("notes"), ...given("note"), ...given("body") });
  if (!done.ok) {
    if (done.error === "unauthorized" || done.error === "forbidden" || done.error === "not_found") return notFoundPage(ctx);
    const message = NOTE_ERRORS[done.error] ?? "Not saved: git refused the change.";
    if (prefersJson(ctx)) return Response.json({ error: done.error, message }, { status: done.error === "invalid_note" ? 422 : 409 });
    return flashTo(ctx, to, { tone: "danger", message });
  }
  if (prefersJson(ctx)) {
    const pin = done.value.pin;
    const list = noteListOf({ notes: pin.notes ?? [], tag: wholeNotes(pin.label, pin.tagNote ?? pin.note), by: pin.pinnedBy, at: pin.pinnedAt });
    return Response.json({ note: splitPinNote(pin.label, pin.note).note, html: list === null ? "" : list.text });
  }
  return flashTo(ctx, to, { message: "Note saved." });
}
