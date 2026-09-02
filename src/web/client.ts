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

export const shellJs = /* js */ `
(function () {
  var doc = document;

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
  doc.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-copy]') : null;
    if (!b || !navigator.clipboard) return;
    var src = doc.getElementById(b.getAttribute('data-copy'));
    if (!src) return;
    e.preventDefault();
    navigator.clipboard.writeText(src.textContent.trim()).then(function () {
      var was = b.getAttribute('title');
      b.setAttribute('data-tip', 'Copied');
      window.setTimeout(function () { b.removeAttribute('data-tip'); b.setAttribute('title', was || ''); }, 1200);
    }, function () {});
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
    function render() {
      var q = input.value.trim().toLowerCase();
      shown = items.filter(function (i) {
        return q === '' || (i.t + ' ' + (i.c || '')).toLowerCase().indexOf(q) !== -1;
      }).slice(0, 40);
      at = 0;
      list.textContent = '';
      if (shown.length === 0) {
        var p = doc.createElement('p');
        p.className = 'palette-empty';
        p.appendChild(doc.createTextNode('Nothing here. '));
        var more = doc.createElement('a');
        more.href = '/search?q=' + encodeURIComponent(input.value);
        more.textContent = 'Search everything';
        p.appendChild(more);
        list.appendChild(p);
        return;
      }
      shown.forEach(function (i, n) {
        var a = doc.createElement('a');
        a.className = 'palette-item';
        a.setAttribute('role', 'option');
        // Same-origin paths only: the index is ours, and this keeps it so.
        a.setAttribute('href', String(i.h).charAt(0) === '/' ? i.h : '/');
        if (n === 0) a.setAttribute('aria-selected', 'true');
        var title = doc.createElement('span');
        title.className = 'grow';
        title.textContent = i.t;
        a.appendChild(title);
        if (i.c) {
          var cat = doc.createElement('span');
          cat.className = 'cat';
          cat.textContent = i.c;
          a.appendChild(cat);
        }
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
    dlg.showModal();
    input.focus();
  }
  doc.querySelectorAll('[data-palette]').forEach(function (b) {
    b.addEventListener('click', function (e) { e.preventDefault(); openPalette(); });
  });
})();
`;
