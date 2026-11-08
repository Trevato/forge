/**
 * Actions that answer at once. A form marked `data-now` shows its result in
 * the frame it is submitted in, posts in the background asking for JSON, and
 * puts everything back with the server's reason when it is refused. There is
 * no client model: the page stays what the server rendered, the live regions
 * (`liveRegionsJs`) bring the rest, and a page without script posts the form
 * the way it always did.
 *
 *   data-now="Word"       what the form's buttons say the moment it is sent
 *   data-now-once         the action is done for good: the buttons stay so
 *   data-now-into="#id"   an element that shows the new value at once, and
 *   data-now-from="name"   the field it is read from (a select's option, or
 *                          the chips of the ticked boxes)
 *   data-now-flip="name"   a toggle: on success the field's 0/1 flips and
 *   data-now-alt="Word"    the buttons say this next time
 *
 * Sent as the tail of `shellJs` (`client.ts`); `ACT_NOW_BUDGET` is its byte budget,
 * held by `test/act-now.test.ts`.
 */

export const ACT_NOW_BUDGET = 3000;

export const actNowJs = /* js */ `
(function () {
  var D = document;
  function all(l) { return Array.prototype.slice.call(l); }
  D.addEventListener('submit', function (e) {
    var f = e.target, w = f.getAttribute && f.getAttribute('data-now');
    if (!w || !window.fetch || e.defaultPrevented) return;
    e.preventDefault();
    if (f.__busy) return;
    f.__busy = 1;
    var bs = all(f.querySelectorAll('button')).concat(f.id ? all(D.querySelectorAll('button[form="' + f.id + '"]')) : []);
    var undo = [], at = bs[0] || f;
    bs.forEach(function (b) {
      var h = b.innerHTML;
      undo.push(function () { b.innerHTML = h; b.removeAttribute('aria-disabled'); });
      var t = all(b.childNodes).filter(function (x) { return x.nodeType === 3; });
      t.slice(1).forEach(function (x) { b.removeChild(x); });
      if (t[0]) t[0].nodeValue = w; else b.appendChild(D.createTextNode(w));
      b.setAttribute('aria-disabled', 'true');
    });
    var to = D.querySelector(f.getAttribute('data-now-into') || ':not(*)'), from = f.getAttribute('data-now-from');
    if (to && from) {
      var h = to.innerHTML, c = f.elements[from], k = all(f.querySelectorAll('input[name="' + from + '"]:checked'));
      undo.push(function () { to.innerHTML = h; });
      if (c && c.options) to.textContent = c.options[c.selectedIndex].text.trim();
      else to.innerHTML = k.length ? k.map(function (i) { return i.closest('label').lastElementChild.outerHTML; }).join(' ') : 'None yet.';
    }
    var n = f.__now;
    if (!n) { n = f.__now = D.createElement('p'); n.className = 'small'; n.setAttribute('role', 'status'); at.insertAdjacentElement('afterend', n); }
    function say(t) { setTimeout(function () { n.textContent = t; }, 50); }
    say(w + '\\u2026');
    function done(ok, said) {
      if (!ok || !f.hasAttribute('data-now-once')) f.__busy = 0;
      n.setAttribute('role', ok ? 'status' : 'alert');
      say(said);
      if (!ok) return undo.reverse().forEach(function (u) { u(); });
      var flip = f.getAttribute('data-now-flip'), once = f.hasAttribute('data-now-once');
      if (flip && f.elements[flip]) {
        f.elements[flip].value = f.elements[flip].value === '1' ? '0' : '1';
        f.setAttribute('data-now', f.getAttribute('data-now-alt'));
        f.setAttribute('data-now-alt', w);
      }
      if (!once && !flip) undo.slice(0, bs.length).forEach(function (u) { u(); });
      else if (flip) bs.forEach(function (b) { b.removeAttribute('aria-disabled'); });
    }
    fetch(f.action, { method: 'POST', body: new URLSearchParams(new FormData(f)), credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          done(r.ok && j.ok !== false, j.error || j.flash || (r.ok ? w + '.' : 'That did not go through (' + r.status + '). Nothing changed.'));
        });
      })
      .catch(function () { done(false, 'Could not reach the forge. Nothing changed.'); });
  });
})();
`;
