/**
 * A font file drawn as a specimen: its family name, then the alphabet, the
 * digits and one pangram at three sizes, set in the font itself.
 *
 * The family comes from the `name` table of a TrueType or OpenType file; a
 * WOFF file compresses its tables, so it is named by its file name. The font
 * is loaded by `fontJs` (a `FontFace` from the same-origin media route), so
 * the page's policy gains `font-src 'self'` and nothing else (`layout.ts`
 * `fontSrc`); never a `data:` URL. Without script the specimen shows in the
 * page's own face, still named and sized.
 */

import { html } from "../html.ts";
import { card, fileSize } from "../ui.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789 .,;:!?&@#%()[]{}";
const PANGRAM = "Sphinx of black quartz, judge my vow.";

const u16 = (v: DataView, at: number): number => v.getUint16(at, false);

/**
 * The family name of a TrueType/OpenType file, or undefined when the bytes
 * do not hold one. Every offset is bounds-checked: the file is untrusted.
 */
export function fontFamily(body: Uint8Array): string | undefined {
  if (body.length < 12) return undefined;
  const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const tables = Math.min(u16(v, 4), 128);
  for (let i = 0; i < tables; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > body.length) return undefined;
    if (String.fromCharCode(...body.subarray(rec, rec + 4)) !== "name") continue;
    const base = v.getUint32(rec + 8, false);
    const length = v.getUint32(rec + 12, false);
    if (base + 6 > body.length || length < 6) return undefined;
    const count = Math.min(u16(v, base + 2), 2048);
    const strings = base + u16(v, base + 4);
    let best: { rank: number; text: string } | undefined;
    for (let n = 0; n < count; n++) {
      const r = base + 6 + n * 12;
      if (r + 12 > body.length) break;
      const platform = u16(v, r);
      const id = u16(v, r + 6);
      const len = u16(v, r + 8);
      const from = strings + u16(v, r + 10);
      if ((id !== 16 && id !== 1) || from + len > body.length || len === 0) continue;
      let text: string;
      if (platform === 3 || platform === 0) {
        if (len % 2 !== 0) continue;
        text = "";
        for (let o = from; o < from + len; o += 2) text += String.fromCharCode(u16(v, o));
      } else if (platform === 1) {
        text = String.fromCharCode(...body.subarray(from, from + len));
      } else continue;
      text = text.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100);
      if (text === "") continue;
      // The typographic family (16) over the legacy one (1); Windows over Mac.
      const rank = (id === 16 ? 2 : 0) + (platform === 1 ? 0 : 1);
      if (best === undefined || rank > best.rank) best = { rank, text };
    }
    return best?.text;
  }
  return undefined;
}

/** The file name without directory or extension, for a font that names no family. */
const stem = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};

export function font(input: RenderInput): Rendered {
  const isSfnt = input.body.length >= 4 && !/^(wOFF|wOF2)/.test(String.fromCharCode(...input.body.subarray(0, 4)));
  const family = (isSfnt ? fontFamily(input.body) : undefined) ?? stem(input.path);
  const line = (size: string, text: string) => html`<p class="font-line font-${size}">${text}</p>`;
  return {
    lines: 0,
    summary: `${fileSize(input.size)} · font`,
    content: card(html`<div class="font-view" data-font="${input.media}">
      <h2 class="font-name">${family}</h2>
      ${line("s", ALPHABET)} ${line("s", DIGITS)} ${line("s", PANGRAM)}
      ${line("m", ALPHABET)} ${line("m", DIGITS)} ${line("m", PANGRAM)}
      ${line("l", "Aa Bb Cc 123")} ${line("l", PANGRAM)}
    </div>`, { extra: "bare", pad: false }),
  };
}

/** Loads the font from the media route and lets the specimen use it. Trusted static code. */
export const fontJs = /* js */ `
(function () {
  var box = document.querySelector('.font-view[data-font]');
  if (!box || !window.FontFace) return;
  var face = new FontFace('ForgeSpecimen', 'url(' + JSON.stringify(box.getAttribute('data-font')) + ')');
  face.load().then(function () {
    document.fonts.add(face);
    box.classList.add('font-ready');
  }, function () {});
})();
`;
