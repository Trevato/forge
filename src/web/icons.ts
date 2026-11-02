/**
 * The icon set: inline SVG, zero dependencies, one stroke weight, one viewBox.
 *
 * Path data is from Lucide (https://lucide.dev) — ISC License,
 * Copyright (c) 2024 Lucide Contributors. Lucide is itself a fork of Feather
 * Icons, Copyright (c) 2013-2022 Cole Bemis. Permission to use, copy, modify,
 * and/or distribute this software for any purpose with or without fee is
 * hereby granted, provided that the above copyright notice and this permission
 * notice appear in all copies.
 *
 * Every icon is 24×24 with a 1.75 stroke, drawn in `currentColor` and sat in a
 * fixed 16px slot by `.ico` so a row's baseline never moves when one appears.
 * Icons are decorative: they carry `aria-hidden`, and any control that shows
 * only an icon must carry its own `aria-label`.
 *
 * A drawing is sent once per browser, not once per page. `icon()` renders the
 * 16px slot with a one-line `<use>` inside it; `layout.ts` aims every
 * reference at the one hashed sprite file (`spriteSvg()`, served immutable).
 * The stroke, the fill and the viewBox ride on the `<symbol>`, so the slot
 * itself is four attributes; `currentColor` still resolves against whatever
 * colour the `<use>` sits in, which is what keeps every theme working.
 *
 * A fragment (`layout.fragment()`) is markup dropped into a document it does
 * not own, so it cannot reference a sprite it did not ship: `inlineIcons()`
 * expands every reference back into the nested `<svg>` a `<use>` would have
 * instantiated anyway — same pixels, no ids to collide.
 */

import { raw, type Html } from "./html.ts";

/** What the drawing needs, on the symbol rather than on every slot. */
const DRAW = `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"`;

const svg = (name: string, size: number): Html =>
  raw(
    `<svg class="ico ico-${name}" width="${size}" height="${size}" ` +
      `aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`,
  );

const PATHS = {
  repo: `<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/>`,
  fork: `<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/>`,
  lock: `<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>`,
  globe: `<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>`,
  folder: `<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>`,
  file: `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>`,
  branch: `<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>`,
  commit: `<circle cx="12" cy="12" r="3"/><line x1="3" x2="9" y1="12" y2="12"/><line x1="15" x2="21" y1="12" y2="12"/>`,
  merge: `<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>`,
  pull: `<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>`,
  issue: `<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/>`,
  map: `<path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15"/><path d="M15 6v15"/>`,
  issueClosed: `<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>`,
  tag: `<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>`,
  user: `<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>`,
  users: `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`,
  settings: `<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>`,
  key: `<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>`,
  webhook: `<path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2"/><path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06"/><path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8"/>`,
  search: `<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>`,
  check: `<path d="M20 6 9 17l-5-5"/>`,
  x: `<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`,
  chevronDown: `<path d="m6 9 6 6 6-6"/>`,
  chevronRight: `<path d="m9 18 6-6-6-6"/>`,
  copy: `<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>`,
  link: `<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`,
  plus: `<path d="M5 12h14"/><path d="M12 5v14"/>`,
  dot: `<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>`,
  alert: `<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>`,
  eye: `<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>`,
  download: `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>`,
  comment: `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`,
  home: `<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>`,
  command: `<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>`,
  help: `<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>`,
  signOut: `<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>`,
  trash: `<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>`,
  pencil: `<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>`,
  filePlus: `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h6"/><path d="M12 18v-6"/>`,
  shield: `<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>`,
  code: `<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>`,
  up: `<path d="M14 9 9 4 4 9"/><path d="M20 20h-7a4 4 0 0 1-4-4V4"/>`,
  history: `<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>`,
  activity: `<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>`,
  sync: `<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>`,
  external: `<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/>`,
  pin: `<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>`,
  pinOff: `<path d="M12 17v5"/><path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89"/><path d="m2 2 20 20"/><path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11"/>`,
  // The three forges an origin can be. GitHub's is Lucide's rendering of the
  // Octocat silhouette; Forgejo and Gitea publish no stroke mark at this
  // weight, so these are honest approximations in the same hand — a chain of
  // three nodes, and a cup — never a claim to be their trademark.
  github: `<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>`,
  forgejo: `<circle cx="6.5" cy="5" r="2.5"/><circle cx="17.5" cy="5" r="2.5"/><circle cx="12" cy="19" r="2.5"/><path d="M17.5 7.5v1.75a3 3 0 0 1-3 3h-2a2 2 0 0 0-2 2v2.25"/><path d="M6.5 7.5v6"/>`,
  gitea: `<path d="M3 8h12v7a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4z"/><path d="M15 10h2.5a3 3 0 0 1 0 6H15"/><path d="M7 5V2.5"/><path d="M11 5V2.5"/>`,
  // Apps, runs and the crew (docs/APPS.md).
  rocket: `<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>`,
  bot: `<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>`,
  play: `<path d="M6 3 20 12 6 21 6 3z"/>`,
  square: `<rect width="18" height="18" x="3" y="3" rx="2"/>`,
  loader: `<path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M18 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/>`,
  clock: `<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>`,
  ban: `<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>`,
  circleX: `<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>`,
  terminal: `<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>`,
} as const;

export type IconName = keyof typeof PATHS;

/** One icon, in the standard 16px slot (20px for empty-state headers). */
export function icon(name: IconName, size: 16 | 20 = 16): Html {
  return svg(name, size);
}

/** The reference `icon()` leaves behind, and the only thing read back. */
const REFERENCE = /<use href="#i-([A-Za-z]+)"\/>/g;

/** What `icon()` writes before the name; `pointAtSprite` finds it by this. */
const REFERENCE_OPEN = '<use href="#i-';

/**
 * Every drawing the forge has, as one SVG document of `<symbol>`s. It is
 * served once, hashed, immutable (`/assets/i-<hash>.svg`, `web/asset.ts`), so
 * no page carries a drawing: a page carries four attributes and a `<use>`.
 */
export function spriteSvg(): string {
  const symbols = (Object.keys(PATHS) as IconName[])
    .map((name) => `<symbol id="i-${name}" ${DRAW}>${PATHS[name]}</symbol>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg">${symbols}</svg>`;
}

/**
 * A document's markup with every `<use href="#i-name"/>` aimed at the hashed
 * sprite file at `spritePath`. Same-origin, so `img-src 'self'` and
 * `connect-src 'self'` both admit it; `currentColor` still resolves against
 * the `<use>`'s own colour, so every theme works.
 */
export function pointAtSprite(markup: string, spritePath: string): string {
  return markup.replaceAll(REFERENCE_OPEN, `<use href="${spritePath}#i-`);
}

/**
 * The same markup with every reference expanded in place — for a fragment,
 * which lands in a document whose sprite is none of its business. A nested
 * `<svg>` with the drawing's viewBox is exactly what `<use>` on a `<symbol>`
 * instantiates, so the pixels are the same either way.
 */
export function inlineIcons(markup: string): string {
  return markup.replace(REFERENCE, (whole, name: string) =>
    name in PATHS ? `<svg ${DRAW}>${PATHS[name as IconName]}</svg>` : whole,
  );
}

/** The half-filled circle that opens the theme menu — a glyph, not a Lucide icon. */
export const themeGlyph: Html = raw(
  `<svg class="ico" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">` +
    `<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.75"/>` +
    `<path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor"/>` +
    `</svg>`,
);
