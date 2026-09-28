/**
 * The big view's client: one focus model for the keyboard and a gamepad,
 * one line for a command, a filter or a word to the crew, a small stack of
 * where you came from, and the clocks. Everything a key does is a thing on
 * the page already — a row's link, a row's button, the footer's own chips
 * — so the sheet cannot promise what the page does not have.
 *
 * The pure parts (`big-model.ts`) are carried in by their source, so the
 * browser runs exactly what the tests ran. Nothing here animates: the
 * clock ticks once a second, and the rest waits for a key.
 */

import {
  findApp,
  halfPage,
  moveIndex,
  nextPane,
  parseCommand,
} from "./big-model.ts";

const shared = [moveIndex, nextPane, halfPage, findApp, parseCommand]
  .map(String)
  .join("\n");

export const bigJs = /* js */ `
${shared}
(function () {
  var doc = document;
  var big = doc.getElementById('big');
  if (!big) return;
  var here = big.getAttribute('data-here') || '';
  var apps = (big.getAttribute('data-apps') || '').split(' ').filter(Boolean);
  var where = location.pathname + location.search;

  // ---- memory: this browser's tab remembers where you were ----
  function remember(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function recall(k) { try { var v = sessionStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }

  // ---- panes and rows ----
  function panes() { return Array.prototype.slice.call(big.querySelectorAll('.big-pane')); }
  function shown(el) { return !el.hasAttribute('data-filtered') && !el.closest('[hidden]'); }
  function rowsOf(pane) { return pane ? Array.prototype.filter.call(pane.querySelectorAll('[data-key]'), shown) : []; }
  function nameOf(pane) { return pane ? pane.getAttribute('data-pane') || '' : ''; }
  var paneAt = 0;
  var keys = {};
  function current() { return panes()[paneAt] || null; }
  function rowByKey(pane, key) {
    var rows = rowsOf(pane);
    for (var i = 0; i < rows.length; i++) if (rows[i].getAttribute('data-key') === key) return rows[i];
    return null;
  }
  function focusedRow() { var p = current(); return p ? rowByKey(p, keys[nameOf(p)] || '') : null; }
  function paint() {
    panes().forEach(function (p, i) {
      p.classList.toggle('is-pane', i === paneAt);
      var k = keys[nameOf(p)] || '';
      Array.prototype.forEach.call(p.querySelectorAll('.is-focus'), function (el) {
        if (el.getAttribute('data-key') !== k) el.classList.remove('is-focus');
      });
      var el = rowByKey(p, k);
      if (el) el.classList.add('is-focus');
    });
    glance();
    remember('big:' + where, { pane: paneAt, keys: keys });
  }
  function settle(pane, row, scroll) {
    if (!pane) return;
    keys[nameOf(pane)] = row ? row.getAttribute('data-key') : '';
    paint();
    if (row && !mode) {
      row.focus({ preventScroll: true });
      if (scroll !== false) row.scrollIntoView({ block: 'nearest' });
    }
  }
  function moveRow(step) {
    var p = current(); if (!p) return;
    var rows = rowsOf(p), r = focusedRow();
    if (rows.length === 0) {
      // A pane with no rows — a transcript — scrolls by the line instead.
      var box = p.querySelector('.run-log') || p.querySelector('.big-scroll');
      if (box) box.scrollTop += step * 40;
      return;
    }
    var next = moveIndex(rows.length, r ? rows.indexOf(r) : -1, step);
    if (next >= 0) settle(p, rows[next]);
  }
  function movePane(step) {
    var all = panes();
    paneAt = nextPane(all.length, paneAt, step);
    var p = current();
    settle(p, focusedRow() || rowsOf(p)[0] || null);
  }
  function toPane(n) {
    if (n >= panes().length) return;
    paneAt = n;
    var p = current();
    settle(p, focusedRow() || rowsOf(p)[0] || null);
  }
  function jump(end) {
    var p = current(); if (!p) return;
    var rows = rowsOf(p);
    settle(p, end === 'top' ? rows[0] || null : rows[rows.length - 1] || null);
  }
  function pageRows(p) {
    var rows = rowsOf(p);
    if (rows.length === 0) return 1;
    var h = rows[0].getBoundingClientRect().height || 24;
    var box = p.querySelector('.big-scroll') || p;
    return Math.max(1, Math.floor(box.clientHeight / h));
  }

  // ---- the glance: beside the apps, the focused app at a glance ----
  function glance() {
    var pane = big.querySelector('[data-pane="glance"]');
    if (!pane) return;
    var k = keys['apps'] || '', on = null;
    Array.prototype.forEach.call(pane.querySelectorAll('[data-for]'), function (g) {
      var hit = g.getAttribute('data-for') === k;
      g.hidden = !hit;
      if (hit) on = g;
    });
    var empty = pane.querySelector('.big-glance-empty');
    if (empty) empty.hidden = !!on;
    var note = pane.querySelector('.big-h-note');
    if (note) note.textContent = on ? on.getAttribute('data-name') || '' : '';
  }

  // ---- navigation: a stack of where you came from ----
  function go(url) {
    var stack = recall('big:stack') || [];
    stack.push(where);
    if (stack.length > 30) stack.shift();
    remember('big:stack', stack);
    location.href = url;
  }
  function back() {
    var stack = recall('big:stack') || [];
    var prev = stack.pop();
    remember('big:stack', stack);
    location.href = prev && prev !== where ? prev : big.getAttribute('data-back') || '/big';
  }
  // What a row opens: where it says, else — for a run — its page here,
  // else the link it is or holds.
  function hrefOf(row) {
    if (row.getAttribute('data-href')) return row.getAttribute('data-href');
    var key = row.getAttribute('data-key') || '';
    if (key.indexOf('run:') === 0) return '/big?run=' + encodeURIComponent(key.slice(4));
    if (row.tagName.toLowerCase() === 'a') return row.getAttribute('href');
    var a = row.querySelector('a[href]');
    return a ? a.getAttribute('href') : null;
  }
  function openRow() {
    var r = focusedRow(); if (!r) return;
    var href = hrefOf(r); if (!href) return;
    if (href.indexOf('/big') === 0) go(href); else location.href = href;
  }
  function openWeb() {
    var r = focusedRow();
    var href = r ? r.getAttribute('data-open') || hrefOf(r) : big.getAttribute('data-open');
    if (href && href.indexOf('/big') !== 0) window.open(href, '_blank', 'noopener');
  }

  // ---- actions: a key presses a real control ----
  function hint(text, tone) {
    var el = doc.getElementById('big-hint'); if (!el) return;
    el.textContent = text || '';
    if (tone) el.setAttribute('data-tone', tone); else el.removeAttribute('data-tone');
    if (text) setTimeout(function () { if (el.textContent === text) { el.textContent = ''; el.removeAttribute('data-tone'); } }, 6000);
  }
  function act(key) {
    var r = focusedRow(), p = current();
    var btn = (r && r.querySelector('[data-act="' + key + '"]')) || (p && p.querySelector('.big-h [data-act="' + key + '"], .big-run [data-act="' + key + '"]'));
    if (!btn) return false;
    btn.click();
    return true;
  }
  function post(url, body) {
    return fetch(url, { method: 'POST', body: body, headers: { accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (r) {
        var type = r.headers.get('content-type') || '';
        if (type.indexOf('application/json') !== -1)
          return r.json().then(function (out) { return { ok: !!out.ok, message: out.flash || out.error || (out.ok ? 'done' : 'that could not be done') }; });
        return { ok: r.ok, message: r.ok ? 'done' : 'that could not be done (' + r.status + ')' };
      }, function () { return { ok: false, message: 'the forge could not be reached' }; });
  }
  // A pane's form posts in place; the stream brings what changed. The
  // run's own composer keeps its own script.
  big.addEventListener('submit', function (ev) {
    var form = ev.target;
    if (!form || form.id === 'big-line' || form.id === 'run-steer' || !window.fetch) return;
    ev.preventDefault();
    var body = new FormData(form);
    var pressed = ev.submitter;
    if (pressed && pressed.name) body.append(pressed.name, pressed.value);
    var row = pressed && pressed.closest ? pressed.closest('[data-key]') : null;
    if (row) row.setAttribute('data-busy', '');
    hint('…');
    post(form.getAttribute('action') || where, body).then(function (out) {
      if (row) row.removeAttribute('data-busy');
      hint(out.message, out.ok ? 'success' : 'danger');
    });
  });

  // ---- the line: a command, a filter, or a word ----
  var line = doc.getElementById('big-line');
  var input = doc.getElementById('big-line-in');
  var mark = doc.getElementById('big-line-mark');
  var note = doc.getElementById('big-line-note');
  var mode = null;
  var filters = {};
  function openLine(m, action, placeholder) {
    if (!line || !input) return;
    mode = m;
    line.hidden = false;
    line.setAttribute('data-mode', m);
    line.setAttribute('action', action || '');
    if (mark) mark.textContent = m === 'cmd' ? ':' : m === 'filter' ? '/' : '\\u203a';
    input.value = m === 'filter' ? filters[nameOf(current())] || '' : '';
    input.placeholder = placeholder || '';
    if (note) { note.textContent = ''; note.removeAttribute('data-tone'); }
    input.focus();
  }
  function closeLine() {
    mode = null;
    if (line) line.hidden = true;
    if (input) input.blur();
    var r = focusedRow();
    if (r) r.focus({ preventScroll: true });
  }
  function applyFilter(p) {
    if (!p) return;
    var q = (filters[nameOf(p)] || '').toLowerCase();
    Array.prototype.forEach.call(p.querySelectorAll('[data-key]'), function (row) {
      var hit = q === '' || (row.textContent || '').toLowerCase().indexOf(q) !== -1;
      if (hit) row.removeAttribute('data-filtered'); else row.setAttribute('data-filtered', '');
    });
    var h = p.querySelector('.big-h');
    if (h) h.setAttribute('data-q', q);
    if (!focusedRow()) settle(p, rowsOf(p)[0] || null, false);
  }
  function fail(message) { if (note) { note.textContent = message; note.setAttribute('data-tone', 'danger'); } }
  function submitLine() {
    if (!input) return;
    var text = input.value;
    if (mode === 'cmd') {
      var parsed = parseCommand(text, { app: here || undefined, apps: apps });
      if (parsed.kind === 'go') { closeLine(); go(parsed.url); }
      else if (parsed.kind === 'help') { closeLine(); openHelp(); }
      else if (parsed.kind === 'error') fail(parsed.message);
      else closeLine();
    } else if (mode === 'say') {
      var said = text.trim();
      if (!said) return;
      input.disabled = true;
      post(line.getAttribute('action'), new URLSearchParams({ text: said })).then(function (out) {
        input.disabled = false;
        if (out.ok) { closeLine(); hint(out.message, 'success'); } else { fail(out.message); input.focus(); }
      });
    } else closeLine();
  }
  if (line) line.addEventListener('submit', function (e) { e.preventDefault(); submitLine(); });
  if (input) input.addEventListener('input', function () {
    if (mode !== 'filter') return;
    var p = current();
    filters[nameOf(p)] = input.value;
    applyFilter(p);
  });
  function say() {
    var steer = doc.getElementById('steer-text');
    if (steer) { steer.focus(); return; }
    var r = focusedRow(), p = current();
    var action = (r && r.getAttribute('data-say')) || (p && p.getAttribute('data-say')) || big.getAttribute('data-say');
    if (!action) { hint('nothing here takes a word', 'danger'); return; }
    var who = (r && r.getAttribute('data-say-who')) || (p && p.getAttribute('data-say-who')) || big.getAttribute('data-say-who') || 'the crew';
    openLine('say', action, 'tell ' + who + ' \\u2014 enter sends, esc keeps quiet');
  }

  // ---- the sheet ----
  function openHelp() {
    var dlg = doc.getElementById('big-help');
    if (!dlg || !dlg.showModal) return;
    if (dlg.open) dlg.close(); else dlg.showModal();
  }
  function fullscreen() {
    if (doc.fullscreenElement) { if (doc.exitFullscreen) doc.exitFullscreen(); }
    else if (doc.documentElement.requestFullscreen) doc.documentElement.requestFullscreen().catch(function () {});
  }

  // ---- keys ----
  function chipGo(key) {
    var chip = doc.querySelector('#big-foot [data-k="' + key + '"][data-go]');
    if (!chip) return false;
    go(chip.getAttribute('data-go'));
    return true;
  }
  function handle(key, shift) {
    switch (key) {
      case 'j': case 'ArrowDown': moveRow(1); return true;
      case 'k': case 'ArrowUp': moveRow(-1); return true;
      case 'h': case 'ArrowLeft': movePane(-1); return true;
      case 'l': case 'ArrowRight': movePane(1); return true;
      case 'Tab': movePane(shift ? -1 : 1); return true;
      case 'g': jump('top'); return true;
      case 'G': jump('bottom'); return true;
      case 'ctrl-d': moveRow(halfPage(pageRows(current()))); return true;
      case 'ctrl-u': moveRow(-halfPage(pageRows(current()))); return true;
      case 'Enter': openRow(); return true;
      case 'Escape': case 'Backspace': back(); return true;
      case ':': openLine('cmd', '', 'app <name> \\u00b7 home \\u00b7 board \\u00b7 map \\u00b7 runs \\u00b7 issues \\u00b7 pulls \\u00b7 q'); return true;
      case '/': openLine('filter', '', 'filter this pane as you type'); return true;
      case '?': openHelp(); return true;
      case 'f': fullscreen(); return true;
      case 'o': openWeb(); return true;
      case 't': say(); return true;
      case 's': case 'x': if (!act(key)) hint('nothing focused takes ' + key, 'danger'); return true;
      default:
        if (/^[1-9]$/.test(key)) { toPane(Number(key) - 1); return true; }
        if (/^[a-z]$/.test(key)) return chipGo(key);
        return false;
    }
  }
  function typing(t) { return !!(t && t.matches && t.matches('input, textarea, select, [contenteditable]')); }
  doc.addEventListener('keydown', function (e) {
    if (e.metaKey || e.altKey) return;
    var t = e.target;
    var dlg = doc.querySelector('dialog[open]');
    if (dlg) {
      if (dlg.id === 'big-help' && (e.key === 'Escape' || e.key === '?')) { e.preventDefault(); e.stopPropagation(); dlg.close(); }
      return;
    }
    if (typing(t)) {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        if (mode) closeLine(); else { t.blur(); var r = focusedRow(); if (r) r.focus({ preventScroll: true }); }
      }
      return;
    }
    if (e.ctrlKey) {
      if (e.key === 'd' || e.key === 'u') { e.preventDefault(); e.stopPropagation(); handle('ctrl-' + e.key, false); }
      return;
    }
    if (handle(e.key, e.shiftKey)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  // A click lands the focus where the pointer is; the link or button under
  // it still does its own thing. A tell chip opens the line for its row.
  big.addEventListener('mousedown', function (e) {
    var row = e.target && e.target.closest ? e.target.closest('[data-key]') : null;
    if (!row) return;
    var pane = row.closest('.big-pane');
    var at = panes().indexOf(pane);
    if (at !== -1) { paneAt = at; settle(pane, row, false); }
  });
  big.addEventListener('click', function (e) {
    var chip = e.target && e.target.closest ? e.target.closest('[data-say-open]') : null;
    if (chip) { e.preventDefault(); say(); }
  });

  // ---- the gamepad: the same moves, from the couch ----
  var BTN = { 0: 'Enter', 1: 'Escape', 3: '?', 4: 'h', 5: 'l', 8: '/', 9: ':', 12: 'k', 13: 'j', 14: 'h', 15: 'l' };
  var held = {}, loop = null;
  function fire(k) {
    if (mode) { if (k === 'Escape') closeLine(); else if (k === 'Enter') submitLine(); return; }
    var dlg = doc.querySelector('dialog[open]');
    if (dlg) { if (k === 'Escape' || k === '?') dlg.close(); return; }
    handle(k, false);
  }
  function poll() {
    var list = navigator.getGamepads ? navigator.getGamepads() : [];
    var any = false, now = Date.now();
    for (var i = 0; i < list.length; i++) {
      var gp = list[i]; if (!gp) continue;
      any = true;
      var down = {};
      for (var b = 0; b < gp.buttons.length; b++) if (gp.buttons[b].pressed && BTN[b]) down[BTN[b]] = true;
      var ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
      if (ay < -0.5) down['k'] = true; else if (ay > 0.5) down['j'] = true;
      if (ax < -0.5) down['h'] = true; else if (ax > 0.5) down['l'] = true;
      Object.keys(down).forEach(function (k) {
        var h = held[k];
        if (!h) { held[k] = { next: now + 380 }; fire(k); }
        else if (now >= h.next && 'jkhl'.indexOf(k) !== -1) { h.next = now + 110; fire(k); }
      });
      Object.keys(held).forEach(function (k) { if (!down[k]) delete held[k]; });
    }
    if (any) loop = requestAnimationFrame(poll); else { loop = null; big.removeAttribute('data-pad'); }
  }
  window.addEventListener('gamepadconnected', function () {
    big.setAttribute('data-pad', '');
    if (loop === null) loop = requestAnimationFrame(poll);
  });

  // ---- clocks: the corner, every elapsed, every relative time ----
  var clock = doc.getElementById('big-clock');
  function two(n) { return (n < 10 ? '0' : '') + n; }
  function span(s) {
    return s < 60 ? s + 's'
      : s < 3600 ? Math.floor(s / 60) + 'm ' + two(s % 60) + 's'
      : Math.floor(s / 3600) + 'h ' + two(Math.floor((s % 3600) / 60)) + 'm';
  }
  function ago(s) {
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
    if (s < 86400 * 365) return Math.floor(s / (86400 * 30)) + 'mo ago';
    return Math.floor(s / (86400 * 365)) + 'y ago';
  }
  function tick() {
    var now = Date.now();
    if (clock) {
      var d = new Date(now);
      clock.textContent = two(d.getHours()) + ':' + two(d.getMinutes());
      clock.setAttribute('datetime', d.toISOString());
    }
    Array.prototype.forEach.call(big.querySelectorAll('[data-started]:not(#run-elapsed)'), function (el) {
      var t = Date.parse(el.getAttribute('data-started') || '');
      if (t) el.textContent = span(Math.max(0, Math.round((now - t) / 1000)));
    });
    Array.prototype.forEach.call(big.querySelectorAll('time[datetime]'), function (el) {
      if (el === clock) return;
      var t = Date.parse(el.getAttribute('datetime') || '');
      if (t) el.textContent = ago(Math.max(0, (now - t) / 1000));
    });
  }
  window.setInterval(tick, 1000);
  tick();

  // ---- live: the dot, and a swap that keeps the focus where it was ----
  doc.addEventListener('forge:live', function (e) {
    var live = doc.getElementById('big-live');
    if (live && e.detail) live.setAttribute('data-state', e.detail.state);
  });
  doc.addEventListener('forge:swapped', function (e) {
    var pane = e.target && e.target.closest ? e.target.closest('.big-pane') : null;
    if (pane) {
      applyFilter(pane);
      pane.setAttribute('data-fresh', '');
      window.setTimeout(function () { pane.removeAttribute('data-fresh'); }, 1500);
    }
    paint();
    tick();
    var r = focusedRow(), p = current();
    if (!r && p) settle(p, rowsOf(p)[0] || null, false);
    else if (r && !mode && doc.activeElement !== r && !typing(doc.activeElement)) r.focus({ preventScroll: true });
  });

  // ---- the map pans to where the crew is ----
  (function () {
    var working = big.querySelector('.map-node[data-state="working"]');
    if (!working) return;
    var was = doc.activeElement;
    working.focus({ preventScroll: true });
    if (was && was !== doc.body && was.focus) was.focus({ preventScroll: true }); else working.blur();
  })();

  // ---- restore: the pane and row this tab was on here ----
  (function () {
    var saved = recall('big:' + where);
    if (saved) {
      paneAt = Math.min(saved.pane || 0, Math.max(0, panes().length - 1));
      keys = saved.keys || {};
    }
    var p = current();
    settle(p, focusedRow() || rowsOf(p)[0] || null, false);
  })();
})();
`;
