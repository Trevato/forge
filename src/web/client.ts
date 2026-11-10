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

import { GO_MATCH_JS, goPagesData } from "./go_pages.ts";
import { actNowJs } from "./act_now.ts";
import { pickJs } from "./pick.ts";
import { imageViewJs } from "./render/image.ts";
import { STAGE_BADGE_JS } from "./stage-row.ts";
import { paletteHelpersJs } from "./palette.ts";
import { MEDIA_PLAY_JS } from "./render/player.ts";
import { NOT_TOLD_WORDS } from "../actions/tell_words.ts";

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
 * The device-code page's only enhancement: listen on the page's own stream
 * (`data-stream` on the "check again" form) and re-read the page when the
 * forge says the flow has left pending. The forge does the asking of the
 * provider (`src/http/flow_stream.ts`); this loops on nothing. Without script
 * the form's button and a reload still re-poll.
 *
 * Shipped per page (`PageOptions.scriptJs`) rather than in the shell.
 */
export const pollJs = /* js */ `
(function () {
  var form = document.querySelector('form[data-stream]');
  if (!form || typeof EventSource === 'undefined') return;
  var source = new EventSource(form.getAttribute('data-stream'));
  source.addEventListener('flow.settled', function () {
    source.close();
    location.reload();
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

  var rows = Array.prototype.slice.call(list.querySelectorAll('li[data-stage-name]'));
  var order = rows.map(function (li) { return li.getAttribute('data-stage-name'); });
  var badges = ${STAGE_BADGE_JS};

  function paint(stage, detail) {
    list.setAttribute('data-stage', stage);
    var there = order.indexOf(stage);
    rows.forEach(function (li, i) {
      var state = stage === 'failed' ? 'todo'
        : i < there ? 'done'
        : i === there ? (stage === 'done' ? 'done' : 'now')
        : 'todo';
      li.setAttribute('data-state', state);
      var badge = li.querySelector('.badge');
      if (badge) {
        badge.textContent = badges[state][0];
        badge.setAttribute('data-variant', badges[state][1]);
      }
      var note = li.querySelector('.row-meta');
      if (note) note.textContent = state === 'now' ? (detail || '') : '';
    });
  }

  var source = new EventSource(url);
  source.addEventListener('error', function () {
    // EventSource reconnects by itself; once it has closed for good (the job
    // expired, or the stream is gone) the page re-reads itself, once per
    // stream url. The key is set before the reload, so a stream that fails
    // the same way again cannot loop; with no storage, there is no reload.
    if (source.readyState !== 2) return;
    try {
      if (sessionStorage.getItem(url)) return;
      sessionStorage.setItem(url, '1');
    } catch (err) { return; }
    location.reload();
  });
  ['creating', 'fetching', 'labels', 'issues', 'pulls', 'comments', 'done', 'failed'].forEach(function (stage) {
    source.addEventListener('mirror.' + stage, function (event) {
      var job;
      try { job = JSON.parse(event.data); } catch (err) { return; }
      paint(job.stage, job.detail);
      if (job.stage === 'done' && job.repo) {
        source.close();
        location.href = list.getAttribute('data-landing') || '/' + job.repo.ownerName + '/' + job.repo.name;
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
 * Turning one log line into an element, the way every reader of a run's log
 * draws it: a tool call bolds its name, the forge's own words go quiet and
 * italic, "you: " gets its own highlighted row, and anything else is the
 * agent speaking as \`who\`. Shared by \`studioRunJs\` and \`appTailJs\`
 * so a third live log never grows a third copy of it —
 * interpolated inline, so \`who\` closes over whichever script uses it.
 */
/**
 * The clock beside a run's own log: elapsed time ticks while it goes, and
 * stops at "took" — under ten seconds in tenths, matching \`durationText\`
 * (\`pages/runs.ts\`) exactly, since the two paint the very same number
 * first server-side, then live; a mismatched rounding here would flicker
 * the instant this script takes over. Used by \`studioRunJs\`.
 */
const elapsedTickJs = /* js */ `
  function tick() {
    var elapsed = document.getElementById('run-elapsed');
    if (!elapsed) return;
    var started = Date.parse(elapsed.getAttribute('data-started') || '');
    if (!started) return;
    var finished = Date.parse(elapsed.getAttribute('data-finished') || '');
    var end = finished || Date.now();
    var ms = Math.max(0, end - started);
    var text;
    if (ms < 10000) {
      text = (ms / 1000).toFixed(1) + 's';
    } else {
      var s = Math.round(ms / 1000);
      text = s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    }
    elapsed.textContent = (finished ? 'took ' : 'running for ') + text;
  }
  var clock = window.setInterval(tick, 100);
  tick();
`;

const logLineJs = /* js */ `
  var FORGE = /^(claude:|done:|failed:|paused|declined:|cloning |branch |forked |pushing |push refused|clone kept|nothing to propose|opened pull|updated pull|committed the|could not|checking out|deploy |data: |\\$ |session |the session|interrupted|passed in|install |test |start |ready |process |timing: )/;
  function line(kind, speaker, fill, variant) {
    var el = document.createElement('div');
    el.className = 'row';
    el.setAttribute('data-line', kind);
    var lead = document.createElement('span');
    lead.className = 'row-lead';
    var w = document.createElement('span');
    w.className = 'badge';
    if (variant) w.setAttribute('data-variant', variant);
    w.textContent = speaker;
    lead.appendChild(w);
    var main = document.createElement('span');
    main.className = 'row-main';
    var t = document.createElement('span');
    t.className = 'row-title';
    fill(t);
    main.appendChild(t);
    el.appendChild(lead);
    el.appendChild(main);
    return el;
  }
  function draw(text) {
    if (text.indexOf('you: ') === 0) return line('you', 'you', function (t) { t.textContent = text.slice(5); }, 'secondary');
    if (text.indexOf('\\u2192 ') === 0) {
      var rest = text.slice(2), at = rest.indexOf(' ');
      return line('tool', 'tool', function (t) {
        var b = document.createElement('b');
        b.textContent = at === -1 ? rest : rest.slice(0, at);
        t.appendChild(b);
        t.appendChild(document.createTextNode(at === -1 ? '' : ' ' + rest.slice(at + 1)));
      });
    }
    if (FORGE.test(text)) return line('forge', 'forge', function (t) { t.textContent = text; }, 'outline');
    return line('say', who, function (t) { t.textContent = text; });
  }
`;

/**
 * A run's log, live, painted in the studio's own five words. The page
 * renders every line already written; for a run still going, this appends
 * each line from the page's one event stream the moment it is written. \`data-cap\` on \`#run-log\` bounds how many lines a long-running
 * agent can pile into the DOM: past it, the oldest line is dropped as a new
 * one arrives, so an hour-long run never grows without bound.
 */
export const studioRunJs = /* js */ `
(function () {
  var log = document.getElementById('run-log');
  if (!log) return;
  var who = log.getAttribute('data-who') || 'agent';
  var cap = parseInt(log.getAttribute('data-cap') || '0', 10) || 0;
  var pulse = document.getElementById('run-pulse');
  var jump = document.getElementById('run-jump');
  var cancel = document.getElementById('run-cancel');
  var stop = document.getElementById('run-stop');
  var steer = document.getElementById('run-steer');
  var live = document.getElementById('run-live');

  var follow = true;
  function atEnd() { return log.scrollTop + log.clientHeight >= log.scrollHeight - 12; }
  function toEnd() { log.scrollTop = log.scrollHeight; follow = true; if (jump) jump.hidden = true; }
  log.addEventListener('scroll', function () { follow = atEnd(); if (follow && jump) jump.hidden = true; });
  if (jump) jump.addEventListener('click', toEnd);
  function fit() {
    var room = window.innerHeight - log.getBoundingClientRect().top - (steer ? steer.offsetHeight : 0) - 16;
    if (room > 240) log.style.maxHeight = room + 'px';
    if (follow) toEnd();
  }
  window.addEventListener('resize', fit);
  fit();

  function studioWord(run) {
    if (run.state === 'queued') return 'waiting';
    if (run.state === 'running') return 'working';
    if (run.state === 'cancelled') return 'cancelled';
    if (run.state === 'failed') return 'stopped';
    var s = run.summary || '';
    if (/opened pull|updated pull/.test(s)) return 'look';
    if (/planned|no changes pushed/.test(s)) return 'planned';
    return 'shipped';
  }
  function variantFor(w) {
    return w === 'look' || w === 'shipped' ? 'success' : w === 'stopped' ? 'danger' : w === 'working' ? 'accent' : 'secondary';
  }
  function money(n) { return n < 0.01 ? '<$0.01' : '$' + n.toFixed(2); }
  // The head is a live region (\`liveRegionsJs\` swaps it from the page
  // when the run moves), so what lives in it is looked up at paint time.
  function paint(run) {
    var word = document.getElementById('run-word');
    var summary = document.getElementById('run-summary');
    if (word) {
      var w = studioWord(run);
      word.setAttribute('data-word', w);
      word.setAttribute('data-variant', variantFor(w));
      word.textContent = w;
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

  ${logLineJs}
  function add(el) {
    log.insertBefore(el, pulse && pulse.parentNode === log ? pulse : jump);
    if (cap) {
      var kept = log.querySelectorAll('.row[data-line]:not(#run-pulse)');
      while (kept.length > cap) { log.removeChild(kept[0]); kept = log.querySelectorAll('.row[data-line]:not(#run-pulse)'); }
    }
    if (follow) toEnd(); else if (jump) jump.hidden = false;
  }

  ${elapsedTickJs}

  // A check's step rows are server-derived from the log; when a line that
  // can move them lands (a command's echo, the shard runner's banner or a
  // shard header) or the run ends, the rows are fetched again and swapped in.
  var stepsTimer = 0;
  function steps() {
    var cur = document.getElementById('check-steps');
    if (!cur || !window.fetch || !window.DOMParser) return;
    fetch(location.href, { credentials: 'same-origin', headers: { accept: 'text/html' } })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (body) {
        var doc = new DOMParser().parseFromString(body, 'text/html');
        var next = doc.getElementById('check-steps');
        var now = document.getElementById('check-steps');
        if (next && now && now.parentNode) now.parentNode.replaceChild(next, now);
        // The pin slot is only patched, never replaced: a keyboard user
        // reading a failure keeps focus and scroll.
        var wrap = document.getElementById('check-progress'), pw = doc.getElementById('check-progress');
        var slot = document.getElementById('check-pins'), ps = doc.getElementById('check-pins');
        if (wrap && pw) wrap.setAttribute('data-state', pw.getAttribute('data-state') || '');
        if (slot && ps) {
          if (slot.innerHTML !== ps.innerHTML) slot.innerHTML = ps.innerHTML;
          ['role', 'tabindex', 'aria-label'].forEach(function (a) {
            var v = ps.getAttribute(a);
            if (v === null) slot.removeAttribute(a); else if (slot.getAttribute(a) !== v) slot.setAttribute(a, v);
          });
        }
      })
      .catch(function () {});
  }
  function stepsSoon() {
    if (!document.getElementById('check-steps') || stepsTimer) return;
    stepsTimer = window.setTimeout(function () { stepsTimer = 0; steps(); }, 400);
  }

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

  // The page opens no stream of its own: the shared /events connection
  // (liveRegionsJs) carries this run's lines as run.log frames, handed on as
  // forge:run-log, and its state change as the run.finished event.
  var runId = log.getAttribute('data-run');
  if (!runId) return;
  var logUrl = log.getAttribute('data-log');
  var empty = document.getElementById('run-empty');
  // Lines on the page: those the server drew from the file, then each added
  // here. A catch-up read of the file adds only what is past that count, and
  // frames wait for it, so a line is never drawn twice.
  var have = parseInt(log.getAttribute('data-seen') || '-1', 10);
  var catching = false;
  function put(text) {
    if (empty) empty.hidden = true;
    add(draw(text));
    have++;
    if (/^(\\$ |test-shards: |\\(fail\\) |\u2500\u2500 shard )/.test(text)) stepsSoon();
  }
  function catchUp() {
    if (have < 0 || !logUrl || !window.fetch || catching) return;
    catching = true;
    fetch(logUrl, { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (body) {
        var all = body.split('\n');
        if (all[all.length - 1] === '') all.pop();
        all.slice(have).forEach(put);
      })
      .catch(function () {})
      .then(function () { catching = false; });
  }
  var conn = document.getElementById('run-conn');
  document.addEventListener('forge:live', function (e) {
    var st = e.detail && e.detail.state;
    if (conn) conn.hidden = st !== 'reconnecting';
    if (st === 'open') catchUp();
  });
  document.addEventListener('forge:run-log', function (e) {
    var d = e.detail;
    if (!d || d.run !== runId || catching || !Array.isArray(d.lines)) return;
    d.lines.forEach(function (l) { if (typeof l === 'string') put(l); });
  });
  document.addEventListener('forge:event', function (e) {
    var d = e.detail;
    if (!d || d.kind !== 'run.finished' || !d.payload || d.payload.runId !== runId) return;
    paint(d.payload);
    if (stepsTimer) { window.clearTimeout(stepsTimer); stepsTimer = 0; }
    steps();
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
 * The tail beside a running row, or in the head card, on the app's own page
 * in the studio (\`studio/app.ts\`, \`studio/previews.ts\`, \`#app-run-tail\`):
 * the same lines a run's own page streams, a handful at a time, so a person
 * on the app's page sees the crew at work — or the app itself coming up,
 * before any agent has touched it — without opening the run. \`data-cap\`
 * bounds what stays in the DOM as new lines arrive — a chatty run left open
 * cannot grow the page without bound. There is exactly one of these on a
 * page at once (an agent run's own work outranks a background deploy, so
 * only one of the two ever renders the id), so it opens no stream of
 * its own: it appends the \`run.log\` frames the page's one \`/events\`
 * connection already carries. It carries no controls of its own: Stop lives on the row, the
 * full transcript is one click away, and the row's own word — or the head
 * card's own state — swaps in once the run is over (the page's existing
 * live regions already repaint on \`run.*\`) — this only ever appends lines
 * and stops.
 */
export const appTailJs = /* js */ `
(function () {
  var tail = document.getElementById('app-run-tail');
  if (!tail) return;
  var url = tail.getAttribute('data-stream');
  if (!url) return;
  var who = tail.getAttribute('data-who') || 'the crew';
  var cap = parseInt(tail.getAttribute('data-cap') || '0', 10) || 0;

  ${logLineJs}
  function add(el) {
    tail.appendChild(el);
    if (cap) {
      var kept = tail.querySelectorAll('.row[data-line]');
      while (kept.length > cap) { tail.removeChild(kept[0]); kept = tail.querySelectorAll('.row[data-line]'); }
    }
    tail.scrollTop = tail.scrollHeight;
  }

  // The run this tail follows is the one its stream URL names; the lines
  // themselves arrive as \`run.log\` frames on the page's one \`/events\`
  // connection (\`liveClientJs\`), so this script opens no stream of its own.
  var named = /\\/runs\\/([^\\/?]+)\\/log/.exec(url);
  var run = named && named[1];
  if (!run) return;
  document.addEventListener('forge:run-log', function (event) {
    var d = event.detail;
    if (!d || d.run !== run || !Array.isArray(d.lines)) return;
    d.lines.forEach(function (text) { if (typeof text === 'string') add(draw(text)); });
  });
})();
`;

/**
 * The code browser: the explorer column, the file it opens beside itself,
 * the divider between the two, and the fuzzy file finder.
 *
 * Everything here is an accelerant on something the page already does. The
 * explorer's links are real links; opening one is a fetch of the very blob
 * route it points at, rendered by the same server template, so an in-place
 * open and a full navigation produce identical markup — and the address bar
 * follows, so back, forward and a copied link all mean what they say. A
 * folder the server did not expand already carries a link to its own page;
 * the script replaces that link with the folder's contents. The finder is a
 * dialog over the JSON the \`paths\` route serves — with no script, the
 * column beside it is the finder.
 *
 * Hovering a file only warms the cache. It never changes what is on screen:
 * a file you are reading stays until you ask for another one — with a click,
 * with \`enter\`, with the finder. (An earlier cut previewed on hover, and a
 * pointer drifting across the tree kept swapping the file out from under the
 * reader.)
 *
 * Keyboard: \`j\`/\`k\`, \`enter\` and \`o\` are the shell's own row traversal (the
 * explorer's files are \`data-nav\` rows), and \`t\`/\`e\` are \`data-shortcut\`
 * attributes on real controls. The divider answers the arrow keys itself,
 * because it is a separator widget and that is what one does.
 */
export const codeJs = /* js */ `
(function () {
  var doc = document;
  ${modalJs}
  var cfg = doc.getElementById('code');
  if (!cfg || typeof fetch === 'undefined') return;
  var nav = doc.querySelector('.explorer');
  var main = doc.getElementById('code-main');

  // ---- open in place; hover only warms ----
  if (nav && main && window.history && history.pushState) {
  var cache = new Map(); var order = []; var pending = new Set();
  var inflight = null; var hoverTimer = 0;
  // The file last asked for — shown, or on its way.
  var wanted = location.pathname + location.search;

  function fragmentOf(url) { return url + (url.indexOf('?') === -1 ? '?' : '&') + 'fragment=1'; }
  function remember(url, text) {
    cache.set(url, text); order.push(url);
    while (order.length > 40) { var old = order.shift(); if (old !== url) cache.delete(old); }
  }
  // The prefetch: the bytes land in the cache and nowhere else.
  function warm(link) {
    var url = link.getAttribute('href');
    if (!url) return;
    var at = fragmentOf(url);
    if (cache.has(at) || pending.has(at)) return;
    pending.add(at);
    fetch(at, { headers: { accept: 'text/html' } })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (text) { pending.delete(at); if (text) remember(at, text); },
            function () { pending.delete(at); });
  }
  function markCurrent(url) {
    nav.querySelectorAll('.ex-file[aria-current]').forEach(function (a) { a.removeAttribute('aria-current'); });
    nav.querySelectorAll('.ex-file').forEach(function (a) {
      if (a.getAttribute('href') === url) a.setAttribute('aria-current', 'page');
    });
  }
  function retitle() {
    var pane = main.querySelector('#code-pane');
    var path = pane ? pane.getAttribute('data-path') || '' : '';
    var at = doc.title.indexOf(' · ');
    if (path && at > 0) doc.title = path.split('/').pop() + doc.title.slice(at);
  }
  function paint(url, text) {
    // Our own server-rendered markup, escaped where it was built.
    main.innerHTML = text;
    markCurrent(url);
    retitle();
    // The shell's line-range handler keeps an anchor per file; tell it the file changed.
    doc.dispatchEvent(new Event('code:swap'));
  }
  // Show a file in the pane. \`push\` records it in history; a back/forward
  // arrival passes false because the entry is already there.
  function show(url, push) {
    wanted = url;
    if (push) history.pushState({ code: url }, '', url);
    var at = fragmentOf(url);
    if (inflight) { inflight.abort(); inflight = null; }
    if (cache.has(at)) { paint(url, cache.get(at)); return; }
    var ctl = new AbortController();
    inflight = ctl;
    main.setAttribute('aria-busy', 'true');
    fetch(at, { signal: ctl.signal, headers: { accept: 'text/html' } })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (text) {
        if (ctl.signal.aborted) return;
        main.removeAttribute('aria-busy');
        // Anything short of the pane is the server's page to explain.
        if (!text) { location.href = url; return; }
        remember(at, text);
        paint(url, text);
      }, function () { if (!ctl.signal.aborted) { main.removeAttribute('aria-busy'); location.href = url; } });
  }
  // Bring the top of the file into view when the reader is deep in the last
  // one; a reader already at the top is not moved.
  function surface() {
    var top = main.getBoundingClientRect().top;
    var bar = parseInt(getComputedStyle(doc.documentElement).getPropertyValue('--topbar-h'), 10) || 56;
    if (top < bar) main.scrollIntoView({ block: 'start' });
  }
  nav.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('.ex-file') : null;
    // A modified click is the browser's: new tab, new window, download.
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var url = a.getAttribute('href');
    if (!url || url.charAt(0) !== '/') return;
    e.preventDefault();
    if (url === wanted) { surface(); return; }
    show(url, true);
    surface();
  });
  window.addEventListener('popstate', function (e) {
    var url = e.state && e.state.code;
    if (typeof url !== 'string' || url === wanted) return;
    show(url, false);
  });
  // The first entry is claimed too, so backing out of the first in-place
  // open lands on the file this page loaded with rather than on nothing.
  history.replaceState({ code: wanted }, '');
  nav.addEventListener('focusin', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('.ex-file') : null;
    if (a) warm(a);
  });
  nav.addEventListener('pointerover', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('.ex-file') : null;
    window.clearTimeout(hoverTimer);
    if (!a) return;
    hoverTimer = window.setTimeout(function () { warm(a); }, 120);
  });
  nav.addEventListener('pointerleave', function () { window.clearTimeout(hoverTimer); });
  }

  // ---- the divider ----
  // One custom property on the grid is the whole model: the stylesheet reads
  // \`--ex-w\`, this sets it. The width is clamped so neither side can vanish
  // and remembered per browser; a remembered width that no longer fits is
  // clamped again on arrival and on every resize.
  var layout = doc.querySelector('.code-layout');
  var handle = layout ? layout.querySelector('[data-split]') : null;
  if (layout && handle && layout.style && layout.style.setProperty) {
  var KEY = 'forge.explorer.width';
  var MIN = Number(handle.getAttribute('aria-valuemin')) || 200;
  var MIN_MAIN = 480;
  var tree = layout.firstElementChild;
  function maxWidth() {
    return Math.max(MIN, Math.floor(layout.getBoundingClientRect().width - MIN_MAIN - handle.offsetWidth - 12));
  }
  function clamp(w) { return Math.min(Math.max(Math.round(w), MIN), maxWidth()); }
  function stored() {
    try { var v = parseInt(window.localStorage.getItem(KEY) || '', 10); return isFinite(v) ? v : null; }
    catch (_) { return null; }
  }
  function keep(w) {
    try { if (w === null) window.localStorage.removeItem(KEY); else window.localStorage.setItem(KEY, String(w)); }
    catch (_) {}
  }
  function announce() {
    handle.setAttribute('aria-valuemax', String(maxWidth()));
    handle.setAttribute('aria-valuenow', String(Math.round(tree.getBoundingClientRect().width)));
  }
  function set(w) {
    layout.style.setProperty('--ex-w', clamp(w) + 'px');
    announce();
  }
  function reset() {
    layout.style.removeProperty('--ex-w');
    keep(null);
    announce();
  }
  function shown() { return getComputedStyle(handle).display !== 'none'; }

  var remembered = stored();
  if (remembered !== null && shown()) set(remembered); else announce();

  var drag = null;
  handle.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    e.preventDefault();
    drag = { x: e.clientX, w: tree.getBoundingClientRect().width };
    layout.setAttribute('data-dragging', '');
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}
  });
  handle.addEventListener('pointermove', function (e) {
    if (!drag) return;
    set(drag.w + (e.clientX - drag.x));
  });
  function release() {
    if (!drag) return;
    drag = null;
    layout.removeAttribute('data-dragging');
    keep(clamp(tree.getBoundingClientRect().width));
  }
  handle.addEventListener('pointerup', release);
  handle.addEventListener('pointercancel', release);
  handle.addEventListener('lostpointercapture', release);
  handle.addEventListener('dblclick', reset);
  handle.addEventListener('keydown', function (e) {
    var w = tree.getBoundingClientRect().width;
    var step = e.shiftKey ? 64 : 16;
    var next = null;
    if (e.key === 'ArrowLeft') next = w - step;
    else if (e.key === 'ArrowRight') next = w + step;
    else if (e.key === 'Home') next = MIN;
    else if (e.key === 'End') next = maxWidth();
    else if (e.key === 'Enter') { e.preventDefault(); reset(); return; }
    if (next === null) return;
    e.preventDefault();
    set(next);
    keep(clamp(next));
  });
  var settle = 0;
  window.addEventListener('resize', function () {
    window.clearTimeout(settle);
    settle = window.setTimeout(function () {
      if (!shown()) return;
      var w = stored();
      if (w !== null) set(w); else announce();
    }, 80);
  });
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
        var list = holder.querySelector('ul');
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
    var note = dlg.querySelector('.palette-foot > span');
    var at = 0;
    var armed = null;      // the action row awaiting its one confirmation

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
 * The highlighting is the classic overlay: a `<pre id="editor-mirror">`
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
  var pathInput = doc.querySelector('.editor-head input[name=path]');
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
    for (var i = from; i < to; i++) out += '<div>' + html[i] + '</div>';
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
    if (was) was.removeAttribute('aria-current');
    var now = mirror.children[at];
    if (now) now.setAttribute('aria-current', 'true');
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
    if (wrap) wrap.removeAttribute('data-mirrored');
    if (mirror) mirror.innerHTML = '';
  }

  function startMirror() {
    if (!mirror || !wrap || wrap.getAttribute('data-mirror') !== '1') return;
    var hl = window.forgeHighlight;
    if (!hl || !hl.Mirror) return;
    if (area.value.length > MAX_MIRROR || lineCount() > MAX_LINES) return;
    lang = wrap.getAttribute('data-lang') || 'plain';
    model = new hl.Mirror(lang);
    wrap.setAttribute('data-mirrored', '1');
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
      var on = t.getAttribute('data-editor-tab') === which;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.setAttribute('data-variant', on ? 'secondary' : 'ghost');
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

/**
 * A rendered file whose viewer needs a library (the 3D view) names its
 * bundle in `data-module`. `loadModules` loads each one once, with the
 * shell's own nonce, and only when a figure on the page asks: on the first
 * paint, and when the code browser swaps such a file in. Only a first-party
 * asset's exact shape is loaded (`/assets/<name>.js`), so nothing a page
 * carries can point it elsewhere. The module mounts its figures itself.
 * Its own string so a test can run it against a stand-in document.
 */
export const moduleLoaderJs = /* js */ `
  var shellNonce = doc.currentScript ? doc.currentScript.nonce : '';
  var modules = {};
  function loadModules() {
    doc.querySelectorAll('[data-module]').forEach(function (el) {
      var src = el.getAttribute('data-module') || '';
      if (!/^\\/assets\\/[a-z0-9-]+\\.js$/.test(src) || modules[src]) return;
      modules[src] = true;
      var s = doc.createElement('script');
      s.type = 'module';
      s.nonce = shellNonce;
      s.src = src;
      doc.head.appendChild(s);
    });
  }
`;

const shellCore = /* js */ `
(function () {
  var doc = document;
  ${modalJs}
  ${imageViewJs}

  // Controls that only mean something with a script running stay hidden
  // until one is: no dead buttons on a page with JavaScript switched off.
  doc.documentElement.classList.add('js');

  // ---- a file the browser cannot play: its note, with Download ----
  ${MEDIA_PLAY_JS}

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
    if (first && !first.closest('.theme-form')) first.focus();
  }, true);
  doc.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    var panel = e.target && e.target.closest ? e.target.closest('.menu-panel') : null;
    if (!panel) return;
    var items = Array.prototype.slice.call(panel.querySelectorAll('.menu-item, .theme-form input'));
    var at = items.indexOf(doc.activeElement);
    var next = items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
    if (next) { next.focus(); e.preventDefault(); }
  });

  // ---- theme: apply instantly, persist once the choice settles ----
  var themeForm = doc.querySelector('.theme-form');
  if (themeForm) {
    var apply = themeForm.querySelector('button[type=submit]');
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
      if (el.select) { el.focus(); el.select(); return true; }
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
    navigator.clipboard.writeText((src.value !== undefined ? src.value : src.textContent).trim()).then(function () {
      done('Copied');
    }, fallback);
  });

  // ---- code line ranges: shift-click extends #L3 to #L3-L9 ----
  // Delegated, not bound to the table: the code browser swaps the file in
  // place, and the new table must behave like the first one did.
  if (doc.querySelector('.code')) {
    var anchor = 0;
    function paint() {
      var m = /^#L(\\d+)(?:-L(\\d+))?$/.exec(location.hash);
      doc.querySelectorAll('.code tr[data-hl]').forEach(function (r) { r.removeAttribute('data-hl'); });
      if (!m) return;
      var lo = Number(m[1]); var hi = Number(m[2] || m[1]);
      if (hi < lo) { var t = lo; lo = hi; hi = t; }
      anchor = lo;
      // An anchor past the cut: the page that draws every line.
      var cut = doc.getElementById('code-cut');
      if (cut && !doc.getElementById('L' + lo)) { location.replace(cut.getAttribute('href') + location.hash); return; }
      for (var n = lo; n <= hi; n++) {
        var row = doc.getElementById('L' + n);
        if (row) row.setAttribute('data-hl', '');
      }
    }
    doc.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('.code .ln a') : null;
      if (!a || !e.shiftKey || !anchor) return;
      e.preventDefault();
      var to = Number((a.getAttribute('href') || '').slice(2));
      if (!to) return;
      history.replaceState(history.state, '', '#L' + Math.min(anchor, to) + '-L' + Math.max(anchor, to));
      paint();
    });
    window.addEventListener('hashchange', paint);
    // A different file: its lines are its own, the old anchor means nothing.
    doc.addEventListener('code:swap', function () { anchor = 0; paint(); });
    paint();
  }

  // ---- a heavy viewer, loaded only by the page that shows one ----
  ${moduleLoaderJs}
  doc.addEventListener('code:swap', loadModules);
  loadModules();

  // ---- settings: the section list narrows as you type ----
  doc.addEventListener('input', function (e) {
    var f = e.target;
    if (!f || !f.hasAttribute || !f.hasAttribute('data-settings-filter')) return;
    var q = f.value.trim().toLowerCase();
    var nav = f.closest('.settings-nav');
    Array.prototype.forEach.call(nav.querySelectorAll('.settings-group'), function (g) {
      var name = (g.getAttribute('aria-label') || '').toLowerCase();
      var shown = 0;
      Array.prototype.forEach.call(g.querySelectorAll('a'), function (a) {
        var hit = q === '' || name.indexOf(q) >= 0 || a.textContent.toLowerCase().indexOf(q) >= 0;
        a.hidden = !hit;
        if (hit) shown++;
      });
      g.hidden = shown === 0;
    });
  });

  // ---- keyboard: sequences from the DOM, so the help can never drift ----
  var seq = []; var last = 0;
  function rows() { return Array.prototype.slice.call(doc.querySelectorAll('[data-nav]')); }
  function move(step) {
    var all = rows();
    if (all.length === 0) return;
    var at = all.indexOf(doc.activeElement.closest ? doc.activeElement.closest('[data-nav]') : null);
    // Nothing focused yet: step away from the row the page is already on
    // (a settings section), not from the top of the list.
    if (at < 0) at = all.indexOf(doc.querySelector('[data-nav][aria-current]'));
    var next = all[Math.min(Math.max(at + step, 0), all.length - 1)] || all[0];
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
  }
  // Esc returns to the list a row was opened from, and the list focuses that
  // row again: the place is kept in sessionStorage for this tab only.
  function place(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (_) {} }
  function placed(k) { try { return sessionStorage.getItem(k); } catch (_) { return null; } }
  doc.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('[data-nav]') : null;
    if (a && !a.matches('a')) a = a.querySelector('a');
    if (a && a.pathname) place('nav-from', JSON.stringify({ list: location.pathname + location.search, to: a.pathname, href: a.getAttribute('href') }));
  });
  // A stored place is only ever read back through this: a malformed or
  // foreign value is no place, and never throws inside a key handler.
  function fromPlace() {
    try {
      var v = JSON.parse(placed('nav-from') || 'null');
      return v && typeof v.list === 'string' && typeof v.to === 'string' && v.list.charAt(0) === '/' && v.list.charAt(1) !== '/' ? v : null;
    } catch (_) { return null; }
  }
  (function () {
    var from = fromPlace();
    if (!from) return;
    if (location.pathname + location.search === from.list) {
      place('nav-from', null);
      var back = rows().filter(function (r) { var a = r.matches('a') ? r : r.querySelector('a'); return a && a.getAttribute('href') === from.href; })[0];
      if (back) { back.focus(); back.scrollIntoView({ block: 'nearest' }); }
    }
  })();
  function leaveToList() {
    var from = fromPlace();
    // The thing on top closes first: an open dialog or menu keeps its Escape.
    if (doc.querySelector('dialog[open], details.menu[open]')) return false;
    if (!from || location.pathname !== from.to || doc.querySelector('[data-nav]')) return false;
    location.assign(from.list);
    return true;
  }
  function openFocused() {
    var el = doc.activeElement.closest ? doc.activeElement.closest('[data-nav]') : null;
    var link = el && (el.matches('a') ? el : el.querySelector('a'));
    if (link) link.click();
  }
  // The page's box: the one field a page exists to be typed in — a thread's
  // comment box, a settings form's first field. The page marks it with
  // \`data-box\` (the help's label is its value); \`c\` puts the caret there
  // the way \`/\` reaches the search box, and Escape leaves it again. A page
  // that declares its own \`c\` (a list's create button) keeps it:
  // shortcuts are matched first.
  var FIELD = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=file]), textarea, select';
  function pageBox() {
    var box = doc.querySelector('[data-box]');
    return box ? (box.matches(FIELD) ? box : box.querySelector(FIELD)) : null;
  }
  function focusBox() {
    var f = pageBox();
    if (!f) return false;
    f.focus();
    if (f.tagName === 'TEXTAREA') { var n = f.value.length; f.setSelectionRange(n, n); }
    return true;
  }
  // The "new issue from here" door: c on a page with no box of
  // its own, Shift C on any page.
  function openNewIssue(e) {
    var p = location.pathname;
    seq.length = 0; e.preventDefault();
    location.assign(p.indexOf('/new/issue') === 0 ? '/new/issue' : '/new/issue?from=' + encodeURIComponent(p));
  }
  // Holding Option (Alt) lays each action's key over it; nothing moves (#8930).
  function hints(on) { if (on) doc.documentElement.setAttribute('data-hints', ''); else doc.documentElement.removeAttribute('data-hints'); }
  doc.addEventListener('keydown', function (e) { if (e.key === 'Alt') hints(true); });
  doc.addEventListener('keyup', function (e) { if (e.key === 'Alt') hints(false); });
  // Escape clears the hints and is then spent: it leaves nothing else.
  var escClosedHints = false;
  doc.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    escClosedHints = doc.documentElement.hasAttribute('data-hints');
    hints(false);
  });
  window.addEventListener('blur', function () { hints(false); });
  doc.addEventListener('keydown', function (e) {
    var t = e.target;
    // Inside an open dialog the dialog owns the keys; none of these apply.
    if (t && t.closest && t.closest('dialog[open]')) return;
    // Chords answer from the same table, ahead of the field guard: the palette
    // is one chord away from anywhere, a field included, and Cmd/Ctrl+Enter
    // sends the form a box belongs to.
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      var chord = rowForKey('Mod+' + (e.key === 'K' ? 'k' : e.key));
      if (chord) { chord[3](e); return; }
    }
    if (t && t.matches && t.matches('input, textarea, select, [contenteditable]')) {
      if (e.key === 'Escape') { e.preventDefault(); t.blur(); }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var row = rowForKey(e.key);
    if (e.key === 'Escape') { if (row) row[3](e); return; }
    if (Date.now() - last > 1000) seq.length = 0;
    last = Date.now();
    seq.push(e.key);
    if (seq.length > 2) seq.splice(0, seq.length - 2);
    var joined = seq.join(' ');
    var target = doc.querySelector('[data-shortcut="' + (window.CSS && CSS.escape ? CSS.escape(joined) : joined) + '"]');
    if (target) {
      seq.length = 0; e.preventDefault(); target.click();
      // A chord that picks a radio leaves the caret in that form's box: the
      // verdict is chosen, the words come next.
      var after = target.type === 'radio' && target.form ? target.form.querySelector('textarea') : null;
      if (after) after.focus();
      return;
    }
    // \`g\` then a letter: a page from the one list (go_pages.ts), only if this viewer may open it.
    if (seq.length === 2 && seq[0] === 'g') {
      var gp = gotoPages().filter(function (p) { return p[3] !== '' && p[3] === e.key; })[0];
      if (gp) { seq.length = 0; e.preventDefault(); location.assign(gp[1]); return; }
    }
    if (row) { seq.length = 0; row[3](e); }
  });

  // ---- help overlay, generated from the shortcuts actually on the page ----
  // One table: the sheet lists its rows and the keydown handler runs them.
  // A row is [shown, what it does, the e.key values it answers, its action];
  // a chord is written 'Mod+<key>' (Cmd or Ctrl) and is read ahead of the field guard.
  function submitBox(f) { if (f.requestSubmit) f.requestSubmit(); else f.submit(); }
  var STATIC_KEYS = [
    ['j / k', 'Move between rows', ['j', 'k'], function (e) { e.preventDefault(); move(e.key === 'j' ? 1 : -1); }],
    ['o or Enter', 'Open the focused row', ['o', 'Enter'], openFocused],
    ['/', 'Focus search', ['/'], function (e) {
      var box = doc.querySelector('[data-search-input]');
      if (box) { e.preventDefault(); box.focus(); box.select(); }
    }],
    ['Cmd/Ctrl K', 'Jump to anywhere', ['Mod+k'], function (e) { e.preventDefault(); openPalette(); }],
    [':', 'Go to a page by name', [':'], function (e) { e.preventDefault(); openGoto(); }],
    ['?', 'This help', ['?'], function (e) { e.preventDefault(); hints(false); openHelp(); }],
    ['Esc', 'Leave a box, close a menu or dialog', ['Escape'], function (e) {
      if (e.defaultPrevented) return;
      if (escClosedHints) { escClosedHints = false; e.preventDefault(); return; }
      if (leaveToList()) e.preventDefault();
    }],
  ];
  // The keys a page row may answer: only these cost a look at the page.
  var PAGE_KEYS = ['c', 'C', 'Mod+Enter'];
  function answers(r, k) { return r[2].indexOf(k) >= 0; }
  function rowForKey(k) {
    var row = STATIC_KEYS.filter(function (r) { return answers(r, k); })[0];
    if (row || PAGE_KEYS.indexOf(k) < 0) return row;
    return pageKeys().filter(function (r) { return answers(r, k); })[0];
  }
  // The rows a page earns by what it carries: a box to type in, a form
  // that sends on Cmd/Ctrl+Enter.
  function pageKeys() {
    var out = [];
    if (pageBox() && !doc.querySelector('[data-shortcut="c"]')) out.push(['c', doc.querySelector('[data-box]').getAttribute('data-box') || 'Write here', ['c'], function (e) { if (focusBox()) e.preventDefault(); else openNewIssue(e); }]);
    // A page that keeps c for its own box shows Shift C alone; any other
    // page opens the new issue on either.
    var ownC = pageBox() || doc.querySelector('[data-shortcut="c"]');
    out.push(ownC ? ['Shift C', 'New issue from this page', ['C'], openNewIssue] : ['c / Shift C', 'New issue from this page', ['c', 'C'], openNewIssue]);
    // Only a form that asked for it (\`data-submit-key\`) is sent: the button's own
    // submit, with its validation. Plain Enter stays a newline.
    if (doc.querySelector('form[data-submit-key]')) out.push(['Cmd/Ctrl Enter', 'Submit the box you are typing in', ['Mod+Enter'], function (e) {
      var f = e.target && e.target.form;
      if (f && f.hasAttribute('data-submit-key')) { e.preventDefault(); submitBox(f); }
    }]);
    return out;
  }
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
      // A control with no text of its own (a radio) is named by its title.
      var label = el.getAttribute('aria-label') || (el.textContent || '').trim() || el.getAttribute('title') || '';
      tbody.appendChild(keyRow(k, label));
    });
    pageKeys().concat(STATIC_KEYS).forEach(function (p) { tbody.appendChild(keyRow(p[0], p[1])); });
    // The pages \`:\` reaches, read from the prompt's own list so the two cannot differ.
    var names = gotoPages().map(function (p) { return p[0]; });
    if (names.length) {
      var pr = doc.createElement('tr');
      var pk = doc.createElement('td'); var pkb = doc.createElement('kbd'); pkb.textContent = ':'; pk.appendChild(pkb);
      var pl = doc.createElement('td'); pl.textContent = 'Pages: ' + names.join(', ');
      pr.appendChild(pk); pr.appendChild(pl); tbody.appendChild(pr);
    }
    // The \`g\` jumps, read from the same list: one row per page this viewer may open by key.
    gotoPages().forEach(function (p) { if (p[3] !== '') tbody.appendChild(keyRow('g ' + p[3], 'Go to ' + p[0])); });
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
  var RECENT_MAX = 50;  // entries kept
  var RECENT_SHOWN = 8; // entries listed while the box is empty
  var VISITS_KEY = 'forge.palette.visits';
  var VISITS_MAX = 5;   // rows in the Recent group while the box is empty (visits, then picked)
  // Pages visited: paths only, never titles; each load records its page once.
  function readVisits() {
    try { var v = JSON.parse(window.localStorage.getItem(VISITS_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; }
  }
  try {
    var seenRows = (function () { try { return JSON.parse(doc.getElementById('palette-index').textContent).items || []; } catch (_) { return []; } })();
    window.localStorage.setItem(VISITS_KEY, JSON.stringify(visitLoad(readVisits(), window.location.pathname, seenRows, VISITS_MAX + 1)));
  } catch (_) {}
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
    try { return readUses(JSON.parse(window.localStorage.getItem(RECENT_KEY) || '[]'), RECENT_MAX); } catch (_) { return []; }
  }
  function remember(r) {
    try {
      var next = recordUse(readRecent(), { t: r.t, h: r.h, g: r.g === 'Recent' ? (r.d || '') : r.g }, Date.now(), RECENT_MAX);
      window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
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
        : (function () {
            var row = { t: r.owner + '/' + r.name, h: '/' + r.owner + '/' + r.name, g: 'Repositories', n: r.name };
            if (r.owner === loadIndex().me) row.m = 1;
            if (r.app) { row.x = 'App'; row.o = row.h + '/app/production/open'; }
            return row;
          })());
    });
    // An issue lives at /issues/:n and a pull request at /pulls/:n in every
    // mode (\`tellHref\`/\`changeHref\`, src/web/studio/nouns.ts).
    (out.issues || []).slice(0, 5).forEach(function (i) {
      if (i.source !== 'local') return;
      var tell = i.kind === 'issue';
      var noun = tell ? 'issues' : 'pulls';
      rows.push({
        t: i.title,
        h: '/' + i.repo.owner + '/' + i.repo.name + '/' + noun + '/' + i.number,
        g: tell ? 'Issues' : 'Pull requests',
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

  // "Tell the crew" from a page: the server's own composer (the thread's
  // comment box saying a tell) laid over the bottom of the page, fixed, so
  // nothing shifts. Enter sends it with the page's path as \`from\`; no
  // navigation. Any failure falls back to the plain link.
  function tellInPlace(href) {
    var old = doc.getElementById('tell-here');
    if (old) old.remove();
    fetch(href + '&in=place', { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('no');
      return r.text();
    }).then(function (h) {
      var box = doc.createElement('div');
      box.id = 'tell-here';
      box.className = 'tell-here';
      box.innerHTML = h;
      var form = box.querySelector('form');
      var ta = box.querySelector('textarea');
      var note = box.querySelector('.form-actions .muted');
      if (!form || !ta) throw new Error('no');
      doc.body.appendChild(box);
      var sending = false;
      function send() {
        if (sending || ta.value.trim() === '') return;
        sending = true;
        fetch(form.action, {
          method: 'POST', credentials: 'same-origin',
          headers: { accept: 'application/json' },
          body: new URLSearchParams(new FormData(form))
        }).then(function (r) { return r.json(); }).then(function (d) {
          if (note) note.textContent = d.ok ? d.flash : d.error;
          if (d.ok) { ta.value = ''; window.setTimeout(function () { box.remove(); }, 2500); }
        }).catch(function () {
          if (note) note.textContent = '${NOT_TOLD_WORDS}';
        }).then(function () { sending = false; });
      }
      form.addEventListener('submit', function (e) { e.preventDefault(); send(); });
      box.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.stopPropagation(); box.remove(); }
        else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.target === ta) {
          e.preventDefault();
          send();
        }
      });
      ta.focus();
    }).catch(function () { location.href = href; });
  }

  // The palette's tell: the feed composer's own POST (same action, same
  // same-origin check), with this page's path as where it was said. The
  // answer is one line at the top of the page, in the flash's own classes.
  function tellFromHere(app, text) {
    var main = doc.getElementById('main');
    function say(tone, message, href) {
      if (!main) return;
      var old = main.querySelector('.toast[data-palette-tell]');
      if (old) old.remove();
      var t = doc.createElement('div');
      t.className = 'toast';
      t.setAttribute('data-tone', tone);
      t.setAttribute('data-palette-tell', '');
      t.setAttribute('role', 'status');
      var b = doc.createElement('div');
      b.className = 'toast-body';
      b.appendChild(doc.createTextNode(message));
      if (href && href.charAt(0) === '/' && href.charAt(1) !== '/') {
        b.appendChild(doc.createTextNode(' \u00b7 '));
        var a = doc.createElement('a');
        a.setAttribute('href', href);
        a.textContent = 'See it';
        b.appendChild(a);
      }
      t.appendChild(b);
      var x = doc.createElement('button');
      x.type = 'button';
      x.className = 'btn';
      x.setAttribute('data-variant', 'link');
      x.setAttribute('data-size', 'sm');
      x.setAttribute('aria-label', 'Dismiss');
      x.textContent = '\u00d7';
      x.onclick = function () { t.remove(); };
      t.appendChild(x);
      t.tabIndex = -1;
      main.insertBefore(t, main.firstChild);
      // The palette has just closed: the answer takes the focus, then clears itself.
      t.focus({ preventScroll: false });
      window.setTimeout(function () { if (t.parentNode) t.remove(); }, 12000);
    }
    fetch('/tell', {
      method: 'POST', credentials: 'same-origin',
      headers: { accept: 'application/json' },
      body: new URLSearchParams({ app: app, text: text, from: location.pathname })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) say('success', d.flash, d.href);
      else say('danger', d.error || '${NOT_TOLD_WORDS}');
    }).catch(function () { say('danger', '${NOT_TOLD_WORDS}'); });
  }

  // ---- go to a page: one line, the server's own list filtered in place ----
  var closeGoto = null;
  // The pages ride in this script (cached once); the page wears only the viewer's level in data-go.
  var GO_PAGES = ${JSON.stringify(goPagesData())};
  function gotoPages() {
    var lv = +(doc.body.getAttribute('data-go') || 0);
    return GO_PAGES.filter(function (p) { return p[2] <= lv; });
  }
  ${GO_MATCH_JS}
  var GOTO_HINT = 'Enter opens the first, Esc closes';
  function gotoDialog() {
    var dlg = doc.getElementById('goto');
    if (dlg) return dlg;
    dlg = doc.createElement('dialog');
    dlg.id = 'goto'; dlg.className = 'dialog palette'; dlg.setAttribute('aria-label', 'Go to a page');
    var input = doc.createElement('input');
    input.className = 'input palette-input'; input.type = 'text'; input.placeholder = 'Page name';
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-label', 'Go to a page');
    input.setAttribute('aria-controls', 'goto-list'); input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocapitalize', 'off'); input.spellcheck = false;
    var box = doc.createElement('div'); box.className = 'palette-list'; box.id = 'goto-list';
    box.setAttribute('role', 'listbox'); box.setAttribute('aria-label', 'Pages');
    gotoPages().forEach(function (p, i) {
      var a = doc.createElement('div'); a.className = 'palette-item'; a.setAttribute('role', 'option');
      a.id = 'goto-' + i; a.setAttribute('aria-selected', 'false'); a.setAttribute('data-href', p[1]);
      var sp = doc.createElement('span'); sp.className = 'grow'; sp.textContent = p[0]; a.appendChild(sp); box.appendChild(a);
    });
    var foot = doc.createElement('div'); foot.className = 'palette-foot'; foot.id = 'goto-foot';
    foot.setAttribute('role', 'status'); foot.textContent = GOTO_HINT;
    dlg.appendChild(input); dlg.appendChild(box); dlg.appendChild(foot);
    doc.body.appendChild(dlg);
    return dlg;
  }
  function openGoto() {
    var dlg = gotoDialog();
    if (!dlg.showModal) { location.href = '/search'; return; }
    if (closeGoto) { closeGoto(); return; }
    var input = dlg.querySelector('input');
    var foot = dlg.querySelector('#goto-foot');
    var pages = gotoPages();
    var opts = Array.prototype.slice.call(dlg.querySelectorAll('[role=option]'));
    var lead = null;
    function paint() {
      var hits = goMatch(pages, input.value);
      lead = hits.length ? opts[pages.indexOf(hits[0])] : null;
      opts.forEach(function (o, i) {
        o.hidden = hits.indexOf(pages[i]) < 0;
        o.setAttribute('aria-selected', o === lead ? 'true' : 'false');
      });
      if (lead) input.setAttribute('aria-activedescendant', lead.id); else input.removeAttribute('aria-activedescendant');
      foot.textContent = hits.length ? GOTO_HINT : 'No page called that';
    }
    function go(o) { location.assign(o.getAttribute('data-href')); }
    function onKey(e) {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      if (lead) go(lead);
    }
    function onClick(e) { var o = e.target.closest && e.target.closest('[role=option]'); if (o) go(o); }
    input.value = '';
    paint();
    closeGoto = openModal(dlg, function () {
      closeGoto = null; dlg.removeEventListener('keydown', onKey);
      dlg.removeEventListener('click', onClick); input.removeEventListener('input', paint);
    });
    dlg.addEventListener('keydown', onKey);
    dlg.addEventListener('click', onClick);
    input.addEventListener('input', paint);
    input.focus();
  }

  var closePalette = null;
  function openPalette() {
    var dlg = doc.getElementById('palette');
    if (!dlg || !dlg.showModal) { location.href = '/search'; return; }
    if (closePalette) { closePalette(); return; }
    var input = dlg.querySelector('.palette-input');
    var list = dlg.querySelector('.palette-list');
    var items = (loadIndex().items || []).map(function (i) {
      var r = { t: String(i.t), h: String(i.h), g: i.c ? String(i.c) : 'Go to' };
      if (i.n) r.n = String(i.n);
      if (i.m === 1) r.m = 1;
      if (typeof i.k === 'number') r.k = i.k;
      if (i.a === 1) r.a = 1;
      if (i.d) r.d = String(i.d);
      if (i.x) r.x = String(i.x);
      if (i.o && String(i.o).charAt(0) === '/') r.o = String(i.o);
      if (i.p && typeof i.p === 'object' && r.h.charAt(0) === '/') r.p = i.p;
      return r;
    });
    var tellApp = (loadIndex().tell || {}).app;
    // Storage is read once per opening, not per keystroke.
    var openedAt = Date.now();
    var visits = readVisits();
    var uses = readRecent();
    var recentHrefs = frecencyOrder(uses, openedAt).slice(0, RECENT_SHOWN).map(function (r) { return r.h; });
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
      if (r.a) a.setAttribute('data-action', '');
      if (r.p) a.setAttribute('data-post', JSON.stringify(r.p));
      var t = doc.createElement('span');
      t.className = 'grow';
      t.textContent = r.t;
      a.appendChild(t);
      if (r.x) {
        var x = doc.createElement('span');
        x.className = 'cat';
        x.textContent = r.x;
        a.appendChild(x);
      }
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
      armed = null;
      var q = input.value.trim();
      var pool = palettePool(q, items, served, visits, uses, window.location.pathname, openedAt, VISITS_MAX);
      // "#123" on a repository's page: that number, built here from the page's own path (the server read no issue for it).
      var hereBase = loadIndex().here;
      var num = /^#(\\d+)$/.exec(q);
      if (num && typeof hereBase === 'string' && hereBase.charAt(0) === '/') {
        // Issues and pulls share one number space and each address redirects to the other kind, so one row serves both.
        pool = [
          { t: 'Go to #' + num[1], h: hereBase + '/issues/' + num[1], g: 'Issues and pulls', d: '#' + num[1], k: Number(num[1]) },
        ].concat(pool);
      }
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
          // The app is its own option under its repository: reachable by
          // arrow, touch and screen reader, not only by Cmd/Ctrl+Enter.
          if (r.o) {
            var ar = { t: 'Open the app of ' + r.t, h: r.o, g: g.title };
            var aa = row(ar, 'palette-o' + nodes.length);
            nodes.push(aa); shown.push(ar);
            box.appendChild(aa);
          }
        });
        frag.appendChild(box);
      });
      // Tell from anywhere: once there are words, the last row says them to the crew.
      if (tellApp && q.length >= 3) {
        var tbox = doc.createElement('div');
        tbox.className = 'palette-group';
        tbox.setAttribute('role', 'group');
        // A mutation is a button in a POST form, as /tell takes it without
        // script too; the click is caught below and sent in place.
        var tf = doc.createElement('form');
        tf.method = 'post'; tf.action = '/tell';
        [['app', tellApp], ['text', q], ['from', location.pathname]].forEach(function (kv) {
          var hid = doc.createElement('input');
          hid.type = 'hidden'; hid.name = kv[0]; hid.value = kv[1];
          tf.appendChild(hid);
        });
        var ta = doc.createElement('button');
        ta.type = 'submit';
        ta.className = 'palette-item';
        ta.id = 'palette-o' + nodes.length;
        ta.setAttribute('role', 'option');
        ta.setAttribute('aria-selected', 'false');
        ta.setAttribute('data-tell', q);
        var tt = doc.createElement('span');
        tt.className = 'grow';
        tt.textContent = 'Tell the crew: ' + q;
        ta.appendChild(tt);
        tf.appendChild(ta);
        nodes.push(ta); shown.push({ t: tt.textContent, h: '#tell', g: 'Tell' });
        tbox.appendChild(tf);
        frag.appendChild(tbox);
      }
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
      else if (k === 'Enter' && (e.metaKey || e.ctrlKey) && shown[at] && shown[at].o) {
        e.preventDefault();
        remember(shown[at]);
        location.href = shown[at].o;
      }
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
      if (i === -1) return;
      // An action asks once: the first press arms the row, the second runs it.
      // Navigation rows have no data-action and never ask.
      if (a.hasAttribute('data-action') && armed !== a.getAttribute('href')) {
        e.preventDefault();
        armed = a.getAttribute('href');
        var label = a.querySelector('.grow');
        var say = 'Tap or press Enter again to confirm: ' + shown[i].t;
        if (label) label.textContent = shown[i].t + ' \u2014 tap or press Enter again to confirm';
        a.setAttribute('aria-description', 'Tap or press Enter again to confirm');
        var live = dlg.querySelector('[data-armed]');
        if (!live) {
          live = doc.createElement('div'); live.className = 'sr-only';
          live.setAttribute('aria-live', 'polite'); live.setAttribute('data-armed', '');
          dlg.appendChild(live);
        }
        live.textContent = say;
        return;
      }
      if (a.hasAttribute('data-tell')) {
        e.preventDefault();
        close();
        tellFromHere(tellApp, a.getAttribute('data-tell'));
        return;
      }
      if (a.hasAttribute('data-post')) {
        // A mutation posts the page's own form; it is never followed as a GET.
        e.preventDefault();
        close();
        var pf = doc.createElement('form');
        pf.method = 'post'; pf.action = a.getAttribute('href') || '/';
        var fields = {};
        try { fields = JSON.parse(a.getAttribute('data-post') || '{}'); } catch (_) {}
        Object.keys(fields).forEach(function (k) {
          var hid = doc.createElement('input');
          hid.type = 'hidden'; hid.name = k; hid.value = String(fields[k]);
          pf.appendChild(hid);
        });
        var go = doc.createElement('button');
        go.type = 'submit';
        pf.appendChild(go);
        pf.hidden = true;
        doc.body.appendChild(pf);
        go.click();
        return;
      }
      remember(shown[i]);
      var h = a.getAttribute('href') || '';
      if (/^\\/[^\\/?#]+\\/[^\\/?#]+\\/tell\\?from=/.test(h) && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        close();
        tellInPlace(h);
      }
    };
    input.focus();
  }
  doc.querySelectorAll('[data-palette]').forEach(function (b) {
    b.addEventListener('click', function (e) { e.preventDefault(); openPalette(); });
  });
  // /search at phone width IS the palette: the bare search page opens the
  // same sheet, same rows, same ranking. The page's own form stays beneath
  // it for a closed sheet and for no script at all.
  if (opensAsSheet(!!doc.querySelector('[data-palette-auto]'), window.innerWidth)) openPalette();
  doc.querySelectorAll('[data-help]').forEach(function (b) {
    b.addEventListener('click', function (e) { e.preventDefault(); openHelp(); });
  });

  // ---- colour pickers show the hex they are about to submit ----
  doc.querySelectorAll('.color-field input[type="color"]').forEach(function (i) {
    var out = i.parentNode.querySelector('[data-hex]');
    if (!out) return;
    i.addEventListener('input', function () { out.textContent = i.value; });
  });
})();
`;

/** The shell and the one script that makes actions answer at once (`act_now.ts`). */
export const shellJs = `${shellCore}\n${actNowJs}\n${pickJs}`;

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
  var TONES = { open: 'success', reconnecting: 'attn' };
  doc.addEventListener('forge:live', function (e) {
    if (!live || !e.detail) return;
    live.setAttribute('data-state', e.detail.state);
    var dot = live.querySelector('.dot');
    var tone = TONES[e.detail.state];
    if (!dot) return;
    if (tone) dot.setAttribute('data-tone', tone);
    else dot.removeAttribute('data-tone');
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
  var last = 0;
  var MIN_GAP = 1500;
  // A region with no address of its own is the whole page: one render of
  // everything. That is never fetched per event, only once per PAGE_GAP.
  var PAGE_GAP = 30000;
  var lastPage = 0;
  // What each address last answered with, so the next ask is conditional:
  // a region that did not change comes back 304 and paints nothing.
  var tags = {};
  // Relative times ("3m ago") drift on their own; two renders that differ
  // only there are the same region, and the clock is not a change.
  function same(a, b) {
    var t = /<time\\b[^>]*>[^<]*<\\/time>/g;
    return a.replace(t, '') === b.replace(t, '');
  }
  function swap(fresh, ids) {
    ids.forEach(function (id) {
      var mine = document.getElementById(id);
      var theirs = fresh.getElementById(id);
      if (!mine || !theirs) return;
      // A region mid-action (something in it marked data-busy while its
      // post is in flight) is never pulled out from under the click; the next
      // matching event tries the swap again.
      if (mine.querySelector('[data-busy]')) return;
      // Likewise a region with a ticked box (apps picked for Archive, or the
      // Select toggle itself): a tap on a phone does not focus a checkbox, so
      // focus cannot be what protects the picks.
      if (mine.querySelector('input[type=checkbox]:checked')) return;
      var active = document.activeElement;
      if (active && mine.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
      // Nor a box with words already typed in it, focused or not.
      var typed = Array.prototype.some.call(mine.querySelectorAll('input.input, textarea'), function (i) { return i.value !== ''; });
      if (typed) return;
      if (same(mine.innerHTML, theirs.innerHTML)) return;
      // A disclosure the reader opened stays open across the swap.
      var opened = Array.prototype.map.call(mine.querySelectorAll('details[id][open]'), function (d) { return d.id; });
      mine.innerHTML = theirs.innerHTML;
      opened.forEach(function (i) { var d = document.getElementById(i); if (d) d.open = true; });
      Array.prototype.forEach.call(theirs.attributes, function (a) { if (a.name !== 'id') mine.setAttribute(a.name, a.value); });
      mine.dispatchEvent(new CustomEvent('forge:swapped', { bubbles: true }));
    });
  }
  // A region with an address of its own (data-live-src) answers for itself:
  // the server renders that region and nothing else, and its etag says
  // whether anything changed. Regions without one share one fetch of the
  // page, which is the fallback, not the design.
  function pull(src, ids) {
    var own = src !== location.href;
    var headers = { accept: 'text/html' };
    if (tags[src]) headers['if-none-match'] = tags[src];
    fetch(src, { headers: headers, credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 304) return null;
        if (!r.ok) return Promise.reject(r);
        var tag = r.headers.get('etag');
        if (tag) tags[src] = tag;
        return r.text();
      })
      .then(function (text) {
        if (text === null) return;
        if (own) {
          // A fragment's icons come inlined (layout.fragment), so it needs
          // nothing from this page's sprite. Its tag is stamped on it too,
          // for when a proxy between us dropped the header.
          var holder = document.createElement('template');
          holder.innerHTML = text;
          var stamped = holder.content.querySelector('[data-etag]');
          if (stamped) tags[src] = '"' + stamped.getAttribute('data-etag') + '"';
          swap(holder.content, ids);
          return;
        }
        // Parse a copy without the page's own style element: the swap only
        // ever reads a region's innerHTML, never the head, and the fresh
        // page carries a fresh nonce the live document's CSP cannot match —
        // parsing it would log an inline-style violation for nothing.
        var fresh = new DOMParser().parseFromString(text.replace(/<(style)[^>]*>[\\s\\S]*?<\\/\\1>/gi, ''), 'text/html');
        // The fresh page's drawings come across first: a region swapping in
        // an icon this page never painted would otherwise point at a
        // <symbol> the document does not have (src/web/icons.ts).
        var theirSprite = fresh.querySelector('.sprite');
        var mySprite = document.querySelector('.sprite');
        if (theirSprite && mySprite) mySprite.replaceWith(theirSprite);
        swap(fresh, ids);
      })
      .catch(function () {});
  }
  function refresh() {
    timer = null;
    // Hidden, the page waits: a tab in the background paints nothing, and
    // the first look back brings everything at once.
    if (document.hidden) return;
    var ids = Object.keys(due);
    due = {};
    if (ids.length === 0) return;
    last = Date.now();
    var groups = {};
    var held = false;
    ids.forEach(function (id) {
      var region = document.getElementById(id);
      if (!region) return;
      var src = region.getAttribute('data-live-src') || location.href;
      if (src === location.href && last - lastPage < PAGE_GAP) { due[id] = true; held = true; return; }
      (groups[src] = groups[src] || []).push(id);
    });
    if (groups[location.href]) lastPage = last;
    if (held && timer === null) timer = setTimeout(refresh, lastPage + PAGE_GAP - Date.now());
    Object.keys(groups).forEach(function (src) { pull(src, groups[src]); });
  }
  var source = null;
  var since = '';
  var retry = null;
  // The stream's own state, for a page that shows whether it is connected.
  function state(s) { document.dispatchEvent(new CustomEvent('forge:live', { detail: { state: s } })); }
  // The browser resumes a dropped stream by itself, from the last id it
  // saw. When it gives up (CLOSED: a long offline, a sleeping laptop) we
  // open a new one ourselves, from that same id: nothing is replayed twice
  // and nothing in between is lost.
  function connect() {
    if (retry) { clearTimeout(retry); retry = null; }
    if (source) source.close();
    source = since ? new EventSource('/events?since=' + encodeURIComponent(since)) : new EventSource('/events');
    source.addEventListener('open', function () { state('open'); });
    source.addEventListener('error', function () {
      state('reconnecting');
      if (source.readyState === 2 && retry === null) retry = setTimeout(connect, 3000);
    });
    source.addEventListener('forge', onForge);
    // New lines of a run's log: not history, so no id to resume from. Handed
    // to whoever tails a run on this page (\`appTailJs\`).
    source.addEventListener('run.log', function (event) {
      var data;
      try { data = JSON.parse(event.data); } catch (err) { return; }
      document.dispatchEvent(new CustomEvent('forge:run-log', { detail: data }));
    });
  }
  function onForge(event) {
    if (event.lastEventId) since = event.lastEventId;
    var data;
    try { data = JSON.parse(event.data); } catch (err) { return; }
    document.dispatchEvent(new CustomEvent('forge:event', { detail: data }));
    var hit = false;
    Array.prototype.forEach.call(document.querySelectorAll('[data-live]'), function (region) {
      var patterns = (region.getAttribute('data-live') || '').split(',').map(function (p) { return p.trim(); }).filter(Boolean);
      if (region.id && matches(patterns, data.kind, data.repo, region)) { due[region.id] = true; hit = true; }
    });
    // Events come in bursts — a run starts, its check queues, a deploy
    // begins — and one fetch answers the burst: never sooner than a beat
    // after the first, never more often than every MIN_GAP.
    if (hit && timer === null)
      timer = setTimeout(refresh, Math.max(600, last + MIN_GAP - Date.now()));
  }
  connect();
  // Back online: reconnect from the last id and look at every region once,
  // in case the replay window no longer reaches back that far.
  window.addEventListener('online', function () {
    connect();
    Array.prototype.forEach.call(document.querySelectorAll('[data-live]'), function (r) { if (r.id) due[r.id] = true; });
    if (timer === null) timer = setTimeout(refresh, 300);
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && Object.keys(due).length > 0 && timer === null) timer = setTimeout(refresh, 100);
  });
})();
`;
