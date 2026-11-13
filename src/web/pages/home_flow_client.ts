/**
 * The new home's script (`home_flow.ts`): three small jobs on top of the live
 * regions every page already holds (`liveRegionsJs` swaps a lane when an event
 * names it). It runs no timer and no loop: everything here answers an event
 * the stream or the browser already sent.
 *
 *   moving   a tile that changes lane glides from where it was to where it is
 *            (FLIP, Web Animations); a tile that is new arrives with a soft
 *            wash. Nothing moves for a reader who asked for reduced motion.
 *   clocks   every "4m" on the page is redrawn from its own datetime when an
 *            event arrives, a lane is swapped, or the tab comes back: time
 *            spent in a lane is always as old as the last thing that happened.
 *   stream   the dot beside the title says whether the stream is connected.
 *   figures  the section's open or closed state is remembered in this browser.
 *   filter   the select lists the other apps only when it is first used.
 *   reading  a region drawn as "reading…" (the first page after a restart, before the worker
 *            has read the picture) fetches its own address once and takes the answer in place.
 *   table    on the table view: instant search, picking rows, and the action bar
 *            that previews, applies and receipts a bulk action (`home_table.ts`).
 *
 * With scripts off the page is the picture the server drew.
 */
export const homeFlowJs = /* js */ `
(function () {
  var root = document.getElementById('hf');
  if (!root) return;
  var doc = document;
  var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- clocks: the same words the server used (flow/pipeline.ts span) ----
  function span(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm';
    var h = Math.floor(m / 60);
    if (h < 48) return m % 60 === 0 ? h + 'h' : h + 'h ' + (m % 60) + 'm';
    return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  }
  var lastClock = 0;
  function clocks(force) {
    var now = Date.now();
    // Events come in bursts: the clocks are drawn at most every few seconds.
    if (!force && now - lastClock < 4000) return;
    lastClock = now;
    Array.prototype.forEach.call(root.querySelectorAll('time[datetime]'), function (el) {
      var t = Date.parse(el.getAttribute('datetime') || '');
      if (!t) return;
      var text = span(now - t);
      if (el.textContent !== text) el.textContent = text;
    });
  }

  // ---- moving: where every tile was, in page coordinates ----
  var seen = {};
  // A tile is only glided from a place it was seen this recently.
  var FRESH = 15000;
  function place(el) {
    var r = el.getBoundingClientRect();
    return { x: r.left + window.pageXOffset, y: r.top + window.pageYOffset, at: Date.now() };
  }
  function remember() {
    Array.prototype.forEach.call(root.querySelectorAll('.tile[data-key]'), function (el) {
      seen[el.getAttribute('data-key')] = place(el);
    });
  }
  function glide(lane) {
    if (calm || !lane.querySelectorAll || !doc.documentElement.animate) { remember(); return; }
    Array.prototype.forEach.call(lane.querySelectorAll('.tile[data-key]'), function (el) {
      var was = seen[el.getAttribute('data-key')];
      var now = place(el);
      if (was && Date.now() - was.at < FRESH) {
        var dx = was.x - now.x, dy = was.y - now.y;
        if (Math.abs(dx) + Math.abs(dy) < 3) return;
        el.animate(
          [{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'none' }],
          { duration: 320, easing: 'cubic-bezier(.2, 0, 0, 1)' }
        );
      } else if (!was) {
        el.setAttribute('data-new', '');
        el.addEventListener('animationend', function () { el.removeAttribute('data-new'); }, { once: true });
      }
    });
    remember();
  }
  doc.addEventListener('forge:swapped', function (e) {
    var lane = e.target && e.target.closest ? e.target.closest('.lane') : null;
    clocks(true);
    if (lane) glide(lane); else remember();
    toggles();
    afterSwap();
  });
  doc.addEventListener('forge:event', function () { clocks(false); });
  doc.addEventListener('visibilitychange', function () { if (!doc.hidden) clocks(true); });
  window.addEventListener('pageshow', function () { clocks(true); });

  // ---- the dot: whether the stream is connected ----
  var live = doc.getElementById('hf-live');
  var TONES = { open: 'success', reconnecting: 'attn' };
  var WORDS = { open: 'Live: updates as it happens', reconnecting: 'Reconnecting: the picture may be a moment old' };
  doc.addEventListener('forge:live', function (e) {
    if (!live || !e.detail) return;
    live.setAttribute('data-state', e.detail.state);
    var dot = live.querySelector('.dot');
    var text = live.querySelector('.hf-live-text');
    var tone = TONES[e.detail.state];
    if (dot) { if (tone) dot.setAttribute('data-tone', tone); else dot.removeAttribute('data-tone'); }
    if (text && WORDS[e.detail.state]) text.textContent = WORDS[e.detail.state];
  });

  // ---- the filter: the other apps come from data-apps when it is first used, then choosing one opens the page for it ----
  var form = doc.getElementById('hf-filter');
  var select = doc.getElementById('hf-app');
  if (form && select) {
    // Without scripts the select has no name and the typed field is the one that is sent.
    select.name = 'app';
    var filled = false;
    var fill = function () {
      if (filled) return;
      filled = true;
      var current = select.value;
      (select.getAttribute('data-apps') || '').split(',').filter(Boolean).forEach(function (app) {
        if (app === current) return;
        var option = doc.createElement('option');
        option.value = app;
        option.textContent = app;
        select.appendChild(option);
      });
    };
    ['pointerdown', 'focus', 'keydown'].forEach(function (type) { select.addEventListener(type, fill); });
    select.addEventListener('change', function () { form.submit(); });
  }

  // ---- the table: instant search, picking rows, the action bar ----
  var bar = doc.getElementById('tb-bar');
  var afterSwap = function () {};
  if (bar) {
    var catalogue = [];
    try { catalogue = JSON.parse(bar.getAttribute('data-actions') || '[]'); } catch (err) { catalogue = []; }
    var picked = {};
    var note = doc.getElementById('tb-note');
    var search = doc.getElementById('tb-q');
    var list = function (selector) { return Array.prototype.slice.call(doc.querySelectorAll(selector)); };
    var button = function (variant, text) {
      var b = doc.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      if (variant) b.setAttribute('data-variant', variant);
      b.textContent = text;
      return b;
    };
    // What shows is what the search leaves; a swap or a keystroke draws it again.
    var filter = function () {
      var words = (search ? search.value : '').toLowerCase().split(/\s+/).filter(Boolean);
      var shown = 0, total = 0;
      list('#hf-table .tb-row').forEach(function (tr) {
        total++;
        var hay = tr.getAttribute('data-q') || '';
        var ok = words.every(function (w) { return hay.indexOf(w) !== -1; });
        tr.hidden = !ok;
        if (ok) shown++;
      });
      var typed = doc.getElementById('tb-typed');
      if (typed) typed.textContent = words.length ? ' Showing ' + shown + ' of ' + total + ' for what you typed.' : '';
    };
    var sync = function () {
      var here = {};
      list('#hf-table .tb-pick[data-id]').forEach(function (b) { here[b.getAttribute('data-id')] = 1; });
      Object.keys(picked).forEach(function (id) { if (!here[id]) delete picked[id]; });
      list('#hf-table .tb-pick[data-id]').forEach(function (b) { b.setAttribute('aria-checked', picked[b.getAttribute('data-id')] ? 'true' : 'false'); });
      var all = doc.querySelector('#hf-table .tb-all');
      var visible = list('#hf-table .tb-pick[data-id]').filter(function (b) { return !b.closest('tr').hidden; });
      if (all) all.setAttribute('aria-checked', visible.length > 0 && visible.every(function (b) { return picked[b.getAttribute('data-id')]; }) ? 'true' : 'false');
      var ids = Object.keys(picked);
      bar.hidden = ids.length === 0 && !note.firstChild;
      doc.getElementById('tb-picked').textContent = ids.length + ' picked';
      var kinds = {};
      ids.forEach(function (id) { kinds[picked[id]] = 1; });
      var box = doc.getElementById('tb-actions');
      box.textContent = '';
      if (ids.length === 0) return;
      catalogue.forEach(function (a) {
        if (!Object.keys(kinds).every(function (k) { return a.kinds.indexOf(k) !== -1; })) return;
        var b = button('', a.label);
        b.setAttribute('data-op', a.op);
        b.title = a.hint;
        box.appendChild(b);
      });
    };
    var say = function (text, more) {
      note.textContent = '';
      var p = doc.createElement('p');
      p.textContent = text;
      note.appendChild(p);
      if (more) more(note);
      sync();
    };
    var send = function (op, phase, reason) {
      var body = new URLSearchParams();
      body.append('op', op);
      body.append('phase', phase);
      if (reason) body.append('reason', reason);
      Object.keys(picked).forEach(function (id) { body.append('ids', id); });
      return fetch('/home/act', { method: 'POST', body: body, credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .catch(function () { return { ok: false, error: 'The forge did not answer.' }; });
    };
    var ask = function (op) {
      var action = catalogue.filter(function (x) { return x.op === op; })[0];
      if (!action) return;
      say('Checking each row first…');
      send(op, 'preview').then(function (r) {
        if (!r.ok) { say(r.error || 'That did not work.'); return; }
        say(r.summary, function (box) {
          if (r.refused && r.refused.length) {
            var ul = doc.createElement('ul');
            r.refused.forEach(function (x) { var li = doc.createElement('li'); li.textContent = x.label + ': ' + x.why; ul.appendChild(li); });
            box.appendChild(ul);
          }
          var why = null;
          if (action.reason) {
            why = doc.createElement('input');
            why.className = 'input';
            why.maxLength = 300;
            why.placeholder = 'Why (optional, one sentence)';
            why.setAttribute('aria-label', 'Why');
          }
          var row = doc.createElement('div');
          row.className = 'tb-confirm';
          if (why) row.appendChild(why);
          if (r.willChange > 0) {
            var go = button('primary', action.label + ' ' + r.willChange);
            go.addEventListener('click', function () {
              go.disabled = true;
              send(op, 'apply', why ? why.value : '').then(function (d) {
                picked = {};
                say(d.ok ? d.summary : (d.error || 'That did not work.'), function (b) {
                  if (d.ok && d.receipt) { var a = doc.createElement('a'); a.href = d.receipt; a.textContent = 'Receipt'; b.appendChild(a); }
                });
              });
            });
            row.appendChild(go);
          }
          var cancel = button('', 'Cancel');
          cancel.addEventListener('click', function () { note.textContent = ''; sync(); });
          row.appendChild(cancel);
          box.appendChild(row);
        });
      });
    };
    doc.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target : null;
      if (!t) return;
      var pick = t.closest('.tb-pick');
      if (pick) {
        if (pick.classList.contains('tb-all')) {
          var on = pick.getAttribute('aria-checked') !== 'true';
          list('#hf-table .tb-pick[data-id]').forEach(function (b) {
            if (b.closest('tr').hidden) return;
            if (on) picked[b.getAttribute('data-id')] = b.getAttribute('data-kind'); else delete picked[b.getAttribute('data-id')];
          });
        } else {
          var id = pick.getAttribute('data-id');
          if (picked[id]) delete picked[id]; else picked[id] = pick.getAttribute('data-kind');
        }
        note.textContent = '';
        sync();
        return;
      }
      var op = t.closest('[data-op]');
      if (op && bar.contains(op)) { ask(op.getAttribute('data-op')); return; }
      if (t.closest('#tb-clear')) { picked = {}; note.textContent = ''; sync(); }
    });
    if (search) search.addEventListener('input', function () { filter(); sync(); });
    afterSwap = function () { filter(); sync(); };
    filter();
    sync();
  }

  // ---- before the first reading: each "reading…" region asks for itself once, and takes the answer in place ----
  Array.prototype.forEach.call(root.querySelectorAll('[data-reading]'), function (region) {
    var src = region.getAttribute('data-live-src');
    if (!src || !window.fetch) return;
    fetch(src, { credentials: 'same-origin', headers: { accept: 'text/html' } })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (text) {
        var holder = doc.createElement('template');
        holder.innerHTML = text;
        var fresh = holder.content.querySelector('#' + region.id);
        if (!fresh || fresh.hasAttribute('data-reading')) return;
        region.innerHTML = fresh.innerHTML;
        Array.prototype.forEach.call(fresh.attributes, function (a) { if (a.name !== 'id') region.setAttribute(a.name, a.value); });
        region.removeAttribute('data-reading');
        region.removeAttribute('aria-busy');
        region.dispatchEvent(new CustomEvent('forge:swapped', { bubbles: true }));
      })
      .catch(function () {});
  });

  // ---- the figures: open or closed, as this reader left it ----
  var figures = doc.getElementById('hf-figures');
  if (figures) {
    try { if (window.localStorage.getItem('forge.home.figures') === 'closed') figures.open = false; } catch (err) { /* no storage: the page's default */ }
    figures.addEventListener('toggle', function () {
      try { window.localStorage.setItem('forge.home.figures', figures.open ? 'open' : 'closed'); } catch (err) { /* nothing to remember with */ }
    });
  }

  // ---- a lane on a phone: Show all N opens it in place; the lane keeps data-open through every redraw ----
  var toggles = function () {
    Array.prototype.forEach.call(root.querySelectorAll('.lane'), function (lane) {
      var button = lane.querySelector('.lane-toggle');
      if (!button) return;
      var open = lane.hasAttribute('data-open');
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      button.textContent = open ? 'Show fewer' : 'Show all ' + button.getAttribute('data-all');
    });
  };
  root.setAttribute('data-js', '');
  doc.addEventListener('click', function (e) {
    var button = e.target && e.target.closest ? e.target.closest('.lane-toggle') : null;
    if (!button) return;
    var lane = button.closest('.lane');
    if (lane.hasAttribute('data-open')) lane.removeAttribute('data-open'); else lane.setAttribute('data-open', '');
    toggles();
  });
  toggles();

  remember();
  clocks(true);
})();
`;
