/**
 * The one overlay host (#11931): every dialog, menu, palette and drawer opens
 * through `forgeOverlay.open`, so each opens, traps focus and dismisses the
 * same way, and none can be wrong in its own way (0.7.549 shipped a closed
 * palette that covered every phone page).
 *
 * The behaviour is re-implemented, with no dependency, from the ideas in
 * vercel-labs/ui (Apache-2.0, `packages/core/src`: dismissal-layer,
 * overlay-host, roving-focus). Nothing of its code is copied.
 *
 *  - A stack of open layers. Escape, and a press that begins and ends outside
 *    the layer, close the top one only.
 *  - Focus moves in on open, is held inside while a modal is open (Tab wraps),
 *    and returns to the opener on close.
 *  - A modal layer is a native `showModal()` dialog, so the page behind is
 *    inert; `html[data-overlay]` stops it scrolling too.
 *  - A layer that is not open has no box: a closed `<dialog>` and a closed
 *    `<details>` are `display: none` (the covered-page rule, `src/design/overlay.ts`).
 *  - Development only (localhost): an overlay opened without the host is
 *    named in the console.
 *
 * Shipped as static source inside the shell script; page scripts reach it as
 * `window.forgeOverlay`. Idempotent: a second copy in one page finds the first.
 */
export const overlayHostJs = /* js */ `
  var overlayHost = window.forgeOverlay || (window.forgeOverlay = (function () {
    var doc = document;
    var stack = [];
    var pressedOutside = false;
    var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
    var dev = /^(localhost|127\\.0\\.0\\.1|\\[::1\\])$/.test(location.hostname);

    function label(el) {
      return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
    }
    function outside(el, e) {
      var r = el.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    }
    function top() { return stack[stack.length - 1]; }
    function locked() {
      var modal = stack.some(function (l) { return l.modal; });
      if (modal) doc.documentElement.setAttribute('data-overlay', ''); else doc.documentElement.removeAttribute('data-overlay');
    }
    function find(el) { for (var i = 0; i < stack.length; i++) if (stack[i].el === el) return stack[i]; return null; }

    function onKey(e) {
      var l = top();
      if (!l) return;
      if (e.key === 'Escape') {
        // Consumed: an Escape the page lets through leaves fullscreen on macOS.
        e.preventDefault(); e.stopPropagation();
        l.close();
        return;
      }
      if (e.key === 'Tab' && l.modal) {
        var items = Array.prototype.filter.call(l.el.querySelectorAll(FOCUSABLE), function (n) { return !n.hidden && !n.closest('[hidden]'); });
        if (!items.length) { e.preventDefault(); return; }
        var first = items[0], last = items[items.length - 1], at = doc.activeElement;
        if (!l.el.contains(at)) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
      }
    }
    function onDown(e) {
      var l = top();
      if (!l) return;
      pressedOutside = l.modal ? e.target === l.el && outside(l.el, e) : !l.el.contains(e.target);
    }
    function onClick(e) {
      var l = top();
      if (!l) return;
      var out = l.modal ? e.target === l.el && outside(l.el, e) : !l.el.contains(e.target);
      // A press that began inside and ended outside is a selection, not a dismissal.
      if (out && pressedOutside) { if (l.modal) e.preventDefault(); l.close(); }
      pressedOutside = false;
    }
    var live = false;
    function listen(on) {
      if (on === live) return;
      live = on;
      var f = on ? 'addEventListener' : 'removeEventListener';
      doc[f]('keydown', onKey, true);
      doc[f]('pointerdown', onDown, true);
      doc[f]('click', onClick, true);
    }

    /**
     * Open a layer. el: a <dialog> (modal) or a <details> (a menu). opts:
     * name (for the dev warning), opener (where the focus returns; default
     * the focused element), onClose. Returns close, safe to call twice.
     */
    function open(el, opts) {
      opts = opts || {};
      var held = find(el);
      if (held) return held.close;
      var modal = typeof el.showModal === 'function';
      var was = opts.opener || doc.activeElement;
      var done = false;
      var l = { el: el, modal: modal, close: close };
      function onCancel(e) { e.preventDefault(); close(); }
      function close() {
        if (done) return;
        done = true;
        var i = stack.indexOf(l);
        if (i !== -1) stack.splice(i, 1);
        el.removeEventListener('cancel', onCancel);
        el.removeEventListener('close', close);
        if (modal) { if (el.open) el.close(); } else el.removeAttribute('open');
        locked();
        if (!stack.length) listen(false);
        if (opts.onClose) opts.onClose();
        if (was && was.focus && doc.contains(was)) { try { was.focus(); } catch (_) {} }
      }
      // One menu at a time: opening a non-modal layer closes the others.
      if (!modal) stack.slice().forEach(function (o) { if (!o.modal) o.close(); });
      stack.push(l);
      listen(true);
      if (modal) {
        el.addEventListener('cancel', onCancel);
        el.addEventListener('close', close);
        el.showModal();
      } else el.setAttribute('open', '');
      locked();
      return close;
    }

    // Development only: a dialog or menu that opens without the host is named.
    if (dev && typeof MutationObserver !== 'undefined') {
      new MutationObserver(function (list) {
        list.forEach(function (m) {
          var el = m.target;
          if (!el.hasAttribute || !el.hasAttribute('open') || find(el)) return;
          if (el.tagName !== 'DIALOG' && !(el.matches && el.matches('details.menu'))) return;
          // A menu opened natively is adopted here, before the browser's async toggle event.
          if (el.matches('details.menu')) { adopt(el); return; }
          setTimeout(function () {
            if (el.hasAttribute('open') && !find(el)) console.warn('[overlay] ' + label(el) + ' opened without the overlay host: open it with forgeOverlay.open(el)');
          }, 0);
        });
      }).observe(doc.documentElement, { attributes: true, attributeFilter: ['open'], subtree: true });
    }

    // Menus are <details>: the browser opens them, the host adopts them, so
    // one menu at a time, Escape and an outside press close the top layer.
    function adopt(m) {
      if (find(m)) return;
      open(m, { opener: m.querySelector('summary') });
      var first = m.querySelector('.menu-panel a.menu-item, .menu-panel button.menu-item, .menu-panel input');
      // The panel opens in view, under its button or as a phone's sheet: taking focus must not move the page.
      if (first) first.focus({ preventScroll: true });
    }
    doc.addEventListener('toggle', function (e) {
      var m = e.target;
      if (!m || !m.matches || !m.matches('details.menu')) return;
      if (!m.open) { var l = find(m); if (l) l.close(); return; }
      adopt(m);
    }, true);
    // A menu that is already open when the page loads is a layer too.
    Array.prototype.forEach.call(doc.querySelectorAll('details.menu[open]'), function (m) { open(m, { opener: m.querySelector('summary') }); });

    return { open: open, close: function (el) { var l = find(el); if (l) l.close(); else if (el.open) el.close(); }, isOpen: function (el) { return !!find(el); }, depth: function () { return stack.length; } };
  })());
  function openModal(dlg, onClose, opener) { return overlayHost.open(dlg, { onClose: onClose, opener: opener }); }
`;
