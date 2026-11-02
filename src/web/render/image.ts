/**
 * An image or an SVG as a picture: an `<img>` pointed at the media route,
 * never the bytes inlined, so an SVG's script cannot run (the route sends it
 * under a sandbox CSP). Fit to the pane; a click shows it at 100% and the
 * pane scrolls (or drags) to pan. The pixel size is read in the browser by
 * `imageViewJs`, which the shell script carries.
 */

import { html, when } from "../html.ts";
import { btn, fileSize } from "../ui.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

/** Width and height from a PNG or GIF header, so the box exists before the bytes arrive. */
function headerSize(body: Uint8Array): { w: number; h: number } | undefined {
  const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const sig = (text: string): boolean =>
    body.length >= text.length && [...text].every((c, i) => body[i] === c.charCodeAt(0));
  const size =
    body.length >= 24 && sig("\x89PNG")
      ? { w: v.getUint32(16), h: v.getUint32(20) }
      : body.length >= 10 && sig("GIF8")
        ? { w: v.getUint16(6, true), h: v.getUint16(8, true) }
        : undefined;
  return size !== undefined && size.w > 0 && size.h > 0 ? size : undefined;
}

export function image(input: RenderInput): Rendered {
  const name = input.path.slice(input.path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const format = dot <= 0 ? "" : name.slice(dot + 1).toUpperCase();
  const known = headerSize(input.body);
  return {
    lines: 0,
    content: html`<div class="card imgview">
      <div class="imgview-meta muted">
        <span class="imgview-dim" data-img-dim></span>
        <span>${fileSize(input.size)}</span>
        <span>${format}</span>
${btn("Actual size", { type: "button", size: "sm", pressed: false, extra: "js-only imgview-zoom" })}
      </div>
      <div
        class="imgview-pane"
        data-img-pane
        tabindex="0"
        role="region"
        aria-label="${`Image ${name}; arrow keys pan when at actual size`}"
      >
        <img
          class="imgview-img"
          src="${input.media}"
          alt="${name}"
          decoding="async"
          ${when(known !== undefined, () => html`width="${String(known?.w)}" height="${String(known?.h)}"`)}
          data-img-view
        />
      </div>
    </div>`,
  };
}

/** Delegated, so it works for an image already loaded and one still coming. */
export const imageViewJs = /* js */ `
  (function () {
    function dims(img) {
      var slot = img.closest('.imgview') && img.closest('.imgview').querySelector('[data-img-dim]');
      if (slot && img.naturalWidth > 0) slot.textContent = img.naturalWidth + ' \\u00d7 ' + img.naturalHeight + ' px';
    }
    doc.addEventListener('load', function (e) {
      if (e.target && e.target.matches && e.target.matches('img[data-img-view]')) dims(e.target);
    }, true);
    doc.querySelectorAll('img[data-img-view]').forEach(function (img) { if (img.complete) dims(img); });
    function zoom(pane) {
      var on = pane.classList.toggle('is-actual');
      var b = pane.closest('.imgview').querySelector('.imgview-zoom');
      if (b) { b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.textContent = on ? 'Fit' : 'Actual size'; }
    }
    var drag = null, dragged = false;
    doc.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target : null;
      var btn = t && t.closest('.imgview-zoom');
      if (btn) { zoom(btn.closest('.imgview').querySelector('[data-img-pane]')); return; }
      if (t && t.closest('img[data-img-view]') && !dragged) zoom(t.closest('[data-img-pane]'));
    });
    doc.addEventListener('pointerdown', function (e) {
      var pane = e.pointerType === 'mouse' && e.button === 0 && e.target.closest && e.target.closest('[data-img-pane].is-actual');
      if (!pane) return;
      e.preventDefault();
      drag = { pane: pane, x: e.clientX, y: e.clientY, l: pane.scrollLeft, t: pane.scrollTop };
    });
    doc.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) dragged = true;
      drag.pane.scrollLeft = drag.l - dx;
      drag.pane.scrollTop = drag.t - dy;
    });
    function release() { drag = null; setTimeout(function () { dragged = false; }, 0); }
    doc.addEventListener('pointerup', release);
    doc.addEventListener('pointercancel', release);
  })();
`;
