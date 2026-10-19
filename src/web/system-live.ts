/**
 * /system's client: one EventSource, and each pushed sample patched into the
 * element of the id it names. No reload, no timer, no polling; EventSource
 * itself reconnects after a roll (the stream's `retry:` hint) and the first
 * frame of the new stream is the latest sample. `?pause` opens nothing.
 * The markup comes from our own server, escaped there, so it is set as HTML.
 */
export const systemLiveJs = /* js */ `
(function () {
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
  });
})();
`;
