/**
 * Iterations, the browser's half: the rules and the script. The server draws
 * every card and row; the script places each run under the build it grew
 * from, draws the lines, folds a fork or a run, and zooms. Folds and zoom are
 * kept in this browser only. Without the script the runs stand side by side and no button is shown: the controls and the fold buttons are made or shown by it.
 */

export const ITERATIONS_CSS = /* css */ `
.it-key{display:flex;gap:16px;color:var(--muted-fg);font-size:var(--fs-min);margin:4px 0 8px;flex-wrap:wrap;align-items:center}
.it-key i{display:inline-block;width:24px;height:0;border-top:2px solid var(--muted-fg);vertical-align:middle;margin-right:6px}
.it-key i.it-thin{border-top-width:1px}
.it-key i.it-dash{border-top-style:dashed}
.it-sp{margin-left:auto;display:none;gap:8px;align-items:center;flex-wrap:wrap}
.it-on .it-sp{display:flex}
.it-zc{display:inline-flex;gap:2px}
#it-zval{min-width:56px;font-variant-numeric:tabular-nums}
.it-stage{position:relative;padding:16px;border:1px solid var(--border);border-radius:var(--radius);overflow:auto;max-height:60vh}
#it-grid{--it-card:calc(50ch + 26px);font-family:var(--mono);font-size:var(--fs-min);transform-origin:0 0}
.it-tree{position:relative;display:flex;gap:32px;align-items:flex-start;width:max-content;min-width:100%}
.it-tree.it-placed{display:block}
.it-placed .it-lane{position:absolute}
.it-lane{width:var(--it-card);background:var(--card);border:1px solid var(--border);border-radius:var(--radius);z-index:1}
.it-lh{display:flex;align-items:center;gap:6px;padding:8px;border-bottom:1px solid var(--border);min-height:32px}
.it-nm{display:flex;gap:8px;align-items:baseline;min-width:0;padding:0;background:none;border:0;color:inherit;font:inherit;text-align:left;cursor:pointer}
.it-nm i{font-style:normal;color:var(--muted-fg);width:10px}
.it-nm i::before{content:"\\25BE"}
.it-lane.it-shut .it-nm i::before{content:"\\25B8"}
.it-nm b{overflow-wrap:anywhere}
.it-sub{color:var(--muted-fg);font-size:var(--fs-min)}
.it-ct{margin-left:auto;white-space:nowrap}
.it-ct::before{content:"fold run"}
.it-lane.it-runshut .it-ct::before{content:"open run"}
.it-rows{display:flex;flex-direction:column}
.it-b{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:8px;padding:8px 12px;border-top:1px solid var(--border)}
.it-rows > .it-b:first-child{border-top:0}
.it-l{font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:inherit}
.it-d{color:var(--muted-fg);font-size:var(--fs-min);text-align:right;white-space:nowrap}
.it-n{grid-column:1/-1;color:var(--muted-fg);font-size:var(--fs-min);overflow-wrap:anywhere}
.it-coll{display:none;flex-direction:column;gap:1px;width:100%;background:none;border:0;color:inherit;font:inherit;text-align:left;padding:8px 12px;cursor:pointer}
.it-coll span{color:var(--muted-fg);font-size:var(--fs-min)}
.it-lane.it-shut .it-fcoll,.it-lane.it-runshut:not(.it-shut) .it-rcoll{display:flex}
.it-lane.it-shut .it-rows,.it-lane.it-runshut .it-rows,.it-lane.it-shut .it-ct{display:none}
.it-lane.it-shut .it-lh{border-bottom:0}
.it-lane.it-hid{display:none}
.it-edges{position:absolute;left:0;top:0;pointer-events:none;overflow:visible}
.it-edges path{fill:none;stroke:var(--muted-fg);stroke-width:2}
.it-edges path[data-kind="concept"]{stroke-dasharray:6 5}
.it-edges path[data-kind="branch"]{stroke-width:1.25}
`;

export const ITERATIONS_JS = `
(function () {
  var root = document.getElementById('it-page'), stage = document.getElementById('it-stage'), box = document.getElementById('it-zoom'), grid = document.getElementById('it-grid');
  if (!root || !stage || !box || !grid) return;
  root.classList.add('it-on');
  // The fold buttons exist only here: a fork's name becomes one, a run of several builds gets one.
  grid.querySelectorAll('span.it-nm').forEach(function (s) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'it-nm'; b.setAttribute('data-act', 'fork'); b.title = 'Fold this fork'; b.innerHTML = s.innerHTML; s.replaceWith(b);
  });
  grid.querySelectorAll('.it-lane').forEach(function (l) {
    var h = l.querySelector('.it-lh');
    if (!l.querySelector('.it-rcoll') || !h) return;
    var b = document.createElement('button'); b.type = 'button'; b.className = 'btn it-ct'; b.setAttribute('data-size', 'sm'); b.setAttribute('data-variant', 'ghost'); b.setAttribute('data-act', 'run'); b.title = 'Fold this run'; h.appendChild(b);
  });
  var lanes = []; try { lanes = JSON.parse(root.getAttribute('data-lanes') || '[]') || []; } catch (e) {}
  var NS = 'http://www.w3.org/2000/svg', W = 220, G = 36, PAD = 16, Z = 1, ZKEY = 'forge:iterations-zoom', FKEY = 'forge:iterations-folds:' + root.getAttribute('data-here');
  var STEPS = [0.25, 0.33, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 2];
  try { Z = Math.min(2, Math.max(0.2, Number(localStorage.getItem(ZKEY)) || 1)); } catch (e) {}
  var els = {}; grid.querySelectorAll('.it-lane').forEach(function (el) { els[el.getAttribute('data-lane')] = el; });
  var byId = {}; lanes.forEach(function (l) { byId[l.id] = l; });
  function seen(el) { return el && el.offsetParent !== null; }
  function anchor(key) {
    var rows = grid.querySelectorAll('.it-b[data-key]');
    for (var i = 0; i < rows.length; i++) if (rows[i].getAttribute('data-key') === key && seen(rows[i])) return rows[i];
    var holds = grid.querySelectorAll('[data-keys]');
    for (var k = 0; k < holds.length; k++) if ((' ' + holds[k].getAttribute('data-keys') + ' ').indexOf(' ' + key + ' ') >= 0 && seen(holds[k])) return holds[k];
    return null;
  }
  function parentOf(l) {
    if (l.from) { var a = anchor(l.from); return a ? { a: a, lane: a.closest('.it-lane') } : null; }
    if (l.fromRepo) { var m = byId[l.fromRepo] && els[l.fromRepo]; return m && seen(m) ? { a: m.querySelector('.it-lh'), lane: m } : null; }
    return null;
  }
  function visible() { return lanes.filter(function (l) { return seen(els[l.id]); }); }
  function save() {
    var s = { shut: [], run: [] };
    Object.keys(els).forEach(function (id) { if (els[id].classList.contains('it-shut')) s.shut.push(id); if (els[id].classList.contains('it-runshut')) s.run.push(id); });
    try { if (s.shut.length || s.run.length) localStorage.setItem(FKEY, JSON.stringify(s)); else localStorage.removeItem(FKEY); } catch (e) {}
  }
  function place() {
    var one = grid.querySelector('.it-lane'); if (one && one.offsetWidth) W = one.offsetWidth;
    var hid = {};
    grid.querySelectorAll('.it-lane.it-shut').forEach(function (el) { hid[el.getAttribute('data-repo')] = true; });
    grid.querySelectorAll('.it-lane.it-branch').forEach(function (el) { el.classList.toggle('it-hid', !!hid[el.getAttribute('data-repo')]); });
    var pos = {};
    visible().forEach(function (l, i) {
      var y = PAD, p = parentOf(l);
      if (p && p.lane && pos[p.lane.getAttribute('data-lane')]) y = pos[p.lane.getAttribute('data-lane')].y + p.a.offsetTop + p.a.offsetHeight + 10;
      pos[l.id] = { x: PAD + i * (W + G), y: y };
      els[l.id].style.left = pos[l.id].x + 'px'; els[l.id].style.top = y + 'px';
    });
    var w = 0, h = 0;
    grid.querySelectorAll('.it-lane').forEach(function (el) { if (!seen(el)) return; w = Math.max(w, el.offsetLeft + el.offsetWidth); h = Math.max(h, el.offsetTop + el.offsetHeight); });
    grid.style.width = (w + PAD) + 'px'; grid.style.height = (h + PAD) + 'px';
    lines(); fit();
  }
  function lines() {
    var old = grid.querySelector('svg.it-edges'); if (old) old.remove();
    var svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'it-edges');
    var o = grid.getBoundingClientRect();
    function R(el) { var r = el.getBoundingClientRect(); return { l: (r.left - o.left) / Z, t: (r.top - o.top) / Z, r: (r.right - o.left) / Z, b: (r.bottom - o.top) / Z, cx: ((r.left + r.right) / 2 - o.left) / Z, cy: ((r.top + r.bottom) / 2 - o.top) / Z }; }
    visible().forEach(function (l) {
      var p = parentOf(l); if (!p) return;
      var a = R(p.a), h = R(els[l.id].querySelector('.it-lh')), sx, sy, ex = h.cx, ey = h.t, d;
      if (h.cx > a.r) { sx = a.r; sy = a.cy; } else if (h.cx < a.l) { sx = a.l; sy = a.cy; } else { sx = a.cx; sy = a.b; }
      if (sx === a.cx) { if (ey < sy) ey = h.b; var my = (sy + ey) / 2; d = 'M' + sx + ',' + sy + ' C' + sx + ',' + my + ' ' + ex + ',' + my + ' ' + ex + ',' + ey; }
      else if (ey > sy + 8) { var dir = ex > sx ? 1 : -1, r = Math.min(12, Math.abs(ex - sx) / 2, (ey - sy) / 2); d = 'M' + sx + ',' + sy + ' H' + (ex - dir * r) + ' Q' + ex + ',' + sy + ' ' + ex + ',' + (sy + r) + ' V' + ey; }
      else { ey = h.b; d = 'M' + sx + ',' + sy + ' C' + ex + ',' + sy + ' ' + ex + ',' + sy + ' ' + ex + ',' + ey; }
      var path = document.createElementNS(NS, 'path'); path.setAttribute('d', d); path.setAttribute('data-kind', l.kind || 'fork'); svg.appendChild(path);
    });
    svg.setAttribute('width', grid.scrollWidth); svg.setAttribute('height', grid.scrollHeight);
    grid.insertBefore(svg, grid.firstChild);
  }
  // Zoom: the grid is scaled, its box takes the scaled size so the stage scrolls the right distance.
  function fit() {
    grid.style.transform = Z === 1 ? '' : 'scale(' + Z + ')';
    box.style.width = Math.ceil(grid.offsetWidth * Z) + 'px'; box.style.height = Math.ceil(grid.offsetHeight * Z) + 'px';
    var v = document.getElementById('it-zval'); if (v) v.textContent = Math.round(Z * 100) + '%';
  }
  function setZoom(z, px, py) {
    z = Math.min(2, Math.max(0.2, Math.round(z * 100) / 100));
    if (z === Z) return;
    if (px === undefined) { px = stage.clientWidth / 2; py = stage.clientHeight / 2; }
    var gx = (stage.scrollLeft + px) / Z, gy = (stage.scrollTop + py) / Z;
    Z = z;
    try { if (Z === 1) localStorage.removeItem(ZKEY); else localStorage.setItem(ZKEY, String(Z)); } catch (e) {}
    fit(); lines();
    stage.scrollLeft = gx * Z - px; stage.scrollTop = gy * Z - py;
  }
  function step(dir) {
    var next = dir > 0 ? STEPS.find(function (s) { return s > Z + 0.001; }) : STEPS.slice().reverse().find(function (s) { return s < Z - 0.001; });
    if (next !== undefined) setZoom(next);
  }
  function on(id, f) { var b = document.getElementById(id); if (b) b.addEventListener('click', f); }
  on('it-zin', function () { step(1); });
  on('it-zout', function () { step(-1); });
  on('it-zval', function () { setZoom(1); });
  on('it-zfit', function () {
    var w = grid.offsetWidth, h = grid.offsetHeight; if (!w || !h) return;
    var cs = getComputedStyle(stage), padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight), padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    var tall = parseFloat(cs.maxHeight); if (!(tall > 0)) tall = window.innerHeight * 0.6;
    setZoom(Math.floor(Math.min(1, (stage.clientWidth - padX - 2) / w, (tall - padY - 2) / h) * 100) / 100);
    stage.scrollLeft = 0; stage.scrollTop = 0;
  });
  stage.addEventListener('wheel', function (e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    var r = stage.getBoundingClientRect();
    setZoom(Z * Math.exp(-e.deltaY / 300), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  // Folds: a fork to its name, a run to one node.
  grid.addEventListener('click', function (ev) {
    var t = ev.target.closest && ev.target.closest('[data-act]'); if (!t) return;
    var el = t.closest('.it-lane'); if (!el) return;
    el.classList.toggle(t.getAttribute('data-act') === 'fork' ? 'it-shut' : 'it-runshut');
    save(); place();
  });
  function all(shut) {
    Object.keys(els).forEach(function (id) { if (byId[id] && byId[id].main) els[id].classList.toggle('it-shut', shut); els[id].classList.remove('it-runshut'); });
    save(); place();
  }
  on('it-fold-all', function () { all(true); });
  on('it-open-all', function () { all(false); });
  try {
    var s = JSON.parse(localStorage.getItem(FKEY) || 'null');
    if (s) { (s.shut || []).forEach(function (id) { if (els[id]) els[id].classList.add('it-shut'); }); (s.run || []).forEach(function (id) { if (els[id]) els[id].classList.add('it-runshut'); }); }
  } catch (e) {}
  grid.classList.add('it-placed'); place();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(place);
})();
`;
