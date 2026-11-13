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
 *   filter   the select lists the other apps only when it is first used.
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

  remember();
  clocks(true);
})();
`;
