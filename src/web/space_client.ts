/**
 * The space's canvas (#10444): one full-screen 2D canvas, drawn only when
 * something changed, from the compact arrays `space_model.ts` places. The
 * script is a hashed file the page ships (`layout.ts`, `scriptJs`); the
 * data is `space.json`, fetched once and again when the live channel says
 * the repository moved.
 *
 * Detail appears as you zoom rather than shrinking: what is drawn is chosen
 * by the size of a cluster's cell on the screen, and every word is set at a
 * fixed pixel size so it stays readable at each level. Nothing here builds
 * markup from data: text goes to the canvas or to `textContent`.
 */

import { viewJs } from "./space_view.ts";

export const spaceCss = /* css */ `
html.space-on, html.space-on body { height: 100%; overflow: hidden; overscroll-behavior: none; }
.space { position: fixed; inset: 0; background: var(--bg); color: var(--fg); overflow: auto; }
.space canvas, .space-bar, .space-time { display: none; }
html.space-on .space { overflow: hidden; }
html.space-on .space canvas { display: block; position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; outline: none; cursor: grab; }
html.space-on .space canvas:active { cursor: grabbing; }
html.space-on .space-bar { display: flex; position: absolute; left: 0; right: 0; top: 0; gap: .5rem; align-items: center; flex-wrap: wrap; padding: .5rem .75rem; pointer-events: none; }
.space-bar > *, .space-bar span > * { pointer-events: auto; }
.space-bar span { display: contents; }
html.space-on .space-time { display: flex; position: absolute; left: 0; right: 0; bottom: 0; gap: .6rem; align-items: center; padding: .6rem .75rem calc(.6rem + env(safe-area-inset-bottom)); background: linear-gradient(transparent, var(--bg) 60%); }
.space-time input[type=range] { flex: 1; min-width: 0; accent-color: var(--accent); }
.space-time output { font-variant-numeric: tabular-nums; min-width: 9ch; text-align: right; }
.space-panel { position: absolute; right: .75rem; top: 3.5rem; width: min(22rem, calc(100% - 1.5rem)); background: var(--bg); border-left: 1px solid var(--border); padding: .75rem 1rem; }
.space-panel[hidden] { display: none; }
.space-panel h2 { font-size: 1rem; margin: 0 0 .35rem; }
.space-panel .status-rows { margin-top: 0; border-top: 0; }
html.space-on .space-list { display: none; }
.space-list { padding: 4rem 1rem 2rem; max-width: 40rem; }
.space-list ul { list-style: none; padding: 0; margin: 0; }
`;

export const spaceJs = /* js */ `
(function () {
${viewJs}
  var root = document.getElementById('space');
  var cv = document.getElementById('space-cv');
  if (!root || !cv || !cv.getContext) return;
  document.documentElement.classList.add('space-on');
  var g = cv.getContext('2d');
  var base = root.getAttribute('data-base');
  var repo = root.getAttribute('data-repo');
  var dataUrl = root.getAttribute('data-src');
  var panel = document.getElementById('space-panel');
  var slider = document.getElementById('space-t');
  var clock = document.getElementById('space-clock');
  var crewBox = document.getElementById('space-crew');
  var playBtn = document.getElementById('space-play');
  var S = null, rows = [], W = 0, H = 0, dpr = 1;
  var view = { x: 0, y: 0, k: 1 };          // world point at the centre, pixels per world unit
  var fitK = 1, T = 0, live = true, dirty = true, playing = false, flight = null;
  var GLIDE = 4 * 3600000;                  // a landing slides from review to landed over this much time
  var NAMES = { ready: 'Ready', building: 'Building', review: 'In review', waiting: 'Waiting', landed: 'Landed' };
  var style = getComputedStyle(root);
  function token(name, fallback) { return style.getPropertyValue(name).trim() || fallback; }
  var fg = style.color || 'currentColor';
  var accent = token('--accent', fg);
  var accentFg = token('--accent-fg', fg);
  var ground = token('--bg', 'Canvas');
  // One accent, for interaction (the crew). A state is told by its cluster's label and position; its weight is muted as it ages.
  var WEIGHT = { ready: 1, building: 1, review: 0.7, waiting: 0.5, landed: 0.35 };
  var sans = style.fontFamily || 'system-ui, sans-serif';
  var picked = null;                        // {kind:'issue'|'crew', ...}

  function ago(ms) {
    var m = Math.round(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 90) return m + ' min ago';
    var h = Math.round(m / 60);
    return h < 48 ? h + ' h ago' : Math.round(h / 24) + ' d ago';
  }

  // ---- data ----
  function load(first) {
    return fetch(dataUrl, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r); })
      .then(function (data) {
        S = data; rows = data.issues;
        slider.max = String(Math.max(1, Math.round((S.now - S.weekStart) / 60000)));
        if (live) T = S.now;
        slider.value = String(Math.round((T - S.weekStart) / 60000));
        crewChips();
        if (first) { resize(); fit(true); fromHash(); }
        if (picked) refreshPanel();
        dirty = true;
      })
      .catch(function () {
        // The list the server drew is the page; say why the canvas is not.
        if (first) { document.documentElement.classList.remove('space-on'); root.setAttribute('data-failed', ''); }
        clock.textContent = 'Could not load';
        var note = document.getElementById('space-error'); if (note) note.hidden = false;
      });
  }

  // placement, crew, hash and picking are space_view.ts, shipped ahead of this script
  function crewNow() { return S ? crewAt(S.crew, rows, T) : []; }
  function at(r) { return placeAt(r, T); }

  // ---- view ----
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = root.clientWidth; H = root.clientHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    if (S) { var old = fitK; computeFit(); if (old !== fitK && view.k === old) view.k = fitK; }
    dirty = true;
  }
  function computeFit() {
    fitK = Math.min(W / S.world.w, H / S.world.h) * 0.94;
  }
  function limits() { return [fitK * 0.5, Math.max(fitK * 60, 6)]; }
  function fit(now) {
    computeFit();
    fly({ x: S.world.w / 2, y: S.world.h / 2, k: fitK }, now);
  }
  function fly(to, instant) {
    if (instant) { view.x = to.x; view.y = to.y; view.k = to.k; flight = null; dirty = true; hashSoon(); return; }
    flight = { from: { x: view.x, y: view.y, k: view.k }, to: to, t0: performance.now() };
    dirty = true;
  }
  function step(now) {
    if (flight) {
      var p = clamp((now - flight.t0) / 420, 0, 1), e = ease(p), f = flight.from, t = flight.to;
      // Zoom in log space so the motion feels even.
      view.k = f.k * Math.pow(t.k / f.k, e);
      view.x = f.x + (t.x - f.x) * e; view.y = f.y + (t.y - f.y) * e;
      if (p >= 1) { flight = null; hashSoon(); }
      dirty = true;
    }
    if (playing && S) {
      T += (7 * 86400000 / 20000) * Math.min(now - (step.last || now), 100);
      if (T >= S.now) { T = S.now; playing = false; live = true; playBtn.textContent = 'Play'; }
      else live = false;
      slider.value = String(Math.round((T - S.weekStart) / 60000));
      dirty = true; hashSoon();
    }
    step.last = now;
    if (dirty && S) { dirty = false; draw(); }
    requestAnimationFrame(step);
  }
  function toScreen(x, y) { return [(x - view.x) * view.k + W / 2, (y - view.y) * view.k + H / 2]; }
  function toWorld(sx, sy) { return [(sx - W / 2) / view.k + view.x, (sy - H / 2) / view.k + view.y]; }
  function zoomAt(sx, sy, factor) {
    var l = limits(), k2 = clamp(view.k * factor, l[0], l[1]);
    var w = toWorld(sx, sy);
    view.k = k2;
    view.x = w[0] - (sx - W / 2) / k2; view.y = w[1] - (sy - H / 2) / k2;
    flight = null; dirty = true; hashSoon();
  }

  // ---- drawing ----
  function font(px, weight) { g.font = (weight || 400) + ' ' + px + 'px ' + sans; }
  function wrap(text, width, maxLines) {
    var words = text.split(' '), lines = [], line = '';
    for (var i = 0; i < words.length; i++) {
      var t = line ? line + ' ' + words[i] : words[i];
      if (g.measureText(t).width <= width || !line) line = t;
      else { lines.push(line); line = words[i]; if (lines.length === maxLines) break; }
    }
    if (lines.length < maxLines && line) lines.push(line);
    else if (line && lines.length === maxLines) lines[maxLines - 1] += '\\u2026';
    return lines.map(function (l) {
      while (g.measureText(l).width > width && l.length > 1) l = l.slice(0, -2) + '\\u2026';
      return l;
    });
  }
  function fitText(text, width) {
    if (g.measureText(text).width <= width) return text;
    while (text.length > 1 && g.measureText(text + '\\u2026').width > width) text = text.slice(0, -1);
    return text + '\\u2026';
  }
  function draw() {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    var k = view.k, tl = toWorld(0, 0), br = toWorld(W, H);
    g.textBaseline = 'alphabetic';
    // Regions: the pillars.
    S.regions.forEach(function (r) {
      if (r.x > br[0] || r.y > br[1] || r.x + r.w < tl[0] || r.y + r.h < tl[1]) return;
      var p = toScreen(r.x, r.y), rw = r.w * k, rh = r.h * k;
      g.globalAlpha = 0.07; g.fillStyle = fg; g.fillRect(p[0], p[1], rw, rh);
      g.globalAlpha = 0.22; g.strokeStyle = fg; g.lineWidth = 1; g.strokeRect(p[0] + 0.5, p[1] + 0.5, rw - 1, rh - 1);
      g.globalAlpha = 1;
      // The label sticks to the top of the region's visible part, so it is readable at every depth.
      var ly = Math.max(p[1], 0) + 4;
      if (ly > p[1] + rh - 22) ly = p[1] + 4;
      var lx = Math.max(p[0], 0) + 10;
      var room = Math.min(p[0] + rw, W) - lx - 8;
      if (room > 30) {
        var size = clamp(rw / 14, 13, 24);
        g.save(); g.beginPath(); g.rect(p[0], p[1], rw, rh); g.clip();
        font(size, 700); g.fillStyle = fg;
        g.fillText(fitText(r.name, room), lx, ly + size);
        if (room > 150) {
          font(12, 400); g.globalAlpha = 0.7;
          var bits = r.open + ' open \\u00b7 ' + r.ready + ' ready';
          if (r.landed) bits += ' \\u00b7 ' + r.landed + ' landed';
          g.fillText(fitText(bits + (r.moving ? '' : ' \\u00b7 still'), room), lx, ly + size + 17);
          g.globalAlpha = 1;
          var bw = Math.min(room, 180), by = ly + size + 26;
          g.globalAlpha = 0.2; g.fillRect(lx, by, bw, 4);
          g.globalAlpha = 1; g.fillStyle = fg; g.fillRect(lx, by, bw * r.progress, 4);
        }
        g.restore();
      }
    });
    // Clusters: the states inside a pillar.
    S.clusters.forEach(function (c) {
      var cw = c[4] * k;
      if (cw < 80 || c[2] > br[0] || c[3] > br[1] || c[2] + c[4] < tl[0] || c[3] + c[5] < tl[1]) return;
      var p = toScreen(c[2], c[3]), name = NAMES[S.states[c[1]]];
      g.globalAlpha = 0.3; g.strokeStyle = fg; g.lineWidth = 1;
      g.beginPath(); g.moveTo(p[0] + 2, p[1] + 2); g.lineTo(p[0] + cw - 2, p[1] + 2); g.stroke();
      g.globalAlpha = 1; g.fillStyle = fg; font(12, 600);
      var lx = Math.max(p[0], 0) + 6;
      g.fillText(fitText(name + ' \\u00b7 ' + c[7], Math.min(p[0] + cw, W) - lx - 6), lx, Math.max(p[1], 0) + 20);
    });
    // Issues, at the level the cell size on the screen allows.
    var buckets = {};
    var cards = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], pos = at(r);
      if (!pos) continue;
      var s = toScreen(pos[0], pos[1]), cl = S.clusters[pos[2]], cell = cl[6] * k;
      if (s[0] < -cell || s[1] < -cell || s[0] > W + cell || s[1] > H + cell) continue;
      var st = S.states[cl[1]];
      if (cell >= 60) { cards.push([r, s, cell, st, pos]); continue; }
      var d = Math.max(1.5, cell * 0.7);
      (buckets[st] = buckets[st] || []).push(s[0] - d / 2, s[1] - d / 2, d);
    }
    Object.keys(buckets).forEach(function (st) {
      g.globalAlpha = WEIGHT[st]; g.fillStyle = fg; var b = buckets[st];
      for (var j = 0; j < b.length; j += 3) g.fillRect(b[j], b[j + 1], b[j + 2], b[j + 2]);
      g.globalAlpha = 1;
    });
    cards.forEach(function (c) { card(c[0], c[1], c[2], c[3], c[4]); });
    // Crew: where they are working.
    var crew = crewNow();
    crew.forEach(function (m) {
      var s = toScreen(m.x, m.y), x = s[0] + 10 + m.slot * 26, y = s[1] - 10;
      if (x < -20 || y < -20 || x > W + 20 || y > H + 20) return;
      g.beginPath(); g.arc(x, y, 12, 0, 6.2832);
      g.fillStyle = accent; g.fill();
      g.lineWidth = 2; g.strokeStyle = picked && picked.kind === 'crew' && picked.name === m.name ? fg : ground; g.stroke();
      g.fillStyle = accentFg; font(11, 700); g.textAlign = 'center';
      g.fillText(m.name.slice(0, 1).toUpperCase(), x, y + 4); g.textAlign = 'start';
      m.sx = x; m.sy = y;
    });
    lastCrew = crew;
  }
  var lastCrew = [];
  function card(r, s, cell, st, pos) {
    var size = cell * 0.92, x = s[0] - size / 2, y = s[1] - size / 2;
    g.globalAlpha = 1; g.fillStyle = fg; g.globalAlpha = 0.06; g.fillRect(x, y, size, size);
    g.globalAlpha = 0.25; g.strokeStyle = fg; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
    g.globalAlpha = WEIGHT[st];
    var open = !(r[5] && r[5] <= T);
    if (!open) { g.globalAlpha = 0.75 * WEIGHT[st]; }
    var pad = 10, tw = size - pad - 8;
    g.fillStyle = fg; font(12, 700);
    g.fillText('#' + r[0], x + pad, y + 18);
    font(12, 400);
    var lines = wrap(r[6], tw, size >= 170 ? 5 : 3);
    for (var i = 0; i < lines.length; i++) g.fillText(lines[i], x + pad, y + 36 + i * 15);
    if (size >= 170) {
      var yy = y + 36 + lines.length * 15 + 8;
      font(11, 400); g.globalAlpha = 0.75;
      var bits = [NAMES[st], 'opened ' + ago(T - r[4])];
      if (r[7]) bits.push('pull #' + r[7] + (r[12] ? ' \\u00b7 checks ' + r[12] : ''));
      if (r[11]) bits.push(r[11]);
      bits.forEach(function (b, n) { g.fillText(fitText(b, tw), x + pad, yy + n * 15); });
    }
    g.globalAlpha = 1;
  }

  // ---- input ----
  var pointers = {}, gesture = null, moved = 0, downAt = 0, downPos = null;
  function count() { return Object.keys(pointers).length; }
  function pinchState() {
    var ids = Object.keys(pointers), a = pointers[ids[0]], b = pointers[ids[1]];
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)) };
  }
  cv.addEventListener('pointerdown', function (e) {
    cv.setPointerCapture(e.pointerId);
    pointers[e.pointerId] = { x: e.offsetX, y: e.offsetY };
    flight = null;
    if (count() === 1) { moved = 0; downAt = e.timeStamp; downPos = { x: e.offsetX, y: e.offsetY }; }
    if (count() === 2) gesture = pinchState();
  });
  cv.addEventListener('pointermove', function (e) {
    var p = pointers[e.pointerId];
    if (!p) return;
    var dx = e.offsetX - p.x, dy = e.offsetY - p.y;
    p.x = e.offsetX; p.y = e.offsetY;
    moved += Math.abs(dx) + Math.abs(dy);
    if (count() === 1) {
      view.x -= dx / view.k; view.y -= dy / view.k;
    } else if (count() === 2 && gesture) {
      var now = pinchState();
      view.x -= (now.cx - gesture.cx) / view.k; view.y -= (now.cy - gesture.cy) / view.k;
      zoomAt(now.cx, now.cy, now.d / gesture.d);
      gesture = pinchState();
    }
    dirty = true; hashSoon();
  });
  function up(e) {
    var had = pointers[e.pointerId];
    delete pointers[e.pointerId];
    if (count() === 1) { gesture = null; moved = 99; }
    if (count() === 0) {
      gesture = null;
      if (had && e.type === 'pointerup' && moved < 8 && e.timeStamp - downAt < 600) tap(downPos.x, downPos.y);
    }
  }
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', function (e) {
    e.preventDefault();
    var unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    var d = e.deltaY * unit;
    zoomAt(e.offsetX, e.offsetY, Math.exp(-d * (e.ctrlKey ? 0.01 : 0.0016)));
  }, { passive: false });
  cv.addEventListener('keydown', function (e) {
    var step = 80 / view.k, mod = e.metaKey || e.ctrlKey, key = e.key;
    if (key === '+' || key === '=') zoomAt(W / 2, H / 2, 1.4);
    else if (key === '-' || key === '_') zoomAt(W / 2, H / 2, 1 / 1.4);
    else if (!mod && key === '0') fit();
    else if (!mod && key === 'n') goNow();
    else if (key === 'ArrowLeft') view.x -= step;
    else if (key === 'ArrowRight') view.x += step;
    else if (key === 'ArrowUp') view.y -= step;
    else if (key === 'ArrowDown') view.y += step;
    else return;
    e.preventDefault(); dirty = true; hashSoon();
  });
  window.addEventListener('resize', resize);

  // ---- picking ----
  function tap(sx, sy) {
    for (var i = 0; i < lastCrew.length; i++) {
      var m = lastCrew[i];
      if (Math.hypot(sx - m.sx, sy - m.sy) <= 16) { pick({ kind: 'crew', name: m.name }); return; }
    }
    var w = toWorld(sx, sy), best = pickIssue(rows, S.clusters, T, w[0], w[1]);
    if (best) pick({ kind: 'issue', number: best[0] });
    else { picked = null; panel.hidden = true; dirty = true; }
  }
  function pick(p) { picked = p; refreshPanel(); dirty = true; }
  function row(term, text, href) {
    var r = document.createElement('div'); r.className = 'status-row';
    var dt = document.createElement('dt'); dt.textContent = term;
    var dd = document.createElement('dd');
    if (href) { var a = document.createElement('a'); a.href = href; a.textContent = text; dd.appendChild(a); }
    else dd.textContent = text;
    r.appendChild(dt); r.appendChild(dd); list.appendChild(r);
  }
  var list = null;
  function refreshPanel() {
    if (!picked) { panel.hidden = true; return; }
    panel.textContent = '';
    var h = document.createElement('h2');
    list = document.createElement('dl'); list.className = 'status-rows';
    if (picked.kind === 'issue') {
      var r = rows.filter(function (x) { return x[0] === picked.number; })[0];
      if (!r) { panel.hidden = true; return; }
      var pos = at(r);
      h.textContent = '#' + r[0] + ' ' + r[6];
      var st = pos ? S.states[S.clusters[pos[2]][1]] : 'not yet opened';
      row('State', NAMES[st] || st);
      row('Opened', ago(T - r[4]));
      if (r[5] && r[5] <= T) row('Landed', ago(T - r[5]));
      if (r[7]) row('Pull', '#' + r[7] + (r[12] ? ' \\u00b7 checks ' + r[12] : ''), base + '/pulls/' + r[7]);
      if (r[11]) row('Held', r[11]);
      crewNow().filter(function (m) { return m.issue === r[0]; }).forEach(function (m) { row('On it', m.name); });
      row('Issue', 'Open it', base + '/issues/' + r[0]);
    } else {
      h.textContent = picked.name;
      var on = crewNow().filter(function (m) { return m.name === picked.name; })[0];
      if (!on) row('On', 'Nothing ' + (live ? 'right now' : 'then'));
      else {
        var rr = rows.filter(function (x) { return x[0] === on.issue; })[0];
        row('On', '#' + on.issue + (rr ? ' ' + rr[6] : ''), base + '/issues/' + on.issue);
        row('Since', ago(T - on.since));
      }
    }
    panel.appendChild(h); panel.appendChild(list);
    panel.hidden = false;
  }
  function crewChips() {
    crewBox.textContent = '';
    S.crew.forEach(function (m) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'btn'; b.setAttribute('data-variant', 'outline'); b.setAttribute('data-size', 'sm'); b.textContent = m.name;
      b.addEventListener('click', function () {
        var on = crewNow().filter(function (c) { return c.name === m.name; })[0];
        pick({ kind: 'crew', name: m.name });
        if (on) fly({ x: on.x, y: on.y, k: Math.max(view.k, fitK * 24) });
      });
      crewBox.appendChild(b);
    });
  }

  // ---- time ----
  function showClock() {
    clock.textContent = live ? 'Now' : new Date(T).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function setT(ms) {
    T = ms; live = S && T >= S.now; if (live) T = S.now;
    slider.value = String(Math.round((T - S.weekStart) / 60000));
    showClock(); if (picked) refreshPanel(); dirty = true; hashSoon();
  }
  function goNow() { playing = false; playBtn.textContent = 'Play'; setT(S.now); }
  slider.addEventListener('input', function () { playing = false; playBtn.textContent = 'Play'; setT(S.weekStart + Number(slider.value) * 60000); });
  playBtn.addEventListener('click', function () {
    playing = !playing; playBtn.textContent = playing ? 'Pause' : 'Play';
    if (playing && live) { T = S.weekStart; live = false; }
  });
  document.getElementById('space-now').addEventListener('click', function () { goNow(); });
  document.getElementById('space-fit').addEventListener('click', function () { fit(); });
  document.getElementById('space-in').addEventListener('click', function () { zoomAt(W / 2, H / 2, 1.5); });
  document.getElementById('space-out').addEventListener('click', function () { zoomAt(W / 2, H / 2, 1 / 1.5); });
  setInterval(showClock, 1000);

  // ---- the view in the address ----
  var hashTimer = 0;
  function hashSoon() {
    if (hashTimer) return;
    hashTimer = setTimeout(function () {
      hashTimer = 0;
      if (!S) return;
      var h = hashOf(view, fitK, live, T);
      try { history.replaceState(null, '', '#' + h); } catch (err) {}
    }, 250);
  }
  function fromHash() {
    var h = parseHash(location.hash, S, fitK, limits());
    if (h.k !== undefined) { view.x = h.x; view.y = h.y; view.k = h.k; }
    if (h.t !== undefined) setT(h.t); else showClock();
  }

  // ---- the live channel: any event of this repository fetches the space again ----
  var refetch = 0;
  if (window.EventSource) {
    var es = new EventSource('/events');
    es.addEventListener('forge', function (ev) {
      var d; try { d = JSON.parse(ev.data); } catch (err) { return; }
      if (d.repo !== repo || !/^(run|issue|pull)\\./.test(d.kind || '')) return;
      if (refetch) return;
      refetch = setTimeout(function () { refetch = 0; if (!document.hidden) load(false); }, 1200);
    });
  }

  resize();
  requestAnimationFrame(step);
  load(true);
})();
`;
