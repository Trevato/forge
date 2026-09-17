/**
 * The shell's progressive enhancement, as static source. Every line here is
 * optional: menus are `<details>`, the palette is a link away, the theme is a
 * form, and a shortcut is a shorthand for a link that already exists. Runtime
 * data never reaches this string — it arrives through `data-*` attributes and
 * one `<script type="application/json">` block, which the HTML parser treats
 * as data and never executes.
 *
 * Kept deliberately small and readable: no framework, no build step, and no
 * behaviour that a page depends on to be usable.
 */

import { paletteHelpersJs } from "./palette.ts";

/**
 * A native `<dialog>` opened as a modal that owns its Escape. Shared by the
 * scripts that open one (the palette, the help, the finder), because the
 * leak is the same for each: a `showModal()` dialog closes on Escape through
 * the browser's default action, and the *keydown itself* is left unhandled —
 * which a fullscreen browser window on macOS reads as "leave fullscreen".
 * So Escape is consumed on keydown and the dialog is closed by hand; the
 * dialog's own `cancel` is caught the same way for the browsers that raise
 * it regardless. Nothing is listened for while the dialog is closed, and on
 * close the focus goes back to where it was.
 *
 * Returns `close`, which is safe to call more than once.
 */
const modalJs = /* js */ `
  function openModal(dlg, onClose) {
    var was = document.activeElement;
    var done = false;
    function onKey(e) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    }
    function onCancel(e) { e.preventDefault(); close(); }
    function close() {
      if (done) return;
      done = true;
      dlg.removeEventListener('keydown', onKey);
      dlg.removeEventListener('cancel', onCancel);
      dlg.removeEventListener('close', close);
      if (dlg.open) dlg.close();
      if (onClose) onClose();
      if (was && was.focus && document.contains(was)) { try { was.focus(); } catch (_) {} }
    }
    dlg.addEventListener('keydown', onKey);
    dlg.addEventListener('cancel', onCancel);
    dlg.addEventListener('close', close);
    dlg.showModal();
    return close;
  }
`;

/**
 * The device-code page's only enhancement: submit the "check again" form on
 * the interval the provider asked for, and reload when the flow stops being
 * pending. Everything it does is something the page already offers a button
 * for, and the poll route answers JSON only because it was asked to — the
 * same POST from a plain form gets a redirect.
 *
 * Shipped per page (`PageOptions.scriptJs`) rather than in the shell: a page
 * with no connect in flight should carry none of it.
 */
export const pollJs = /* js */ `
(function () {
  var form = document.querySelector('form[data-poll]');
  if (!form) return;
  var every = Number(form.getAttribute('data-poll') || 0);
  if (!every) return;
  var tries = 0;
  function ask() {
    if (tries++ > 200) return;
    fetch(form.getAttribute('action') || location.href, {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: new FormData(form),
    }).then(function (r) { return r.json(); }).then(function (out) {
      if (out && out.status && out.status !== 'pending') { location.reload(); return; }
      window.setTimeout(ask, every * 1000);
    }, function () { window.setTimeout(ask, every * 1000); });
  }
  window.setTimeout(ask, every * 1000);
})();
`;

/**
 * The studio's asks panel acts in place. A row's button, or the bar's for
 * several, posts exactly the form it would have — the route answers JSON
 * because it was asked to, and a redirect with a flash otherwise. While it
 * runs, the rows it is about look busy; when it lands they go, since an
 * ask decided is no longer an ask; a refusal restores the row with the
 * reason on it. The bar's count is the same script's small extra.
 *
 * Scripts off: the same post, a redirect, the same page without the row.
 */
export const asksJs = /* js */ `
(function () {
  var panel = document.querySelector('.studio-asks');
  if (!panel) return;
  var count = panel.querySelector('.studio-bulk-count');
  function tally() {
    if (count) count.textContent = panel.querySelectorAll('[name="ask"]:checked').length + ' selected';
  }
  panel.addEventListener('change', tally);
  tally();

  function rowOf(el) { return el ? el.closest('li') : null; }
  function idOf(li) { var pick = li.querySelector('[name="ask"]'); return pick ? pick.value : ''; }
  // The rows a form is about: the checked ones for the bar's form, the one
  // whose button names the form for a row's own.
  function rowsFor(form) {
    if (form.getAttribute('action') === '/studio/asks')
      return Array.prototype.map.call(panel.querySelectorAll('[name="ask"]:checked'), rowOf);
    var button = form.id ? panel.querySelector('[form="' + form.id + '"]') : null;
    return button ? [rowOf(button)] : [];
  }
  function busy(rows, on) {
    rows.forEach(function (li) {
      if (on) li.setAttribute('data-busy', ''); else li.removeAttribute('data-busy');
      li.querySelectorAll('button').forEach(function (b) { b.disabled = on; });
    });
    panel.querySelectorAll('.studio-bulk button').forEach(function (b) { b.disabled = on; });
  }
  function note(li, text) {
    var old = li.querySelector('.studio-ask-note');
    if (old) old.remove();
    if (!text) return;
    var span = document.createElement('span');
    span.className = 'row-meta studio-ask-note';
    span.textContent = text;
    li.querySelector('.row-main').appendChild(span);
  }
  function toast(text) {
    var main = document.getElementById('main');
    if (!main) return;
    var old = main.querySelector(':scope > .toast');
    if (old) old.remove();
    var el = document.createElement('div');
    el.className = 'toast'; el.setAttribute('data-tone', 'success'); el.setAttribute('role', 'status');
    var body = document.createElement('div');
    body.className = 'toast-body'; body.textContent = text;
    el.appendChild(body);
    main.insertBefore(el, main.firstChild);
  }
  // A decided ask is not an ask: the row goes, the app's "n asks you" on
  // the home follows, and the panel itself when nothing is left.
  function drop(li) {
    var pick = li.querySelector('[name="ask"]');
    var base = pick ? pick.getAttribute('data-repo') : null;
    li.remove();
    var pill = base ? document.querySelector('a.row[href="' + base + '"] .pill') : null;
    if (pill) {
      var n = parseInt(pill.textContent, 10) - 1;
      if (n > 0) pill.textContent = n + ' asks you'; else pill.remove();
    }
    if (panel.querySelector('li')) tally(); else panel.remove();
  }

  panel.addEventListener('submit', function (event) {
    var form = event.target;
    var rows = rowsFor(form);
    if (rows.length === 0) return;
    event.preventDefault();
    var body = new FormData(form);
    var pressed = event.submitter;
    if (pressed && pressed.name) body.append(pressed.name, pressed.value);
    var verb = pressed ? (pressed.name === 'action' ? pressed.value : pressed.textContent.trim().toLowerCase()) : 'do that';
    rows.forEach(function (li) { note(li, ''); });
    busy(rows, true);
    fetch(form.getAttribute('action') || location.href, { method: 'POST', headers: { accept: 'application/json' }, body: body })
      .then(function (r) {
        return r.json().catch(function () { return { ok: false, error: 'That could not be done (' + r.status + ').' }; });
      })
      .then(function (out) {
        var byId = {};
        rows.forEach(function (li) { byId[idOf(li)] = li; });
        var done = out.done || (out.ok ? Object.keys(byId) : []);
        done.forEach(function (id) { if (byId[id]) { drop(byId[id]); delete byId[id]; } });
        var left = Object.keys(byId).map(function (id) { return byId[id]; });
        busy(left, false);
        left.forEach(function (li) {
          var skipped = out.skipped && out.skipped.indexOf(idOf(li)) !== -1;
          note(li, skipped ? 'Skipped: not one that takes that now.' : (out.error || 'Could not ' + verb + '.'));
        });
        if (out.flash) toast(out.flash);
      }, function () {
        busy(rows, false);
        rows.forEach(function (li) { note(li, 'The forge could not be reached.'); });
      });
  });
})();
`;

/**
 * A mirror in flight, live. The page already renders the checklist and
 * already refreshes itself every two seconds without a script; this replaces
 * that poll with the job's own event stream, so a stage lands the instant it
 * happens and the page never reloads under a reader.
 *
 * The stream URL and the stage order come out of the DOM — this string never
 * carries runtime data, which is what lets it ship under a strict CSP as a
 * static, nonce'd script.
 */
export const mirrorJs = /* js */ `
(function () {
  var list = document.getElementById('stages');
  if (!list || typeof EventSource === 'undefined') return;
  var url = list.getAttribute('data-stream');
  if (!url) return;
  // The no-JS fallback and this cannot both be running: a meta refresh two
  // seconds from now would throw away everything the stream has painted.
  var meta = document.querySelector('meta[http-equiv="refresh"]');
  if (meta && !/url=/i.test(meta.getAttribute('content') || '')) meta.remove();

  var rows = Array.prototype.slice.call(list.querySelectorAll('li[data-stage-name]'));
  var order = rows.map(function (li) { return li.getAttribute('data-stage-name'); });
  var glyph = { done: '\\u25CF', now: '\\u25D0', failed: '\\u2715', todo: '\\u25CB' };

  function paint(stage, detail) {
    list.setAttribute('data-stage', stage);
    var there = order.indexOf(stage);
    rows.forEach(function (li, i) {
      var state = stage === 'failed' ? 'todo'
        : i < there ? 'done'
        : i === there ? (stage === 'done' ? 'done' : 'now')
        : 'todo';
      li.setAttribute('data-state', state);
      var dot = li.querySelector('.stage-dot');
      if (dot) dot.textContent = glyph[state];
      var note = li.querySelector('.stage-detail');
      if (note) note.textContent = state === 'now' ? (detail || '') : '';
    });
  }

  var source = new EventSource(url);
  source.addEventListener('error', function () { /* the meta refresh, or the next event */ });
  ['creating', 'fetching', 'labels', 'issues', 'pulls', 'comments', 'done', 'failed'].forEach(function (stage) {
    source.addEventListener('mirror.' + stage, function (event) {
      var job;
      try { job = JSON.parse(event.data); } catch (err) { return; }
      paint(job.stage, job.detail);
      if (job.stage === 'done' && job.repo) {
        source.close();
        location.href = '/' + job.repo.ownerName + '/' + job.repo.name;
      } else if (job.stage === 'failed') {
        // The page for a failed job carries the reason and a way to retry,
        // and does not stream — so this loads it once, and stops.
        source.close();
        location.replace(location.pathname + location.search);
      }
    });
  });
})();
`;

/**
 * A run's log, live. The page renders every line already written and, for
 * a run still going, refreshes itself without a script; this replaces that
 * poll with the log's own event stream, so a line lands the moment it is
 * written and the page never reloads under a reader. The stream replays
 * what the page already shows, so the first line clears the pre and the
 * tail is exact. Auto-scroll follows the bottom until the reader scrolls
 * up, and resumes when they come back down.
 */
export const runLogJs = /* js */ `
(function () {
  var log = document.getElementById('run-log');
  if (!log) return;
  var url = log.getAttribute('data-stream');
  var who = log.getAttribute('data-who') || 'agent';
  var pulse = document.getElementById('run-pulse');
  var jump = document.getElementById('run-jump');
  var state = document.getElementById('run-state');
  var summary = document.getElementById('run-summary');
  var cancel = document.getElementById('run-cancel');
  var stop = document.getElementById('run-stop');
  var steer = document.getElementById('run-steer');
  var live = document.getElementById('run-live');

  // Following: the transcript keeps to its end until the reader scrolls up,
  // and a pill offers the way back down when more arrives meanwhile.
  var follow = true;
  function atEnd() { return log.scrollTop + log.clientHeight >= log.scrollHeight - 12; }
  function toEnd() { log.scrollTop = log.scrollHeight; follow = true; if (jump) jump.hidden = true; }
  log.addEventListener('scroll', function () { follow = atEnd(); if (follow && jump) jump.hidden = true; });
  if (jump) jump.addEventListener('click', toEnd);
  // The transcript takes the room between its top and the composer, so the
  // page itself never scrolls while a run goes.
  function fit() {
    var room = window.innerHeight - log.getBoundingClientRect().top - (steer ? steer.offsetHeight : 0) - 16;
    if (room > 240) log.style.maxHeight = room + 'px';
    if (follow) toEnd();
  }
  window.addEventListener('resize', fit);
  fit();

  var words = {
    queued: ['Queued', 'secondary'], running: ['Running', 'attn'],
    ok: ['Passed', 'success'], failed: ['Failed', 'danger'], cancelled: ['Cancelled', 'outline'],
  };
  function money(n) { return n < 0.01 ? '<$0.01' : '$' + n.toFixed(2); }
  function paint(run) {
    if (state) {
      var look = words[run.state];
      var badge = state.querySelector('.badge') || state;
      if (look) {
        badge.setAttribute('data-variant', look[1]);
        badge.textContent = run.state === 'ok' && run.kind === 'agent' ? 'Done' : look[0];
      }
    }
    if (live) live.setAttribute('data-state', run.state);
    if (summary && run.summary) summary.textContent = run.summary;
    var cost = document.getElementById('run-cost');
    if (cost && typeof run.costUsd === 'number' && run.costUsd > 0) { cost.textContent = money(run.costUsd) + ' spent'; cost.hidden = false; }
    var turns = document.getElementById('run-turns');
    if (turns && typeof run.turns === 'number' && run.turns > 0) { turns.textContent = run.turns + (run.turns === 1 ? ' turn' : ' turns'); turns.hidden = false; }
    if (cancel) cancel.hidden = true;
    if (stop) stop.hidden = true;
    if (pulse && pulse.parentNode) pulse.parentNode.removeChild(pulse);
    var elapsed = document.getElementById('run-elapsed');
    if (elapsed && !elapsed.getAttribute('data-finished')) elapsed.setAttribute('data-finished', new Date().toISOString());
  }

  var FORGE = /^(claude:|done:|failed:|paused|declined:|cloning |branch |forked |pushing |push refused|clone kept|nothing to propose|opened pull|updated pull|committed the|could not|checking out|deploy |data: |\\$ |session |the session|interrupted|passed in|install |test |start |ready |process )/;
  // The same sorting the page did for the lines it rendered: a speaker
  // column and the words, so a reader can tell who said what at a glance.
  function line(kind, speaker, fill) {
    var el = document.createElement('div');
    el.className = 'ln ln-' + kind;
    var w = document.createElement('span');
    w.className = 'who';
    w.textContent = speaker;
    var t = document.createElement('span');
    t.className = 'txt';
    fill(t);
    el.appendChild(w);
    el.appendChild(t);
    return el;
  }
  function draw(text) {
    if (text.indexOf('you: ') === 0) return line('you', 'you', function (t) { t.textContent = text.slice(5); });
    if (text.indexOf('→ ') === 0) {
      var rest = text.slice(2), at = rest.indexOf(' ');
      return line('tool', '', function (t) {
        var b = document.createElement('b');
        b.textContent = at === -1 ? rest : rest.slice(0, at);
        t.appendChild(b);
        t.appendChild(document.createTextNode(at === -1 ? '' : ' ' + rest.slice(at + 1)));
      });
    }
    if (FORGE.test(text)) return line('forge', 'forge', function (t) { t.textContent = text; });
    return line('say', who, function (t) { t.textContent = text; });
  }
  function add(el) {
    log.insertBefore(el, pulse && pulse.parentNode === log ? pulse : jump);
    if (follow) toEnd(); else if (jump) jump.hidden = false;
  }

  // The clock: elapsed time ticks while the run goes, and stops at "took".
  function tick() {
    var elapsed = document.getElementById('run-elapsed');
    if (!elapsed) return;
    var started = Date.parse(elapsed.getAttribute('data-started') || '');
    if (!started) return;
    var finished = Date.parse(elapsed.getAttribute('data-finished') || '');
    var end = finished || Date.now();
    var s = Math.max(0, Math.round((end - started) / 1000));
    var text = s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    elapsed.textContent = (finished ? 'took ' : 'running for ') + text;
  }
  var clock = window.setInterval(tick, 1000);
  tick();

  // Steering without a reload: Enter sends, Shift+Enter breaks a line, the
  // words go to the API, and the line the forge writes for them arrives on
  // the stream like any other. Stop is the same form, posted as it is.
  if (steer && window.fetch) {
    var text = steer.querySelector('textarea');
    function size() { if (!text) return; text.style.height = 'auto'; text.style.height = Math.min(160, text.scrollHeight) + 'px'; fit(); }
    if (text) {
      text.addEventListener('input', size);
      text.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); if (steer.requestSubmit) steer.requestSubmit(); else steer.submit(); }
      });
      size();
    }
    steer.addEventListener('submit', function (ev) {
      if (ev.submitter && ev.submitter.id === 'run-stop') return;
      var api = steer.getAttribute('data-api');
      if (!text || !api || steer.getAttribute('data-running') !== '1') return;
      ev.preventDefault();
      var said = text.value.trim();
      if (!said) return;
      text.disabled = true;
      fetch(api, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ text: said }) })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(r); })
        .then(function (out) {
          text.value = '';
          size();
          var note = document.getElementById('run-steer-note');
          if (note) note.textContent = out.outcome === 'sent' ? 'Heard at its next step. Every word is kept in the log.' : 'Nobody was listening; it went on the conversation.';
        })
        .catch(function () { steer.submit(); })
        .then(function () { text.disabled = false; text.focus(); });
    });
  }

  if (!url || typeof EventSource === 'undefined') return;
  var meta = document.querySelector('meta[http-equiv="refresh"]');
  if (meta && !/url=/i.test(meta.getAttribute('content') || '')) meta.remove();
  var source = new EventSource(url);
  var empty = document.getElementById('run-empty');
  var seeded = false;
  source.addEventListener('line', function (event) {
    // The first line of a fresh stream is the log from the top: start
    // clean. A reconnect carries on from the last line seen, and appends.
    if (!seeded) {
      if (event.lastEventId === '1') {
        Array.prototype.slice.call(log.querySelectorAll('.ln:not(#run-pulse)')).forEach(function (el) { log.removeChild(el); });
      }
      seeded = true;
      if (empty) empty.hidden = true;
    }
    // A line travels as a JSON string, so a tab or a quote survives the wire.
    var text = event.data;
    try { var parsed = JSON.parse(text); if (typeof parsed === 'string') text = parsed; } catch (err) {}
    add(draw(text));
  });
  source.addEventListener('done', function (event) {
    source.close();
    var run;
    try { run = JSON.parse(event.data); } catch (err) { return; }
    paint(run);
    if (steer) {
      steer.setAttribute('data-running', '0');
      var n = document.getElementById('run-steer-note');
      if (n) n.textContent = 'The run is over; this goes on the conversation and starts a run.';
      var t = steer.querySelector('textarea');
      if (t) t.placeholder = 'Tell ' + who + ' for its next run';
    }
    window.clearInterval(clock);
    tick();
  });
})();
`;

/**
 * The code browser: the explorer column, the preview it paints beside itself,
 * and the fuzzy file finder.
 *
 * Everything here is an accelerant on something the page already does. The
 * explorer's links are real links; the preview is a fetch of the very blob
 * route those links point at, rendered by the same server template, so a
 * preview and a navigation produce identical markup. A folder the server did
 * not expand already carries a link to its own page; the script replaces that
 * link with the folder's contents. The finder is a dialog over the JSON the
 * \`paths\` route serves — with no script, the column beside it is the finder.
 *
 * Keyboard: \`j\`/\`k\`, \`enter\` and \`o\` are the shell's own row traversal (the
 * explorer's files are \`data-nav\` rows), and \`t\`/\`e\` are \`data-shortcut\`
 * attributes on real controls. This file adds no key handler of its own — it
 * listens for focus, so arrowing a file and hovering one do the same thing.
 */
export const codeJs = /* js */ `
(function () {
  var doc = document;
  ${modalJs}
  var cfg = doc.getElementById('code');
  if (!cfg || typeof fetch === 'undefined') return;
  var nav = doc.querySelector('.explorer');
  var main = doc.getElementById('code-main');

  // ---- preview ----
  if (nav && main) {
  var cache = new Map(); var order = [];
  var inflight = null; var hoverTimer = 0; var showing = '';

  function remember(url, text) {
    cache.set(url, text); order.push(url);
    while (order.length > 40) { var old = order.shift(); if (old !== url) cache.delete(old); }
  }
  function mark(link) {
    nav.querySelectorAll('.ex-file[data-previewing]').forEach(function (a) {
      a.removeAttribute('data-previewing');
    });
    if (link) link.setAttribute('data-previewing', '');
  }
  function preview(link) {
    if (!main) return;
    var url = link.getAttribute('href');
    if (!url || url === showing) { mark(link); return; }
    mark(link);
    var at = url + (url.indexOf('?') === -1 ? '?' : '&') + 'fragment=1';
    if (cache.has(at)) { main.innerHTML = cache.get(at); showing = url; return; }
    if (inflight) inflight.abort();
    var ctl = new AbortController();
    inflight = ctl;
    main.setAttribute('aria-busy', 'true');
    fetch(at, { signal: ctl.signal, headers: { accept: 'text/html' } })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (text) {
        if (ctl.signal.aborted) return;
        main.removeAttribute('aria-busy');
        if (!text) return;
        remember(at, text);
        // Our own server-rendered markup, escaped where it was built.
        main.innerHTML = text;
        showing = url;
      }, function () { if (!ctl.signal.aborted) main.removeAttribute('aria-busy'); });
  }
  nav.addEventListener('focusin', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('.ex-file') : null;
    if (a) preview(a);
  });
  nav.addEventListener('pointerover', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('.ex-file') : null;
    window.clearTimeout(hoverTimer);
    if (!a) return;
    hoverTimer = window.setTimeout(function () { preview(a); }, 140);
  });
  nav.addEventListener('pointerleave', function () { window.clearTimeout(hoverTimer); });
  }

  // ---- a folder the server did not expand fills itself in ----
  if (nav) nav.addEventListener('toggle', function (e) {
    var d = e.target;
    if (!d || !d.matches || !d.matches('details.ex-dir[open]')) return;
    var stub = d.querySelector('ul[data-stub]');
    var url = d.getAttribute('data-url');
    if (!stub || !url || stub.parentNode !== d) return;
    stub.removeAttribute('data-stub');
    fetch(url + '?fragment=explorer', { headers: { accept: 'text/html' } })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (text) {
        if (!text) return;
        var holder = doc.createElement('div');
        holder.innerHTML = text;
        var list = holder.querySelector('ul.ex-list');
        if (list && stub.parentNode === d) d.replaceChild(list, stub);
      }, function () { stub.setAttribute('data-stub', ''); });
  }, true);

  // ---- fuzzy file finder ----
  // fzf's FuzzyMatchV2 constants under its \`path\` scheme, plus VS Code's
  // basename tiering: any hit inside a file's own name outranks any hit that
  // only lands in its directories, however good.
  var SCORE_MATCH = 16, GAP = -1, B_BOUNDARY = 8, B_NONWORD = 8;
  var B_CAMEL = 7, B_CONSEC = 4, B_DELIM = 9, FIRST_MULT = 2;
  var TIER_BASENAME = 1 << 16, TIER_PREFIX = 1 << 17;
  var NEG = -1e7;
  var WHITE = 0, NONWORD = 1, DELIM = 2, LOWER = 3, UPPER = 4, DIGIT = 5;

  function classOf(c) {
    if (c === 47) return DELIM;            // '/'
    if (c === 32 || c === 9) return WHITE;
    if (c >= 97 && c <= 122) return LOWER;
    if (c >= 65 && c <= 90) return UPPER;
    if (c >= 48 && c <= 57) return DIGIT;
    return NONWORD;
  }
  function bonusFor(prev, cur) {
    if (prev === DELIM) return B_DELIM;
    if (prev === WHITE) return B_BOUNDARY;
    if (prev === NONWORD) return B_NONWORD;
    if (prev === LOWER && cur === UPPER) return B_CAMEL;
    if (prev !== DIGIT && cur === DIGIT) return B_CAMEL;
    return 0;
  }
  function maskOf(s) {
    var m = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 97 && c <= 122) m |= 1 << (c - 97);
      else if (c >= 48 && c <= 57) m |= 1 << 26;
      else m |= 1 << 27;
    }
    return m;
  }
  function subsequence(text, pat, from) {
    var j = from || 0;
    for (var i = 0; i < pat.length; i++) {
      var c = pat.charCodeAt(i);
      while (j < text.length && text.charCodeAt(j) !== c) j++;
      if (j >= text.length) return -1;
      j++;
    }
    return j;
  }
  // fzy's affine-gap DP on one row, with fzf's bonuses. Enough to rank; we
  // never reconstruct the path of the match, only its score.
  function score(text, lower, pat) {
    var n = lower.length, m = pat.length;
    if (m === 0 || m > n) return NEG;
    var bonus = new Int16Array(n);
    var prev = DELIM;                       // the path scheme starts at a '/'
    for (var j = 0; j < n; j++) {
      var cls = classOf(text.charCodeAt(j));
      bonus[j] = bonusFor(prev, cls);
      prev = cls;
    }
    var D = new Float64Array(n), M = new Float64Array(n);
    var pD = new Float64Array(n), pM = new Float64Array(n);
    for (var i = 0; i < m; i++) {
      var run = NEG;
      var pc = pat.charCodeAt(i);
      for (var k = 0; k < n; k++) {
        if (lower.charCodeAt(k) === pc) {
          var s = NEG;
          if (i === 0) s = k * GAP + bonus[k] * FIRST_MULT;
          else if (k > 0) {
            var b = bonus[k];
            var consec = pD[k - 1] + (b > B_CONSEC ? b : B_CONSEC);
            var fresh = pM[k - 1] + b;
            s = consec > fresh ? consec : fresh;
          }
          if (s > NEG) s += SCORE_MATCH;
          D[k] = s;
          run = run + GAP > s ? run + GAP : s;
          M[k] = run;
        } else {
          D[k] = NEG;
          run = run + GAP;
          M[k] = run;
        }
      }
      pD.set(D); pM.set(M);
    }
    return pM[n - 1];
  }

  var dlg = doc.getElementById('finder');
  var pathsUrl = cfg.getAttribute('data-paths') || '';
  var repoBase = cfg.getAttribute('data-base') || '';
  var repoRef = cfg.getAttribute('data-ref') || '';
  var index = null; var indexNote = '';

  function buildIndex(paths, truncated) {
    var rows = [];
    for (var i = 0; i < paths.length; i++) {
      var p = String(paths[i]);
      var lower = p.toLowerCase();
      var cut = p.lastIndexOf('/');
      rows.push({ p: p, l: lower, mask: maskOf(lower), b: cut + 1 });
    }
    indexNote = (truncated ? 'first ' : '') + rows.length + ' files';
    return rows;
  }
  function ensureIndex() {
    if (index) return Promise.resolve(index);
    if (!pathsUrl) return Promise.resolve([]);
    return fetch(pathsUrl, { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : { paths: [] }; })
      .then(function (out) {
        index = buildIndex(out.paths || [], out.truncated === true);
        return index;
      }, function () { index = []; return index; });
  }

  var MAX_SCORED = 6000, MAX_SHOWN = 50;
  function search(rows, query) {
    var q = query.replace(/\\s+/g, '').toLowerCase();
    if (q === '') return rows.slice(0, MAX_SHOWN).map(function (r) { return { r: r, s: 0 }; });
    var qm = maskOf(q);
    var out = [];
    var scored = 0;
    for (var i = 0; i < rows.length && scored < MAX_SCORED; i++) {
      var r = rows[i];
      if ((r.mask & qm) !== qm) continue;
      if (subsequence(r.l, q, 0) === -1) continue;
      scored++;
      var s = score(r.p, r.l, q);
      // The tier, not the score, is what makes a finder feel right.
      if (subsequence(r.l, q, r.b) !== -1) {
        s += TIER_BASENAME;
        if (r.l.lastIndexOf(q, r.b) === r.b) s += TIER_PREFIX;
      }
      out.push({ r: r, s: s });
    }
    out.sort(function (a, b) { return b.s - a.s || a.r.p.length - b.r.p.length; });
    return out.slice(0, MAX_SHOWN);
  }

  function fileUrl(path) {
    var parts = String(path).split('/').map(encodeURIComponent).join('/');
    return repoBase + '/blob/' + encodeURIComponent(repoRef) + '/' + parts;
  }

  function openFinder() {
    if (!dlg || !dlg.showModal) { location.href = repoBase + '/tree/' + encodeURIComponent(repoRef); return; }
    var input = dlg.querySelector('.palette-input');
    var list = dlg.querySelector('.palette-list');
    var note = dlg.querySelector('.finder-note');
    var at = 0;

    function render(rows) {
      var hits = search(rows, input.value);
      at = 0;
      list.textContent = '';
      if (note) note.textContent = indexNote;
      if (hits.length === 0) {
        var p = doc.createElement('p');
        p.className = 'palette-empty';
        p.textContent = rows.length === 0 ? 'No file list for this ref.' : 'No file matches.';
        list.appendChild(p);
        return;
      }
      hits.forEach(function (hit, n) {
        var a = doc.createElement('a');
        a.className = 'palette-item';
        a.setAttribute('role', 'option');
        a.setAttribute('href', fileUrl(hit.r.p));
        if (n === 0) a.setAttribute('aria-selected', 'true');
        var name = doc.createElement('span');
        name.className = 'grow';
        name.textContent = hit.r.p.slice(hit.r.b);
        var dir = doc.createElement('span');
        dir.className = 'cat';
        dir.textContent = hit.r.b === 0 ? '' : hit.r.p.slice(0, hit.r.b - 1);
        a.appendChild(name); a.appendChild(dir);
        list.appendChild(a);
      });
    }
    function select(n) {
      var nodes = list.querySelectorAll('.palette-item');
      if (nodes.length === 0) return;
      at = (n + nodes.length) % nodes.length;
      nodes.forEach(function (el, i) { el.setAttribute('aria-selected', i === at ? 'true' : 'false'); });
      nodes[at].scrollIntoView({ block: 'nearest' });
    }

    input.value = '';
    list.textContent = '';
    if (note) note.textContent = 'loading…';
    openModal(dlg);
    input.focus();
    ensureIndex().then(function (rows) {
      render(rows);
      input.oninput = function () { render(rows); };
      input.onkeydown = function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); select(at + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); select(at - 1); }
        else if (e.key === 'Enter') {
          var sel = list.querySelectorAll('.palette-item')[at];
          if (sel) { e.preventDefault(); location.href = sel.getAttribute('href'); }
        }
      };
    });
  }
  doc.querySelectorAll('[data-finder]').forEach(function (b) {
    b.addEventListener('click', function (e) { e.preventDefault(); openFinder(); });
  });
})();
`;

/**
 * The file editor: a textarea that behaves like one.
 *
 * The page is a real form and posts to a real route with JavaScript off —
 * every line here is comfort. Tab inserts a tab instead of leaving the field,
 * Enter keeps the indentation you were on, brackets close themselves, ⌘S
 * commits, and the Preview tab asks the server to render the Markdown with
 * the same renderer that will render it once it lands.
 *
 * The highlighting is the classic overlay: a `<pre class="editor-mirror">`
 * holding the syntax-coloured text, and the real textarea on top of it with
 * transparent text and a visible caret. The two must agree on every metric —
 * font, size, line height, padding, tab size — which is why they share a
 * single grid cell and a single set of rules in the stylesheet, and why both
 * sides render through the *same* tokenizer: `/assets/highlight-<hash>.js` is
 * `web/highlight.ts` itself, bundled. The mirror is patched line by line from
 * an incremental model, on an animation frame, so typing costs one line's
 * work and not the file's.
 *
 * Nothing here is load-bearing: no bundle, no mirror; no script, no anything.
 */
export const editorJs = /* js */ `
(function () {
  var doc = document;
  var area = doc.querySelector('textarea.editor');
  if (!area) return;
  var gutter = doc.getElementById('editor-gutter');
  var wrap = doc.getElementById('editor-write');
  var mirror = doc.getElementById('editor-mirror');
  var pathInput = doc.querySelector('.editor-path');
  var form = area.form;
  var MAX_MIRROR = 200000;
  var MAX_LINES = 10000;

  function lineCount() {
    return area.value.split('\\n').length;
  }

  function paintGutter() {
    if (!gutter) return;
    var lines = lineCount();
    var have = gutter.childElementCount;
    if (have === lines) return;
    if (have > lines) {
      while (gutter.childElementCount > lines) gutter.removeChild(gutter.lastChild);
      return;
    }
    var frag = doc.createDocumentFragment();
    for (var n = have + 1; n <= lines; n++) {
      var s = doc.createElement('span');
      s.textContent = String(n);
      frag.appendChild(s);
    }
    gutter.appendChild(frag);
  }

  // ---- the highlighted mirror ----

  var model = null, frame = 0, current = -1, lang = '';

  function build(html, from, to) {
    var out = '';
    for (var i = from; i < to; i++) out += '<div class="ml">' + html[i] + '</div>';
    return out;
  }

  function paint(all) {
    if (!model || !mirror) return;
    if (area.value.length > MAX_MIRROR || lineCount() > MAX_LINES) {
      stopMirror();
      return;
    }
    var up = model.update(area.value);
    if (all || mirror.childElementCount !== up.html.length - up.delta) {
      mirror.innerHTML = build(up.html, 0, up.html.length);
    } else {
      var i;
      if (up.delta > 0) {
        var frag = doc.createDocumentFragment();
        for (i = 0; i < up.delta; i++) frag.appendChild(doc.createElement('div'));
        mirror.insertBefore(frag, mirror.children[up.from] || null);
      } else if (up.delta < 0) {
        for (i = 0; i < -up.delta; i++) {
          var gone = mirror.children[up.from];
          if (gone) mirror.removeChild(gone);
        }
      }
      var end = Math.max(up.to, up.from + Math.max(0, up.delta));
      for (i = up.from; i < end; i++) {
        var el = mirror.children[i];
        if (el) { el.className = 'ml'; el.innerHTML = up.html[i]; }
      }
    }
    current = -1;
    markCurrent();
  }

  // Coalesce to one repaint per frame — with a timer racing the frame, because
  // a background or throttled tab stops handing out frames and a mirror that
  // has silently stopped following the text is worse than one that never was.
  var beat = 0, queued = false;
  function schedule() {
    if (!model || queued) return;
    queued = true;
    frame = window.requestAnimationFrame(run);
    beat = window.setTimeout(run, 40);
  }
  function run() {
    if (!queued) return;
    queued = false;
    window.cancelAnimationFrame(frame);
    window.clearTimeout(beat);
    paint(false);
  }

  function markCurrent() {
    if (!model || !mirror) return;
    var at = area.value.slice(0, area.selectionStart).split('\\n').length - 1;
    if (at === current) return;
    var was = mirror.children[current];
    if (was) was.classList.remove('cur');
    var now = mirror.children[at];
    if (now) now.classList.add('cur');
    current = at;
  }

  function syncScroll() {
    if (gutter) gutter.scrollTop = area.scrollTop;
    if (mirror) {
      mirror.scrollTop = area.scrollTop;
      mirror.scrollLeft = area.scrollLeft;
    }
  }

  function stopMirror() {
    model = null;
    if (wrap) wrap.classList.remove('mirrored');
    if (mirror) mirror.innerHTML = '';
  }

  function startMirror() {
    if (!mirror || !wrap || wrap.getAttribute('data-mirror') !== '1') return;
    var hl = window.forgeHighlight;
    if (!hl || !hl.Mirror) return;
    if (area.value.length > MAX_MIRROR || lineCount() > MAX_LINES) return;
    lang = wrap.getAttribute('data-lang') || 'plain';
    model = new hl.Mirror(lang);
    wrap.classList.add('mirrored');
    paint(true);
    syncScroll();
  }

  // A new file has no extension until you type one, so the language follows
  // the path box as it is filled in.
  function relang() {
    var hl = window.forgeHighlight;
    if (!hl || !pathInput || !wrap) return;
    var next = hl.detect(pathInput.value || '', area.value.slice(0, 200));
    if (next === lang) return;
    lang = next;
    wrap.setAttribute('data-lang', next);
    if (!model) { startMirror(); return; }
    model = new hl.Mirror(next);
    paint(true);
  }
  if (pathInput) {
    pathInput.addEventListener('input', relang);
    pathInput.addEventListener('change', relang);
  }

  // The module that carries the tokenizer is deferred by definition, so the
  // mirror waits for the document rather than for a load event that may
  // already have gone.
  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', startMirror);
  } else {
    startMirror();
  }

  // ---- typing ----

  function replaceSelection(text, back) {
    var start = area.selectionStart, end = area.selectionEnd;
    area.setRangeText(text, start, end, 'end');
    if (back) area.setSelectionRange(area.selectionStart - back, area.selectionStart - back);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  }

  var PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '\\u0060': '\\u0060' };

  area.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      if (form) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); }
      return;
    }
    // ⌘F / ctrl-F is the browser's. The mirror holds the real text, so the
    // page's own find lands on the line you were looking for.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      replaceSelection('\\t', 0);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      var upto = area.value.slice(0, area.selectionStart);
      var line = upto.slice(upto.lastIndexOf('\\n') + 1);
      var indent = /^[\\t ]*/.exec(line)[0];
      if (/[([{]$/.test(line)) indent += '\\t';
      if (indent === '') return;
      e.preventDefault();
      replaceSelection('\\n' + indent, 0);
      return;
    }
    var close = PAIRS[e.key];
    if (close) {
      var start = area.selectionStart, end = area.selectionEnd;
      if (start !== end) {
        // Wrap what is selected rather than replacing it.
        var picked = area.value.slice(start, end);
        e.preventDefault();
        area.setRangeText(e.key + picked + close, start, end, 'preserve');
        area.setSelectionRange(start + 1, end + 1);
        area.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      var next = area.value.charAt(start);
      if (next === '' || /[\\s)\\]}>,;]/.test(next)) {
        e.preventDefault();
        replaceSelection(e.key + close, 1);
      }
      return;
    }
    if (/^[)\\]}]$/.test(e.key) && area.selectionStart === area.selectionEnd) {
      // Typing the closing half of a pair we just inserted steps over it.
      if (area.value.charAt(area.selectionStart) === e.key) {
        e.preventDefault();
        area.setSelectionRange(area.selectionStart + 1, area.selectionStart + 1);
      }
    }
  });

  area.addEventListener('input', function () { paintGutter(); schedule(); });
  area.addEventListener('scroll', syncScroll);
  area.addEventListener('click', markCurrent);
  area.addEventListener('keyup', markCurrent);
  doc.addEventListener('selectionchange', function () {
    if (doc.activeElement === area) markCurrent();
  });
  paintGutter();

  // ---- preview ----
  var tabs = doc.querySelectorAll('[data-editor-tab]');
  var pane = doc.getElementById('editor-preview');
  var url = pane && pane.getAttribute('data-preview');
  var forPath = pane && pane.getAttribute('data-path');
  var last = null; var timer = 0; var rendered = '';

  function ask() {
    if (!pane || !url || area.value === rendered) return;
    if (last) last.abort();
    var ctl = new AbortController();
    last = ctl;
    var body = new FormData();
    body.append('body', area.value);
    body.append('path', (pathInput && pathInput.value) || forPath || '');
    fetch(url, { method: 'POST', body: body, signal: ctl.signal })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (text) {
        if (ctl.signal.aborted) return;
        rendered = area.value;
        pane.innerHTML = text || '<p class="muted">Nothing to preview.</p>';
      }, function () {});
  }
  function show(which) {
    tabs.forEach(function (t) {
      t.setAttribute('aria-selected', t.getAttribute('data-editor-tab') === which ? 'true' : 'false');
    });
    if (wrap) wrap.hidden = which !== 'write';
    if (pane) pane.hidden = which !== 'preview';
    if (which === 'preview') ask();
  }
  tabs.forEach(function (t) {
    t.hidden = false;
    t.addEventListener('click', function (e) {
      e.preventDefault();
      show(t.getAttribute('data-editor-tab'));
    });
  });
  area.addEventListener('input', function () {
    if (!pane || pane.hidden) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(ask, 350);
  });

  // ---- the commit target ----
  // Without a script both halves are on the page and the server ignores the
  // pull fields unless a new branch was chosen; with one, the half that does
  // not apply gets out of the way.
  var newName = doc.getElementById('f-branch');
  var pullBlock = doc.getElementById('f-pull-block');
  function syncTarget() {
    var checked = doc.querySelector('input[name="target"]:checked');
    var fresh = !!checked && checked.value === 'new';
    if (newName) newName.disabled = !fresh;
    if (pullBlock) pullBlock.hidden = !fresh;
  }
  doc.querySelectorAll('input[name="target"]').forEach(function (r) {
    r.addEventListener('change', syncTarget);
  });
  syncTarget();
})();
`;

export const shellJs = /* js */ `
(function () {
  var doc = document;
  ${modalJs}

  // Controls that only mean something with a script running stay hidden
  // until one is: no dead buttons on a page with JavaScript switched off.
  doc.documentElement.classList.add('js');

  // ---- menus (details) ----
  function closeMenus(except) {
    doc.querySelectorAll('details.menu[open]').forEach(function (m) {
      if (m !== except) m.removeAttribute('open');
    });
  }
  doc.addEventListener('click', function (e) {
    var t = e.target;
    closeMenus(t && t.closest ? t.closest('details.menu') : null);
  });
  doc.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var open = doc.querySelector('details.menu[open]');
    if (open) {
      open.removeAttribute('open');
      var s = open.querySelector('summary');
      if (s) s.focus();
      // Consumed: an Escape the page lets through leaves fullscreen on macOS.
      e.preventDefault();
      e.stopPropagation();
    }
  });
  doc.addEventListener('toggle', function (e) {
    var m = e.target;
    if (!m || !m.matches || !m.matches('details.menu[open]')) return;
    closeMenus(m);
    var first = m.querySelector('.menu-panel .menu-item, .menu-panel input');
    if (first && !m.querySelector('.theme-option')) first.focus();
  }, true);
  doc.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    var panel = e.target && e.target.closest ? e.target.closest('.menu-panel') : null;
    if (!panel) return;
    var items = Array.prototype.slice.call(panel.querySelectorAll('.menu-item, .theme-option input'));
    var at = items.indexOf(doc.activeElement);
    var next = items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
    if (next) { next.focus(); e.preventDefault(); }
  });

  // ---- theme: apply instantly, persist once the choice settles ----
  var themeForm = doc.querySelector('.theme-menu form');
  if (themeForm) {
    var apply = themeForm.querySelector('.theme-apply');
    if (apply) apply.hidden = true;
    var pending = 0;
    themeForm.addEventListener('change', function () {
      var choice = new FormData(themeForm).get('theme');
      var root = doc.documentElement;
      root.classList.add('theme-anim');
      if (!choice || choice === 'system') root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', String(choice));
      window.setTimeout(function () { root.classList.remove('theme-anim'); }, 260);
      // Arrowing through six radios must not fire six writes.
      window.clearTimeout(pending);
      pending = window.setTimeout(function () {
        fetch(themeForm.action, { method: 'POST', body: new FormData(themeForm) }).catch(function () {});
      }, 350);
    });
  }

  // ---- copy buttons ----
  // navigator.clipboard is unavailable on a plain-http origin, which is
  // exactly where a self-hosted forge on a LAN lives. So the fallback is to
  // select the text: the copy is then one keystroke away instead of a
  // retype, and the button never does nothing.
  function selectText(el) {
    try {
      var range = doc.createRange();
      range.selectNodeContents(el);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    } catch (err) { return false; }
  }
  doc.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-copy]') : null;
    if (!b) return;
    var src = doc.getElementById(b.getAttribute('data-copy'));
    if (!src) return;
    e.preventDefault();
    var was = b.getAttribute('title');
    function done(tip) {
      b.setAttribute('data-tip', tip);
      window.setTimeout(function () { b.removeAttribute('data-tip'); b.setAttribute('title', was || ''); }, 1200);
    }
    function fallback() {
      done(selectText(src) ? 'Selected — press Ctrl/Cmd+C' : 'Copy it by hand');
    }
    if (!navigator.clipboard) { fallback(); return; }
    navigator.clipboard.writeText(src.textContent.trim()).then(function () {
      done('Copied');
    }, fallback);
  });

  // ---- code line ranges: shift-click extends #L3 to #L3-L9 ----
  var code = doc.querySelector('.code');
  if (code) {
    var anchor = 0;
    function paint() {
      var m = /^#L(\\d+)(?:-L(\\d+))?$/.exec(location.hash);
      code.querySelectorAll('tr[data-hl]').forEach(function (r) { r.removeAttribute('data-hl'); });
      if (!m) return;
      var lo = Number(m[1]); var hi = Number(m[2] || m[1]);
      if (hi < lo) { var t = lo; lo = hi; hi = t; }
      anchor = lo;
      for (var n = lo; n <= hi; n++) {
        var row = doc.getElementById('L' + n);
        if (row) row.setAttribute('data-hl', '');
      }
    }
    code.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('.ln a') : null;
      if (!a || !e.shiftKey || !anchor) return;
      e.preventDefault();
      var to = Number((a.getAttribute('href') || '').slice(2));
      if (!to) return;
      history.replaceState(null, '', '#L' + Math.min(anchor, to) + '-L' + Math.max(anchor, to));
      paint();
    });
    window.addEventListener('hashchange', paint);
    paint();
  }

  // ---- keyboard: sequences from the DOM, so the help can never drift ----
  var seq = []; var last = 0;
  function rows() { return Array.prototype.slice.call(doc.querySelectorAll('[data-nav]')); }
  function move(step) {
    var all = rows();
    if (all.length === 0) return;
    var at = all.indexOf(doc.activeElement.closest ? doc.activeElement.closest('[data-nav]') : null);
    var next = all[Math.min(Math.max(at + step, 0), all.length - 1)] || all[0];
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
  }
  function openFocused() {
    var el = doc.activeElement.closest ? doc.activeElement.closest('[data-nav]') : null;
    var link = el && (el.matches('a') ? el : el.querySelector('a'));
    if (link) link.click();
  }
  doc.addEventListener('keydown', function (e) {
    var t = e.target;
    // Inside an open dialog the dialog owns the keys; none of these apply.
    if (t && t.closest && t.closest('dialog[open]')) return;
    // The palette is one chord away from anywhere, a field included.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      openPalette();
      return;
    }
    if (t && t.matches && t.matches('input, textarea, select, [contenteditable]')) {
      if (e.key === 'Escape') { e.preventDefault(); t.blur(); }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (Date.now() - last > 1200) seq.length = 0;
    last = Date.now();
    seq.push(e.key);
    if (seq.length > 2) seq.splice(0, seq.length - 2);
    var joined = seq.join(' ');
    var target = doc.querySelector('[data-shortcut="' + (window.CSS && CSS.escape ? CSS.escape(joined) : joined) + '"]');
    if (target) { seq.length = 0; e.preventDefault(); target.click(); return; }
    if (e.key === 'j') { seq.length = 0; e.preventDefault(); move(1); }
    else if (e.key === 'k') { seq.length = 0; e.preventDefault(); move(-1); }
    else if (e.key === 'o' || e.key === 'Enter') { seq.length = 0; openFocused(); }
    else if (e.key === '/') {
      var box = doc.querySelector('[data-search-input]');
      if (box) { seq.length = 0; e.preventDefault(); box.focus(); box.select(); }
    } else if (e.key === '?') { seq.length = 0; e.preventDefault(); openHelp(); }
  });

  // ---- help overlay, generated from the shortcuts actually on the page ----
  var STATIC_KEYS = [
    ['j / k', 'Move between rows'], ['o or Enter', 'Open the focused row'],
    ['/', 'Focus search'], ['Cmd/Ctrl K', 'Command palette'], ['?', 'This help'],
    ['Esc', 'Close menu or dialog'],
  ];
  // Built with DOM nodes, never innerHTML: every string below is page text,
  // and page text is exactly what must never be parsed as markup.
  function keyRow(keys, label) {
    var tr = doc.createElement('tr');
    var kc = doc.createElement('td');
    keys.split(' ').forEach(function (k, i) {
      if (i > 0) kc.appendChild(doc.createTextNode(' '));
      var kb = doc.createElement('kbd');
      kb.textContent = k;
      kc.appendChild(kb);
    });
    var lc = doc.createElement('td');
    lc.textContent = label;
    tr.appendChild(kc); tr.appendChild(lc);
    return tr;
  }
  function openHelp() {
    var dlg = doc.getElementById('help-dialog');
    if (!dlg || !dlg.showModal) return;
    var body = dlg.querySelector('[data-help-body]');
    var table = doc.createElement('table');
    table.className = 'table';
    table.setAttribute('data-dense', '');
    var tbody = doc.createElement('tbody');
    var seen = {};
    doc.querySelectorAll('[data-shortcut]').forEach(function (el) {
      var k = el.getAttribute('data-shortcut');
      if (seen[k]) return;
      seen[k] = 1;
      tbody.appendChild(keyRow(k, (el.getAttribute('aria-label') || el.textContent || '').trim()));
    });
    STATIC_KEYS.forEach(function (p) { tbody.appendChild(keyRow(p[0], p[1])); });
    table.appendChild(tbody);
    if (body) { body.textContent = ''; body.appendChild(table); }
    openModal(dlg);
  }

  // ---- command palette ----
  //
  // Its manners are cmdk's (pacocoursey/cmdk), written by hand:
  //  - the input keeps focus for the life of the dialog: it is a combobox
  //    over the listbox (aria-activedescendant), a click on a row never
  //    steals focus, and Tab goes nowhere
  //  - ↑/↓ move the highlight and wrap, Home/End jump to the ends, Enter
  //    opens the highlighted row; the pointer highlights what it is over,
  //    and there is exactly one highlight
  //  - rows sit under group headings; the best row leads its group and the
  //    best group leads the list
  //  - matching is one forgiving score (fuzzyScore): exact, prefix, word
  //    start, substring, then letters in order — every word typed must land
  //  - the list is one swap per keystroke, never cleared and refilled, so
  //    nothing flickers; what the server finds is folded in when it lands,
  //    and what it found last stays up, re-scored, until then
  //  - the empty state is one line
  //  - Escape closes the palette and nothing else: consumed on keydown, and
  //    the dialog's own cancel is handled the same way (openModal)
  //  - a proper dialog: role="dialog", aria-modal, the focus back where it
  //    was on close, and Cmd/Ctrl+K toggles it
  //  - what you picked before is remembered (localStorage) and offered
  //    first while the box is empty
  ${paletteHelpersJs}
  var RECENT_KEY = 'forge.palette.recent';
  var RECENT_MAX = 8;
  var index = null;
  function loadIndex() {
    if (index) return index;
    var el = doc.getElementById('palette-index');
    try { index = JSON.parse(el.textContent); } catch (_) { index = { items: [] }; }
    return index;
  }
  // Storage may be absent, full or refused (a private window): a palette
  // with no memory is still a palette.
  function readRecent() {
    try {
      var raw = JSON.parse(window.localStorage.getItem(RECENT_KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      return raw.filter(function (r) {
        return r && typeof r.t === 'string' && typeof r.h === 'string' && r.h.charAt(0) === '/';
      }).slice(0, RECENT_MAX).map(function (r) {
        return { t: r.t, h: r.h, g: typeof r.g === 'string' ? r.g : '' };
      });
    } catch (_) { return []; }
  }
  function remember(r) {
    try {
      var rest = readRecent().filter(function (x) { return x.h !== r.h; });
      var next = [{ t: r.t, h: r.h, g: r.g === 'Recent' ? (r.d || '') : r.g }].concat(rest);
      window.localStorage.setItem(RECENT_KEY, JSON.stringify(next.slice(0, RECENT_MAX)));
    } catch (_) {}
  }
  // What the server found, as rows. The links are built here from the
  // parts the API returns, never taken from it whole.
  function fold(out) {
    var rows = [];
    (out.repos || []).slice(0, 5).forEach(function (r) {
      rows.push(r.source === 'origin'
        ? { t: r.fullName, h: '/origins/' + r.originId + '/r/' + r.fullName, g: 'Repositories',
            d: r.originKind ? 'on ' + r.originKind : 'on an origin' }
        : { t: r.owner + '/' + r.name, h: '/' + r.owner + '/' + r.name, g: 'Repositories' });
    });
    (out.issues || []).slice(0, 5).forEach(function (i) {
      if (i.source !== 'local') return;
      rows.push({
        t: i.title,
        h: '/' + i.repo.owner + '/' + i.repo.name + '/' + (i.kind === 'issue' ? 'issues' : 'pulls') + '/' + i.number,
        g: i.kind === 'issue' ? 'Issues' : 'Pull requests',
        d: i.repo.owner + '/' + i.repo.name + ' #' + i.number,
      });
    });
    (out.code || []).slice(0, 5).forEach(function (c) {
      rows.push({
        t: c.path + ':' + c.line,
        h: '/' + c.repo.owner + '/' + c.repo.name + '/blob/HEAD/' + c.path + '#L' + c.line,
        g: 'Code',
        d: (c.text || '').trim().slice(0, 60),
      });
    });
    return rows;
  }

  var closePalette = null;
  function openPalette() {
    var dlg = doc.getElementById('palette');
    if (!dlg || !dlg.showModal) { location.href = '/search'; return; }
    if (closePalette) { closePalette(); return; }
    var input = dlg.querySelector('.palette-input');
    var list = dlg.querySelector('.palette-list');
    var items = (loadIndex().items || []).map(function (i) {
      return { t: String(i.t), h: String(i.h), g: i.c ? String(i.c) : 'Go to' };
    });
    var recent = readRecent().map(function (r) { return { t: r.t, h: r.h, g: 'Recent', d: r.g }; });
    var recentHrefs = recent.map(function (r) { return r.h; });
    var served = [];       // rows the server found, for the query servedFor
    var servedFor = '';
    var pending = false;   // a server answer is on its way
    var remote = null;
    var remoteTimer = 0;
    var nodes = [];        // the rows on screen, in order …
    var shown = [];        // … and what each one is
    var at = 0;

    // Every row is built from DOM nodes: the titles are repository names,
    // issue titles and lines of code, and page text is exactly what must
    // never be parsed as markup.
    function row(r, id) {
      var a = doc.createElement('a');
      a.className = 'palette-item';
      a.id = id;
      a.setAttribute('role', 'option');
      a.setAttribute('aria-selected', 'false');
      // Same-origin paths only: the index is ours, and this keeps it so.
      a.setAttribute('href', r.h.charAt(0) === '/' ? r.h : '/');
      var t = doc.createElement('span');
      t.className = 'grow';
      t.textContent = r.t;
      a.appendChild(t);
      if (r.d) {
        var d = doc.createElement('span');
        d.className = 'cat';
        d.textContent = r.d;
        a.appendChild(d);
      }
      return a;
    }
    function emptyLine(q) {
      var p = doc.createElement('p');
      p.className = 'palette-empty';
      if (pending) { p.textContent = 'Searching…'; return p; }
      p.appendChild(doc.createTextNode(q === '' ? 'Nothing here.' : 'No matches. '));
      if (q !== '') {
        var more = doc.createElement('a');
        more.href = '/search?q=' + encodeURIComponent(q);
        more.textContent = 'Search everything';
        p.appendChild(more);
      }
      return p;
    }
    function select(n, scroll) {
      if (nodes.length === 0) { at = 0; input.removeAttribute('aria-activedescendant'); return; }
      at = ((n % nodes.length) + nodes.length) % nodes.length;
      nodes.forEach(function (a, i) { a.setAttribute('aria-selected', i === at ? 'true' : 'false'); });
      input.setAttribute('aria-activedescendant', nodes[at].id);
      if (scroll !== false) nodes[at].scrollIntoView({ block: 'nearest' });
    }
    // One fragment, one swap. With keep, the highlight stays on the same row
    // when the list changes under it (a server answer landing); a new query
    // starts at the top.
    function render(keep) {
      var q = input.value.trim();
      var pool = (q === '' ? recent : []).concat(items, q.length >= 2 ? served : []);
      var groups = rankPalette(pool, q, recentHrefs, q === '' ? 24 : 20);
      var was = keep && nodes[at] ? nodes[at].getAttribute('href') : null;
      var frag = doc.createDocumentFragment();
      nodes = []; shown = [];
      groups.forEach(function (g, gi) {
        var box = doc.createElement('div');
        box.className = 'palette-group';
        box.setAttribute('role', 'group');
        var h = doc.createElement('div');
        h.className = 'palette-heading';
        h.id = 'palette-g' + gi;
        h.setAttribute('aria-hidden', 'true');
        h.textContent = g.title;
        box.setAttribute('aria-labelledby', h.id);
        box.appendChild(h);
        g.rows.forEach(function (r) {
          var a = row(r, 'palette-o' + nodes.length);
          nodes.push(a); shown.push(r);
          box.appendChild(a);
        });
        frag.appendChild(box);
      });
      if (nodes.length === 0) frag.appendChild(emptyLine(q));
      list.textContent = '';
      list.appendChild(frag);
      var n = 0;
      if (was) nodes.forEach(function (a, i) { if (a.getAttribute('href') === was) n = i; });
      select(n, false);
    }

    // The forge's own search, behind the palette. It is the same action as
    // the /search page and the API call, so the palette can never disagree
    // with the page behind it — and it is debounced and cancelled, because
    // a keystroke is not a reason to grep every repository twice.
    function ask(q) {
      window.clearTimeout(remoteTimer);
      if (remote) { remote.abort(); remote = null; }
      if (q.length < 2 || typeof fetch === 'undefined') { pending = false; served = []; servedFor = ''; return; }
      if (q === servedFor) { pending = false; return; }
      pending = true;
      remoteTimer = window.setTimeout(function () {
        var ctl = new AbortController();
        remote = ctl;
        fetch('/api/v1/search?limit=5&q=' + encodeURIComponent(q), {
          signal: ctl.signal, headers: { accept: 'application/json' },
        })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (out) {
            if (ctl.signal.aborted || input.value.trim() !== q) return;
            remote = null; pending = false;
            served = out ? fold(out) : [];
            servedFor = q;
            render(true);
          }, function () {
            if (ctl.signal.aborted) return;
            remote = null; pending = false;
            render(true);
          });
      }, 120);
    }
    function onKey(e) {
      var k = e.key;
      if (k === 'Escape' || ((e.metaKey || e.ctrlKey) && (k === 'k' || k === 'K'))) {
        e.preventDefault(); e.stopPropagation(); close(); return;
      }
      if (k === 'ArrowDown') { e.preventDefault(); select(at + 1); }
      else if (k === 'ArrowUp') { e.preventDefault(); select(at - 1); }
      else if (k === 'Home') { e.preventDefault(); select(0); }
      else if (k === 'End') { e.preventDefault(); select(nodes.length - 1); }
      else if (k === 'Enter') {
        e.preventDefault();
        var q = input.value.trim();
        if (nodes[at]) nodes[at].click();
        else if (q !== '') location.href = '/search?q=' + encodeURIComponent(q);
      }
      else if (k === 'Tab') e.preventDefault();
      // Whatever the key, it is the palette's: the page's shortcuts never see it.
      e.stopPropagation();
    }

    input.value = '';
    render(false);
    var close = openModal(dlg, function () {
      dlg.onkeydown = null; dlg.onpointerdown = null;
      list.onclick = null; list.onpointermove = null;
      input.oninput = null;
      window.clearTimeout(remoteTimer);
      if (remote) { remote.abort(); remote = null; }
      closePalette = null;
    });
    closePalette = close;
    dlg.onkeydown = onKey;
    // A press anywhere but the input would move the focus off it.
    dlg.onpointerdown = function (e) { if (e.target !== input) e.preventDefault(); };
    input.oninput = function () { ask(input.value.trim()); render(false); };
    list.onpointermove = function (e) {
      var a = e.target && e.target.closest ? e.target.closest('.palette-item') : null;
      var i = a ? nodes.indexOf(a) : -1;
      if (i !== -1 && i !== at) select(i, false);
    };
    // A real click and Enter's synthetic one both land here; the browser
    // follows the link (and honours a modifier) on its own.
    list.onclick = function (e) {
      var a = e.target && e.target.closest ? e.target.closest('.palette-item') : null;
      var i = a ? nodes.indexOf(a) : -1;
      if (i !== -1) remember(shown[i]);
    };
    input.focus();
  }
  doc.querySelectorAll('[data-palette]').forEach(function (b) {
    b.addEventListener('click', function (e) { e.preventDefault(); openPalette(); });
  });
  doc.querySelectorAll('[data-help]').forEach(function (b) {
    b.addEventListener('click', function (e) { e.preventDefault(); openHelp(); });
  });

  // ---- colour pickers show the hex they are about to submit ----
  doc.querySelectorAll('.color-field input[type="color"]').forEach(function (i) {
    var out = i.parentNode.querySelector('.hex');
    if (!out) return;
    i.addEventListener('input', function () { out.textContent = i.value; });
  });
})();
`;

/**
 * Live regions. A page marks the parts of itself that change while it is
 * open: an element with an `id` and `data-live="kinds"` (comma-separated
 * event kinds, `*` as a suffix wildcard: `run.*`), optionally scoped to
 * one repository with `data-live-repo="owner/name"`. One stream per page
 * carries everything the viewer may see; when an event matches, the page
 * refetches itself once (several events within half a second are one
 * fetch) and swaps just those regions in place. Nothing reloads under a
 * reader, no client templating, and the server renders exactly what it
 * would have rendered on a visit. `forge:event` is dispatched on
 * `document` for scripts that want the event itself, `forge:swapped` on a
 * region that was just replaced, and `forge:live` on `document` with the
 * stream's state (`open`, `reconnecting`) for a page that shows it.
 */
export const boardJs = /* js */ `
(function () {
  var board = document.querySelector('.board');
  if (!board) return;
  var doc = document;

  // ---- clocks: the corner, every run's elapsed, every relative time ----
  var clock = doc.getElementById('board-clock');
  function two(n) { return (n < 10 ? '0' : '') + n; }
  function span(s) {
    return s < 60 ? s + 's'
      : s < 3600 ? Math.floor(s / 60) + 'm ' + two(s % 60) + 's'
      : Math.floor(s / 3600) + 'h ' + two(Math.floor((s % 3600) / 60)) + 'm';
  }
  // The same words the server used, so a swap never changes a row's voice.
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
    Array.prototype.forEach.call(board.querySelectorAll('[data-started]'), function (el) {
      var t = Date.parse(el.getAttribute('data-started') || '');
      if (t) el.textContent = span(Math.max(0, Math.round((now - t) / 1000)));
    });
    Array.prototype.forEach.call(board.querySelectorAll('time[datetime]'), function (el) {
      if (el === clock) return;
      var t = Date.parse(el.getAttribute('datetime') || '');
      if (t) el.textContent = ago(Math.max(0, (now - t) / 1000));
    });
  }
  // One interval for the page, set once: each tick reads whatever cards are
  // on the wall right then, so a swap never arms a second clock.
  window.setInterval(tick, 1000);
  tick();
  // A swapped region carries fresh rows: their clocks start at once, and
  // the heading glows for a moment so a glance catches what moved. Nothing
  // here fetches or emits: the stream cannot echo a swap.
  doc.addEventListener('forge:swapped', function (e) {
    tick();
    var region = e.target && e.target.closest ? e.target.closest('.board-region') : null;
    if (!region) return;
    region.setAttribute('data-fresh', '');
    window.setTimeout(function () { region.removeAttribute('data-fresh'); }, 1500);
  });

  // ---- the dot: whether the stream is connected ----
  var live = doc.getElementById('board-live');
  doc.addEventListener('forge:live', function (e) {
    if (live && e.detail) live.setAttribute('data-state', e.detail.state);
  });

  // ---- keys: f fullscreen, 1–4 one region, 0 all. Escape is the browser's. ----
  var REGIONS = { '1': 'working', '2': 'landed', '3': 'decided', '4': 'today' };
  doc.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && t.closest && t.closest('dialog[open]')) return;
    if (t && t.matches && t.matches('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'f') {
      e.preventDefault();
      if (doc.fullscreenElement) { if (doc.exitFullscreen) doc.exitFullscreen(); }
      else if (doc.documentElement.requestFullscreen) doc.documentElement.requestFullscreen().catch(function () {});
    } else if (e.key === '0') {
      e.preventDefault();
      board.removeAttribute('data-focus');
    } else if (REGIONS[e.key]) {
      e.preventDefault();
      board.setAttribute('data-focus', REGIONS[e.key]);
    }
  });
})();
`;

export const liveRegionsJs = /* js */ `
(function () {
  var regions = document.querySelectorAll('[data-live]');
  if (regions.length === 0 || typeof EventSource === 'undefined') return;
  function matches(patterns, kind, repo, region) {
    var want = region.getAttribute('data-live-repo');
    if (want && want !== repo) return false;
    return patterns.some(function (p) {
      return p.slice(-1) === '*' ? kind.indexOf(p.slice(0, -1)) === 0 : p === kind;
    });
  }
  var due = {};
  var timer = null;
  function refresh() {
    timer = null;
    var ids = Object.keys(due);
    due = {};
    if (ids.length === 0) return;
    fetch(location.href, { headers: { accept: 'text/html' }, credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.text() : Promise.reject(r); })
      .then(function (text) {
        var fresh = new DOMParser().parseFromString(text, 'text/html');
        ids.forEach(function (id) {
          var mine = document.getElementById(id);
          var theirs = fresh.getElementById(id);
          if (!mine || !theirs) return;
          var active = document.activeElement;
          if (active && mine.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
          mine.innerHTML = theirs.innerHTML;
          Array.prototype.forEach.call(theirs.attributes, function (a) { if (a.name !== 'id') mine.setAttribute(a.name, a.value); });
          mine.dispatchEvent(new CustomEvent('forge:swapped', { bubbles: true }));
        });
      })
      .catch(function () {});
  }
  var source = new EventSource('/events');
  // The stream's own state, for a page that shows whether it is connected.
  function state(s) { document.dispatchEvent(new CustomEvent('forge:live', { detail: { state: s } })); }
  source.addEventListener('open', function () { state('open'); });
  source.addEventListener('error', function () { state('reconnecting'); });
  source.addEventListener('forge', function (event) {
    var data;
    try { data = JSON.parse(event.data); } catch (err) { return; }
    document.dispatchEvent(new CustomEvent('forge:event', { detail: data }));
    var hit = false;
    Array.prototype.forEach.call(document.querySelectorAll('[data-live]'), function (region) {
      var patterns = (region.getAttribute('data-live') || '').split(',').map(function (p) { return p.trim(); }).filter(Boolean);
      if (region.id && matches(patterns, data.kind, data.repo, region)) { due[region.id] = true; hit = true; }
    });
    if (hit && timer === null) timer = setTimeout(refresh, 500);
  });
})();
`;
