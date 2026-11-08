/**
 * `GET /__forge/` on an app's host: the way back when the pill is not shown
 * (an app whose own policy refuses foreign scripts). Answered by the proxy,
 * never by the app; plain data in, one static-looking page out, no script.
 */

import { createHash } from "node:crypto";
import { escapeAttr, type PillWhere } from "./toolbar.ts";
import type { Served, Serving } from "./serving.ts";
import type { CrewNow } from "./crew.ts";

export type DoorFacts = {
  where: PillWhere;
  forgeUrl: string;
  /** The forge's tell page, only for someone who may direct the crew. */
  tell?: string;
  /** This host's own sign-in door, offered when nobody is signed in. */
  signin?: string;
  /** What the host is serving, read from the deploy record. */
  serving?: Serving | undefined;
  /**
   * The terminal, only for someone who may write the repository: the exact
   * `ssh …` command, or null when the terminal is off. Unset shows nothing.
   */
  ssh?: string | null;
  /** Open pulls a viewer may see, each with where to go: its preview or the forge. */
  pulls?: DoorPullLine[] | undefined;
  /** Who of the crew is working here now, as the pill's crew line says it. */
  crew?: CrewNow | undefined;
  /** The production host of this app, only on a preview. */
  live?: string | undefined;
  /** This host's own report door, only for a public app anyone may report on. */
  report?: string | undefined;
};

/** How many pulls the door lists; one more read than this means there are others. */
export const DOOR_PULL_LIMIT = 5;

export type DoorPullLine = { number: number; title: string; check: string; href: string; self?: boolean };

const STYLE =
  "html{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}li{margin:.4rem 0}pre{overflow-x:auto;padding:.6rem;background:#eee;color:#111;user-select:all}" +
  "@media (prefers-color-scheme: dark){body{background:#111;color:#eee}a{color:#8ab4f8}a:visited{color:#c4a7e7}pre{background:#222;color:#eee}}";
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

/** The where line; a reader of the pull gets its number linked and its title. */
function whereLine(where: PillWhere, forgeUrl: string): string {
  const words = escapeAttr(doorWhere(where));
  if (where.pull === undefined || where.repo === undefined || where.title === undefined)
    return words;
  const href = new URL(`/${where.repo}/pulls/${where.pull}`, forgeUrl).href;
  const n = `pull #${where.pull}`;
  return `${words.replace(n, `<a href="${escapeAttr(href)}">${n}</a>`)}: ${escapeAttr(where.title)}`;
}

/** `2026-10-25 14:03 UTC`, or the raw text when it is not a date. */
function when(at: string): string {
  const t = Date.parse(at);
  return Number.isNaN(t) ? at : new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

const stamp = (at: string): string =>
  `<time datetime="${escapeAttr(at)}">${escapeAttr(when(at))}</time>`;

function servingHtml(facts: DoorFacts): string {
  const s = facts.serving;
  if (s === undefined) return "";
  const repo = facts.where.repo;
  // Commit ids and the release history belong to someone who may read the
  // repository; a guest of the app learns only when it last changed.
  if (repo === undefined) {
    if (s.kind === "preview")
      return `<p>Preview of #${s.pull}${
        s.current === undefined ? ", not deployed yet" : `, deployed ${stamp(s.current.at)}`
      }</p>`;
    const now = s.releases[0];
    return now === undefined ? "<p>not released yet</p>" : `<p>Serving since ${stamp(now.at)}</p>`;
  }
  const sha = (x: Served): string =>
    `<a href="${escapeAttr(new URL(`/${repo}/commit/${x.sha}`, facts.forgeUrl).href)}"><code>${escapeAttr(x.sha.slice(0, 7))}</code></a>`;
  if (s.kind === "preview")
    return `<p>Preview of #${s.pull}${
      s.current === undefined ? ", not deployed yet" : ` at ${sha(s.current)}, deployed ${stamp(s.current.at)}`
    }</p>`;
  const [now, ...before] = s.releases;
  if (now === undefined) return "<p>not released yet</p>";
  const older = before.map((r) => `<li>${sha(r)}, ${stamp(r.at)}</li>`).join("");
  return `<p>Serving ${sha(now)} since ${stamp(now.at)}</p>${older === "" ? "" : `<h2>Before it</h2><ul>${older}</ul>`}`;
}

function pullsHtml(pulls: DoorPullLine[] | undefined, morePulls: string | undefined): string {
  if (pulls === undefined || pulls.length === 0) return "";
  const items = pulls.slice(0, DOOR_PULL_LIMIT).map((p) => {
    const text = `#${p.number} ${[...p.title].slice(0, 120).join("")} · check ${p.check}`;
    return p.self === true ? `<li>${escapeAttr(text)} (this preview)</li>` : link(p.href, text);
  });
  const words = "More pulls are open on the forge.";
  const more =
    pulls.length <= DOOR_PULL_LIMIT
      ? ""
      : morePulls === undefined
        ? `<p>${words}</p>`
        : `<p><a href="${escapeAttr(morePulls)}">${words}</a></p>`;
  return `<h2>Open pulls</h2><ul>${items.join("")}</ul>${more}`;
}

/** The pill's crew line: who is working on this, linked to that run on the forge. */
function crewHtml(crew: CrewNow | undefined): string {
  if (crew === undefined) return "";
  return `<p><a href="${escapeAttr(crew.url)}">${escapeAttr(`${crew.who} is working on this`)}</a></p>`;
}

export function doorPage(facts: DoorFacts, head: boolean): Response {
  const { where, forgeUrl } = facts;
  const links = [link(forgeUrl, "Home")];
  let morePulls: string | undefined;
  if (where.repo !== undefined) {
    const repoUrl = new URL(`/${where.repo}`, forgeUrl).href;
    links.push(link(repoUrl, `The repository, ${where.repo}`));
    if (where.pull !== undefined)
      links.push(link(new URL(`/${where.repo}/pulls/${where.pull}/files`, forgeUrl).href, "What changed"));
    links.push(link(`${repoUrl}/make-it-yours`, "Make it yours"));
    morePulls = `${repoUrl}/pulls`;
    // Production's address is for a reader of the app, as What changed is.
    if (facts.live !== undefined && where.env !== "production")
      links.push(link(facts.live, "The live app"));
  }
  if (facts.tell !== undefined) links.push(link(facts.tell, "Tell the crew"));
  else if (facts.signin !== undefined)
    links.push(link(facts.signin, "Sign in to tell the crew"));
  if (facts.report !== undefined)
    links.push(link(facts.report, "Report a problem, no account needed"));
  const terminal =
    facts.ssh === undefined
      ? ""
      : facts.ssh === null
        ? "<p>The terminal is off.</p>"
        : `<p>Terminal:</p><pre><code>${escapeAttr(facts.ssh)}</code></pre>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeAttr(where.app)}, ${escapeAttr(doorWhere(where))}</title><style>${STYLE}</style></head>
<body><main><h1>${escapeAttr(where.app)}</h1><p>${whereLine(where, forgeUrl)}</p>${crewHtml(facts.crew)}${servingHtml(facts)}${pullsHtml(facts.pulls, morePulls)}<ul>${links.join("")}</ul>${terminal}</main></body></html>
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
