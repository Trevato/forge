/**
 * Every link on the top pages lands where its label says (#5844): no 404 or
 * 5xx, and a link that lands on `/` is only fine when it is Home.
 */

import { found, seenLine, type Finding } from "./finding.ts";
import { inside, type Probe } from "./probe.ts";

export const TOP_PAGES = ["/", "/explore", "/apps", "/forges", "/board", "/migrate", "/system"];
const HOME = /^(home|forge|the forge|feed|back to (the )?(forge|home|feed))$/i;
const TAG = /<a\s([^>]*)>([\s\S]*?)<\/a>/gi;

export interface Link {
  href: string;
  label: string;
}

const text = (html: string): string =>
  html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

export function linksIn(html: string): Link[] {
  const out: Link[] = [];
  for (const m of html.matchAll(TAG)) {
    const href = /\bhref="([^"]*)"/i.exec(m[1] ?? "")?.[1];
    if (href === undefined || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) continue;
    const label = text(m[2] ?? "") || /aria-label="([^"]*)"/i.exec(m[1] ?? "")?.[1] || "";
    out.push({ href: href.replace(/&amp;/g, "&"), label });
  }
  return out;
}

const isHome = (label: string): boolean => HOME.test(label);

export async function linkLanding(p: Probe, base: string, pages = TOP_PAGES): Promise<Finding[]> {
  const out: Finding[] = [];
  const checked = new Set<string>();
  for (const page of pages) {
    const from = await p.get(page);
    if (from.status !== 200) continue;
    for (const link of linksIn(from.body)) {
      const target = inside(base, link.href);
      if (target === null || checked.has(`${target}\n${link.label}`)) continue;
      checked.add(`${target}\n${link.label}`);
      let r = await p.get(target);
      let hops = 0;
      while (r.status >= 300 && r.status < 400 && r.location && hops++ < 3) {
        const next = inside(base, r.location);
        if (next === null) break;
        r = await p.get(next);
      }
      const where = `${seenLine(target, r.status)} (link "${link.label}" on ${page})`;
      if (r.status === 0 || r.status === 404 || r.status >= 500)
        out.push(found("links.status", target, `the link ${target} on ${page} answers ${r.status}`, where));
      else if (r.status < 300 && r.path === "/" && target !== "/" && !isHome(link.label))
        out.push(found("links.lands-home", target, `the link "${link.label}" lands on / and is not Home`, where));
    }
  }
  return out;
}
