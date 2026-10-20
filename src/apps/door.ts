/**
 * `GET /__forge/` on an app's host: the way back when the pill is not shown
 * (an app whose own policy refuses foreign scripts). Answered by the proxy,
 * never by the app; plain data in, one static-looking page out, no script.
 */

import { createHash } from "node:crypto";
import { escapeAttr, type PillWhere } from "./toolbar.ts";

export type DoorFacts = {
  where: PillWhere;
  forgeUrl: string;
  /** The forge's tell page, only for someone who may direct the crew. */
  tell?: string;
  /** This host's own sign-in door, offered when nobody is signed in. */
  signin?: string;
};

const STYLE =
  "body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}li{margin:.4rem 0}";
const STYLE_HASH = createHash("sha256").update(STYLE).digest("base64");

/** The same words as the pill's accessible name. */
export function doorWhere(where: PillWhere): string {
  return where.env === "production"
    ? "production"
    : where.pull !== undefined
      ? `preview of pull #${where.pull}`
      : where.env;
}

const link = (href: string, text: string): string =>
  `<li><a href="${escapeAttr(href)}">${escapeAttr(text)}</a></li>`;

export function doorPage(facts: DoorFacts, head: boolean): Response {
  const { where, forgeUrl } = facts;
  const links = [link(forgeUrl, "Home")];
  if (where.repo !== undefined)
    links.push(
      link(new URL(`/${where.repo}`, forgeUrl).href, `The repository, ${where.repo}`),
    );
  if (facts.tell !== undefined) links.push(link(facts.tell, "Tell the crew"));
  else if (facts.signin !== undefined)
    links.push(link(facts.signin, "Sign in to tell the crew"));
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeAttr(where.app)}, ${escapeAttr(doorWhere(where))}</title><style>${STYLE}</style></head>
<body><main><h1>${escapeAttr(where.app)}</h1><p>${escapeAttr(doorWhere(where))}</p><ul>${links.join("")}</ul></main></body></html>
`;
  return new Response(head ? null : html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
      "content-security-policy": `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  });
}
