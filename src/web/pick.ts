/**
 * A long pick list as one compact control (#8929): the options are plain
 * checkboxes in a short scrolling box, so the form submits and reads with no
 * script. `pickJs` adds a filter, removable chips for what is ticked, and a
 * count; the server renders the count so the first paint does not move.
 */

import { html, type Html } from "./html.ts";

export interface PickItem {
  readonly value: string;
  readonly label: string;
}

export interface PickOptions {
  readonly legend: string;
  readonly name: string;
  readonly items: readonly PickItem[];
  readonly chosen: readonly string[];
  readonly error?: string | undefined;
  /** The noun in "3 of 150 repositories picked". */
  readonly noun?: string;
}

export const pickCount = (picked: number, total: number, noun: string): string =>
  `${picked} of ${total} ${noun} picked`;

export function pickList(o: PickOptions): Html {
  const noun = o.noun ?? "options";
  const picked = o.items.filter((i) => o.chosen.includes(i.value)).length;
  return html`<fieldset class="field pick" data-pick="${noun}" ${o.error ? html`data-invalid aria-describedby="f-${o.name}-err"` : null}>
    <legend>${o.legend}</legend>
    <div class="pick-bar" data-pick-bar hidden>
      <span class="pick-chips" data-pick-chips></span>
      <input
        class="input"
        type="search"
        data-pick-filter
        autocomplete="off"
        placeholder="Type to filter ${noun}"
        aria-label="Filter ${noun}"
      />
    </div>
    <div class="pick-list">
      ${o.items.map(
        (i) =>
          html`<label class="check" data-pick-item>
            <input
              type="checkbox"
              name="${o.name}"
              value="${i.value}"
              ${o.chosen.includes(i.value) ? html`checked` : null}
            />
            <span>${i.label}</span>
          </label>`,
      )}
    </div>
    <p class="muted small pick-count" data-pick-count>${pickCount(picked, o.items.length, noun)}</p>
    <span class="sr-only" role="status" data-pick-live></span>
    ${o.error ? html`<span class="error" id="f-${o.name}-err">${o.error}</span>` : null}
  </fieldset>`;
}

export const pickCss = /* css */ `
.pick-bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 0 0 8px; }
.pick-bar[hidden] { display: none; }
.pick-bar { max-height: 96px; overflow-y: auto; }
.pick-chips { display: contents; }
.pick-chip {
  display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
  padding: 2px 8px; font: inherit; font-size: 12.5px; cursor: pointer;
  color: var(--fg); background: var(--muted); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.pick-chip:hover { border-color: var(--border-strong); }
.pick-bar .input { flex: 1; min-width: 160px; }
.pick-list {
  max-height: 168px; overflow-y: auto; overscroll-behavior: contain;
  border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 4px 8px;
}
.pick-list .check { display: flex; padding: 3px 0; }
.pick-list [hidden] { display: none; }
.pick-count { margin: 6px 0 0; }
`;

/** Progressive enhancement for `pickList`; sent as part of `shellJs`. */
export const pickJs = /* js */ `
(function () {
  var D = document;
  function all(l) { return Array.prototype.slice.call(l); }
  all(D.querySelectorAll('[data-pick]')).forEach(function (root) {
    var bar = root.querySelector('[data-pick-bar]');
    var chips = root.querySelector('[data-pick-chips]');
    var filter = root.querySelector('[data-pick-filter]');
    var count = root.querySelector('[data-pick-count]');
    var live = root.querySelector('[data-pick-live]');
    var last = -1;
    var noun = root.getAttribute('data-pick');
    var items = all(root.querySelectorAll('[data-pick-item]'));
    bar.hidden = false;
    function box(it) { return it.querySelector('input'); }
    function text(it) { return it.textContent.trim(); }
    function visible() { return items.filter(function (it) { return !it.hidden; }); }
    function render() {
      var on = items.filter(function (it) { return box(it).checked; });
      var said = on.length + ' of ' + items.length + ' ' + noun + ' picked';
      if (on.length !== last) { if (last >= 0) live.textContent = said; last = on.length; }
      count.textContent = said +
        (filter.value.trim() === '' ? '' : '; ' + visible().length + ' shown');
      chips.textContent = '';
      on.forEach(function (it) {
        var b = D.createElement('button');
        b.type = 'button';
        b.className = 'pick-chip';
        b.textContent = text(it) + ' \\u00d7';
        b.setAttribute('aria-label', 'Remove ' + text(it));
        b.addEventListener('click', function () {
          box(it).checked = false;
          render();
          filter.focus();
        });
        chips.appendChild(b);
      });
    }
    function apply() {
      var q = filter.value.trim().toLowerCase();
      items.forEach(function (it) { it.hidden = q !== '' && text(it).toLowerCase().indexOf(q) < 0; });
      render();
    }
    filter.addEventListener('input', apply);
    filter.addEventListener('keydown', function (e) {
      var v = visible();
      if (e.key === 'Enter') {
        e.preventDefault();
        if (v[0]) { box(v[0]).checked = !box(v[0]).checked; render(); }
      } else if (e.key === 'ArrowDown' && v[0]) {
        e.preventDefault(); box(v[0]).focus();
      } else if (e.key === 'Escape' && filter.value) {
        e.preventDefault(); e.stopPropagation(); filter.value = ''; apply();
      }
    });
    root.addEventListener('keydown', function (e) {
      var t = e.target;
      if (!t || t.type !== 'checkbox' || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
      var v = visible().map(box), i = v.indexOf(t);
      var next = v[i + (e.key === 'ArrowDown' ? 1 : -1)];
      e.preventDefault();
      if (next) next.focus(); else if (e.key === 'ArrowUp') filter.focus();
    });
    root.addEventListener('change', render);
    render();
  });
})();
`;
