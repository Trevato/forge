/**
 * A contacts file (vCard `.vcf`, RFC 6350 and 2426/2.1 in the common subset)
 * as plain data: one entry per card with its name, organisation, emails,
 * phones, urls and note. Lines are unfolded, TEXT escapes undone, multiple
 * cards read in file order, and a card with only FN is kept. Pure; never
 * throws. Nothing here is markup: the caller escapes.
 */

import { unescapeText, unfold } from "./ics.ts";

/** Cards kept, whatever the file holds. */
export const CARD_CAP = 500;
/** Values kept per list field on one card. */
export const VALUE_CAP = 20;
/** Longest single value kept, in characters. */
export const VALUE_LENGTH = 2000;

export interface Card {
  readonly name: string;
  readonly org: string;
  readonly emails: string[];
  readonly phones: string[];
  readonly urls: string[];
  readonly note: string;
}

export type Contacts = { readonly cards: Card[]; readonly total: number } | { readonly error: string };

const clip = (v: string): string => (v.length > VALUE_LENGTH ? v.slice(0, VALUE_LENGTH) : v);

/** Split at the first colon; the name is what precedes the first `;` or `.` group. */
function split(line: string): { name: string; params: string; value: string } | undefined {
  const colon = line.indexOf(":");
  if (colon <= 0) return undefined;
  const head = line.slice(0, colon);
  const semi = head.indexOf(";");
  let name = semi < 0 ? head : head.slice(0, semi);
  name = name.slice(name.lastIndexOf(".") + 1).trim().toUpperCase();
  return { name, params: semi < 0 ? "" : head.slice(semi + 1).toUpperCase(), value: line.slice(colon + 1) };
}

/** The `N` property as a display name: given, family, in reading order. */
const fromN = (v: string): string => {
  const [family = "", given = "", additional = "", prefix = "", suffix = ""] = v.split(";").map((s) => unescapeText(s).trim());
  return [prefix, given, additional, family, suffix].filter(Boolean).join(" ");
};

export function parseVcf(source: string): Contacts {
  const lines = unfold(source);
  if (!lines.some((l) => l.trim().toUpperCase() === "BEGIN:VCARD")) return { error: "not a contacts file: no BEGIN:VCARD" };
  const cards: Card[] = [];
  let total = 0;
  let cur: { fn: string; n: string; org: string; emails: string[]; phones: string[]; urls: string[]; note: string } | undefined;
  for (const line of lines) {
    const t = line.trim().toUpperCase();
    if (t === "BEGIN:VCARD") {
      cur = { fn: "", n: "", org: "", emails: [], phones: [], urls: [], note: "" };
      continue;
    }
    if (cur === undefined) continue;
    if (t === "END:VCARD") {
      total++;
      if (cards.length < CARD_CAP)
        cards.push({
          name: cur.fn || cur.n || cur.emails[0] || "(no name)",
          org: cur.org,
          emails: cur.emails,
          phones: cur.phones,
          urls: cur.urls,
          note: cur.note,
        });
      cur = undefined;
      continue;
    }
    // Past the cap a card is only counted; its fields are not kept.
    if (cards.length >= CARD_CAP) continue;
    const p = split(line);
    if (p === undefined) continue;
    const add = (list: string[], v: string) => {
      const x = clip(unescapeText(v).trim());
      if (x !== "" && list.length < VALUE_CAP) list.push(x);
    };
    if (p.name === "FN") cur.fn = clip(unescapeText(p.value).trim());
    else if (p.name === "N") cur.n = clip(fromN(p.value));
    else if (p.name === "ORG") cur.org = clip(p.value.split(";").map((s) => unescapeText(s).trim()).filter(Boolean).join(", "));
    else if (p.name === "EMAIL") add(cur.emails, p.value);
    else if (p.name === "TEL") add(cur.phones, p.value.replace(/^tel:/i, ""));
    else if (p.name === "URL") add(cur.urls, p.value);
    else if (p.name === "NOTE") cur.note = clip(unescapeText(p.value).trim());
  }
  // A card that never closes is dropped, not guessed at.
  return { cards, total };
}
