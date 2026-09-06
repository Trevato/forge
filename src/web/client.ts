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
    fetch(form.action, {
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
        source.close();
        location.reload();
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
  if (!log || typeof EventSource === 'undefined') return;
  var url = log.getAttribute('data-stream');
  if (!url) return;
  var meta = document.querySelector('meta[http-equiv="refresh"]');
  if (meta && !/url=/i.test(meta.getAttribute('content') || '')) meta.remove();

  var state = document.getElementById('run-state');
  var summary = document.getElementById('run-summary');
  var cancel = document.getElementById('run-cancel');
  var follow = true;
  var seeded = false;
  log.addEventListener('scroll', function () {
    follow = log.scrollTop + log.clientHeight >= log.scrollHeight - 12;
  });

  var words = {
    queued: ['Queued', 'secondary'], running: ['Running', 'attn'],
    ok: ['Passed', 'success'], failed: ['Failed', 'danger'], cancelled: ['Cancelled', 'outline'],
  };
  function paint(run) {
    if (state) {
      var look = words[run.state];
      var badge = state.querySelector('.badge') || state;
      if (look) {
        badge.setAttribute('data-variant', look[1]);
        badge.textContent = run.state === 'ok' && run.kind === 'agent' ? 'Done' : look[0];
      }
    }
    if (summary && run.summary) summary.textContent = run.summary;
    if (cancel) cancel.hidden = true;
  }

  var source = new EventSource(url);
  var empty = document.getElementById('run-empty');
  source.addEventListener('line', function (event) {
    if (!seeded) { log.textContent = ''; seeded = true; if (empty) empty.hidden = true; }
    log.appendChild(document.createTextNode(event.data + '\\n'));
    if (follow) log.scrollTop = log.scrollHeight;
  });
  source.addEventListener('done', function (event) {
    source.close();
    var run;
    try { run = JSON.parse(event.data); } catch (err) { return; }
    paint(run);
  });
  source.addEventListener('error', function () { /* a reload shows the log as written */ });
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
    dlg.showModal();
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
    if (t && t.matches && t.matches('input, textarea, select, [contenteditable]')) {
      if (e.key === 'Escape') t.blur();
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      if (e.key === 'k') { e.preventDefault(); openPalette(); }
      return;
    }
    if (e.altKey) return;
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
    dlg.showModal();
  }

  // ---- command palette ----
  var index = null;
  function loadIndex() {
    if (index) return index;
    var el = doc.getElementById('palette-index');
    try { index = JSON.parse(el.textContent); } catch (_) { index = { items: [] }; }
    return index;
  }
  function openPalette() {
    var dlg = doc.getElementById('palette');
    if (!dlg || !dlg.showModal) { location.href = '/search'; return; }
    var input = dlg.querySelector('.palette-input');
    var list = dlg.querySelector('.palette-list');
    var items = loadIndex().items || [];
    var shown = [];
    var at = 0;
    var remote = null;
    var remoteTimer = 0;
    // Every row is built from DOM nodes: the titles below are repository
    // names, issue titles and lines of code, and page text is exactly what
    // must never be parsed as markup.
    function itemRow(href, title, cat) {
      var a = doc.createElement('a');
      a.className = 'palette-item';
      a.setAttribute('role', 'option');
      // Same-origin paths only: the index is ours, and this keeps it so.
      a.setAttribute('href', String(href).charAt(0) === '/' ? href : '/');
      var t = doc.createElement('span');
      t.className = 'grow';
      t.textContent = title;
      a.appendChild(t);
      if (cat) {
        var c = doc.createElement('span');
        c.className = 'cat';
        c.textContent = cat;
        a.appendChild(c);
      }
      list.appendChild(a);
      return a;
    }
    function heading(text) {
      var h = doc.createElement('span');
      h.className = 'menu-title';
      h.textContent = text;
      list.appendChild(h);
    }
    function selectFirst() {
      var nodes = list.querySelectorAll('.palette-item');
      if (nodes.length > 0 && !list.querySelector('.palette-item[aria-selected="true"]')) {
        nodes[0].setAttribute('aria-selected', 'true');
      }
    }
    function emptyNote() {
      var p = doc.createElement('p');
      p.className = 'palette-empty';
      p.appendChild(doc.createTextNode('Nothing here. '));
      var more = doc.createElement('a');
      more.href = '/search?q=' + encodeURIComponent(input.value);
      more.textContent = 'Search everything';
      p.appendChild(more);
      list.appendChild(p);
    }

    function render() {
      var q = input.value.trim().toLowerCase();
      shown = items.filter(function (i) {
        return q === '' || (i.t + ' ' + (i.c || '')).toLowerCase().indexOf(q) !== -1;
      }).slice(0, 12);
      at = 0;
      list.textContent = '';
      shown.forEach(function (i) { itemRow(i.h, i.t, i.c); });
      selectFirst();
      if (shown.length === 0) emptyNote();
      ask(input.value.trim());
    }

    // The forge's own search, behind the palette. It is the same action the
    // /search page and the API call, so the palette can never disagree with
    // the page behind it — and it is debounced and cancelled, because a
    // keystroke is not a reason to grep every repository twice.
    function paint(out) {
      var note = list.querySelector('.palette-empty');
      if (note) note.remove();
      var titled = false;
      (out.repos || []).slice(0, 5).forEach(function (r) {
        if (!titled) { heading('Repositories'); titled = true; }
        itemRow(
          r.source === 'origin' ? '/origins/' + r.originId + '/r/' + r.fullName : '/' + r.owner + '/' + r.name,
          r.source === 'origin' ? r.fullName : r.owner + '/' + r.name,
          r.source === 'origin' ? 'on an origin' : 'repository'
        );
      });
      titled = false;
      (out.issues || []).slice(0, 5).forEach(function (i) {
        if (i.source !== 'local') return;
        if (!titled) { heading('Issues and pulls'); titled = true; }
        itemRow(
          '/' + i.repo.owner + '/' + i.repo.name + '/' + (i.kind === 'issue' ? 'issues' : 'pulls') + '/' + i.number,
          i.title,
          i.repo.owner + '/' + i.repo.name + ' #' + i.number
        );
      });
      titled = false;
      (out.code || []).slice(0, 5).forEach(function (c) {
        if (!titled) { heading('Code'); titled = true; }
        itemRow(
          '/' + c.repo.owner + '/' + c.repo.name + '/blob/HEAD/' + c.path + '#L' + c.line,
          c.path + ':' + c.line,
          (c.text || '').trim().slice(0, 40)
        );
      });
      if (!list.querySelector('.palette-item')) emptyNote();
      selectFirst();
    }
    function ask(q) {
      window.clearTimeout(remoteTimer);
      if (remote) { remote.abort(); remote = null; }
      if (q.length < 2 || typeof fetch === 'undefined') return;
      remoteTimer = window.setTimeout(function () {
        var ctl = new AbortController();
        remote = ctl;
        fetch('/api/v1/search?limit=5&q=' + encodeURIComponent(q), {
          signal: ctl.signal, headers: { accept: 'application/json' },
        })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (out) {
            if (!out || ctl.signal.aborted || input.value.trim() !== q) return;
            paint(out);
          }, function () {});
      }, 120);
    }
    function select(n) {
      var nodes = list.querySelectorAll('.palette-item');
      if (nodes.length === 0) return;
      at = (n + nodes.length) % nodes.length;
      nodes.forEach(function (el, i) { el.setAttribute('aria-selected', i === at ? 'true' : 'false'); });
      nodes[at].scrollIntoView({ block: 'nearest' });
    }
    input.value = '';
    render();
    input.oninput = render;
    input.onkeydown = function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); select(at + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); select(at - 1); }
      else if (e.key === 'Enter') {
        var sel = list.querySelectorAll('.palette-item')[at];
        if (sel) { e.preventDefault(); location.href = sel.getAttribute('href'); }
      }
    };
    dlg.addEventListener('close', function () {
      window.clearTimeout(remoteTimer);
      if (remote) { remote.abort(); remote = null; }
    }, { once: true });
    dlg.showModal();
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
