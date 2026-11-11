/**
 * /system's client: sorting the process table by CPU or memory (`c`, `m`, or the buttons) and one EventSource, each pushed sample patched into the
 * element of the id it names. No reload, no timer, no polling; EventSource
 * itself reconnects after a roll (the stream's `retry:` hint) and the first
 * frame of the new stream is the latest sample. `?pause` opens nothing.
 * The markup comes from our own server, escaped there, so it is set as HTML.
 */
/**
 * The ordering of the process table, apart from the page so a test can run it:
 * `rank(items, key, kinds)` is a new array in kind order (as `kinds` lists
 * them), the biggest `key` first within a kind; ties keep their place.
 */
export const procSortJs = /* js */ `
function rank(items, key, kinds) {
  return items
    .map(function (item, i) { return { item: item, i: i }; })
    .sort(function (a, b) {
      return (kinds.indexOf(a.item.kind) - kinds.indexOf(b.item.kind)) || (b.item[key] - a.item[key]) || (a.i - b.i);
    })
    .map(function (x) { return x.item; });
}
`;

export const systemLiveJs = /* js */ `
(function () {
  ${procSortJs}
  var KINDS = ['forge', 'crew', 'check', 'app', 'host'], key = 'cpu';
  function read(el) {
    return { el: el, kind: el.getAttribute('data-kind'), cpu: Number(el.getAttribute('data-cpu')) || 0, mem: Number(el.getAttribute('data-mem')) || 0 };
  }
  function sort() {
    var table = document.querySelector('#sys-procs table');
    if (!table) return;
    var bodies = Array.prototype.slice.call(table.tBodies);
    bodies.forEach(function (tb) {
      var rows = Array.prototype.slice.call(tb.rows, 1).map(read);
      rank(rows, key, []).forEach(function (r) { tb.appendChild(r.el); });
    });
    rank(bodies.map(read), key, KINDS).forEach(function (b) { table.appendChild(b.el); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-sort]'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-sort') === key));
    });
  }
  function pick(k) { key = k; sort(); }
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest && e.target.closest('[data-sort]');
    if (b) pick(b.getAttribute('data-sort'));
  });
  document.addEventListener('keydown', function (e) {
    var t = e.target, tag = t && t.tagName;
    if (e.ctrlKey || e.metaKey || e.altKey || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    if ((tag === 'BUTTON' || tag === 'A') && !(t.hasAttribute && t.hasAttribute('data-sort'))) return;
    if (e.key === 'c') pick('cpu'); else if (e.key === 'm') pick('mem');
  });
  // A region marked data-live-hold keeps the reader's place across a swap: the scroll of
  // its table box and of itself, and the focused element, found again by a stable key
  // (the kind and the row's first cell, the tag, its place among that tag in the row).
  // hold() notes the place and returns what puts it back; it is called after sort(),
  // so a row the sort moved still gets its focus. When that row is gone (its process
  // ended), focus falls back to the same control in the first row of the same group,
  // then to the first of that tag in the region, so it is never dropped to the page.
  function keyOf(f) {
    var tr = f.closest('tr'), tb = f.closest('tbody');
    var same = tr ? Array.prototype.indexOf.call(tr.querySelectorAll(f.tagName), f) : -1;
    return [tb ? tb.getAttribute('data-kind') : '', tr && tr.cells[0] ? tr.cells[0].textContent : '', f.tagName, same].join('|');
  }
  function hold(el) {
    var box = el.querySelector('.table-scroll'), top = box ? box.scrollTop : 0, left = box ? box.scrollLeft : 0;
    var own = el.scrollTop, f = document.activeElement;
    var key = f && f !== el && el.contains(f) ? keyOf(f) : null;
    return function () {
      var b = el.querySelector('.table-scroll');
      if (b) { b.scrollTop = top; b.scrollLeft = left; }
      el.scrollTop = own;
      if (key === null) return;
      var part = key.split('|'), all = el.querySelectorAll(part[2]), group = null, any = null;
      for (var i = 0; i < all.length; i++) {
        var c = all[i];
        if (!c.focus || c.tagName !== part[2]) continue;
        var k = keyOf(c), p = k.split('|');
        if (k === key) { c.focus({ preventScroll: true }); return; }
        if (!group && p[0] === part[0] && p[3] === part[3]) group = c;
        if (!any) any = c;
      }
      var to = group || any;
      if (to) to.focus({ preventScroll: true });
    };
  }
  if (typeof EventSource === 'undefined' || /[?&]pause\\b/.test(location.search)) return;
  var es = new EventSource('/system/stream');
  es.addEventListener('sample', function (e) {
    var data;
    try { data = JSON.parse(e.data); } catch (_) { return; }
    var regions = data && data.regions;
    if (!regions) return;
    var restores = [];
    for (var id in regions) {
      var el = document.getElementById(id);
      if (!el || el.innerHTML === regions[id]) continue;
      if (el.hasAttribute('data-live-hold')) restores.push(hold(el));
      el.innerHTML = regions[id];
    }
    sort();
    restores.forEach(function (put) { put(); });
  });
})();
`;
