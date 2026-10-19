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
  var KINDS = ['forge', 'check', 'app', 'host'], key = 'cpu';
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
  if (typeof EventSource === 'undefined' || /[?&]pause\\b/.test(location.search)) return;
  var es = new EventSource('/system/stream');
  es.addEventListener('sample', function (e) {
    var data;
    try { data = JSON.parse(e.data); } catch (_) { return; }
    var regions = data && data.regions;
    if (!regions) return;
    for (var id in regions) {
      var el = document.getElementById(id);
      if (el && el.innerHTML !== regions[id]) el.innerHTML = regions[id];
    }
    sort();
  });
})();
`;
