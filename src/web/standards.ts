/**
 * The well-known files a site on the open web is expected to have, served
 * by default so a forge is a good citizen the moment it boots:
 *
 *   /.well-known/security.txt     who to tell about a vulnerability (RFC 9116)
 *   /.well-known/change-password  where a password manager sends someone
 *   /robots.txt                   what a crawler may index, and the sitemap
 *   /sitemap.xml                  every public repository
 *   /releases.json                the releases this forge has shipped, newest
 *                                 first, for a child forge to read
 *   /manifest.webmanifest         the forge as an installable app
 *   /llms.txt                     the forge for an agent: what it is, how to
 *                                 report a problem without an account, how
 *                                 to offer a change (llmstxt.org)
 *   /icons/forge-<size>.png       the mark, rastered for the manifest and iOS
 *
 * Nothing here is configured; everything is derived from what the forge
 * already knows — its URL, its first account, its public repositories, its
 * own mark. Operators who want a different security contact set
 * FORGE_SECURITY_CONTACT.
 */

import releases from "../core/releases.json" with { type: "json" };
import { markPng, type MarkShape } from "../design/mark.ts";
import { metaThemeColor } from "../design/themes.ts";
import { BODY_MAX, TITLE_MAX } from "../core/reports.ts";
import { llmsRepos, sitemapRepos } from "../core/listings.ts";
import { canRead, getRepo } from "../core/repos.ts";
import type { App } from "../app.ts";
import type { Ctx } from "../http/context.ts";
import { notFound } from "../http/respond.ts";

const DAY = 24 * 60 * 60 * 1000;

function text(body: string, type = "text/plain; charset=utf-8"): Response {
  return new Response(body, {
    headers: { "content-type": type, "cache-control": "public, max-age=3600" },
  });
}

/**
 * Where a vulnerability report goes. An address is published only when the
 * operator wrote one down for the purpose: a default must never put a
 * person's email on the open web. Without one, the contact is the first
 * account's page on this forge — already public, and a real way to reach
 * whoever runs it.
 */
function securityContact(ctx: Ctx): string {
  const configured = process.env["FORGE_SECURITY_CONTACT"]?.trim();
  if (configured) return configured;
  const admin = ctx.app.db
    .query<
      { username: string },
      []
    >("SELECT username FROM user WHERE is_admin = 1 ORDER BY created_at LIMIT 1")
    .get();
  return admin === null
    ? `${ctx.url.origin}/`
    : `${ctx.url.origin}/${admin.username}`;
}

/** GET /.well-known/security.txt */
export function securityTxt(ctx: Ctx): Response {
  // Expires is required and must be a fixed instant, not "a year from
  // whenever you read this": the first of next year, so every read within a
  // year says the same thing and the file is never stale for long.
  const now = new Date();
  const expires = new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1));
  return text(
    [
      `Contact: ${securityContact(ctx)}`,
      `Expires: ${expires.toISOString().replace(/\.\d{3}Z$/, "Z")}`,
      "Preferred-Languages: en",
      `Canonical: ${ctx.url.origin}/.well-known/security.txt`,
      "",
      "# A security problem in a repository here? Open an issue there and",
      '# tick "Sealed security report" (/<owner>/<name>/issues/new?sealed=1):',
      "# only the people who keep it and its crew see it, and you can follow",
      "# it, until its fix is released.",
      "#",
      "# Not a vulnerability? Any public repository here takes a report",
      "# without an account at /<owner>/<name>/report; how, for people and",
      `# agents: ${ctx.url.origin}/llms.txt`,
      "",
    ].join("\n"),
  );
}

/** GET /.well-known/change-password — where a password manager sends a person. */
export function changePassword(): Response {
  return new Response(null, {
    status: 302,
    headers: { location: "/settings/password" },
  });
}

/**
 * GET /releases.json — `{ releases: [{ name, url }] }`, newest first, read
 * by a child forge (`core/parent_releases.ts`). Public and read-only. The
 * link of each is this document at that release; there is no page per
 * release to point at.
 */
export function releasesJson(ctx: Ctx): Response {
  const origin = ctx.url.origin;
  let kept = releasesBodies.get(origin);
  if (kept === undefined) {
    const body = JSON.stringify({
      releases: releases.releases.map((r) => ({
        name: r.version,
        url: `${origin}/releases.json#${encodeURIComponent(r.version)}`,
      })),
    });
    const etag = `"${new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 32)}"`;
    kept = { body, etag };
    // Origins come from the Host header: keep a handful, not one per guess.
    if (releasesBodies.size >= 16) releasesBodies.clear();
    releasesBodies.set(origin, kept);
  }
  const cache = "public, max-age=3600";
  const sent = ctx.request.headers.get("if-none-match");
  if (sent !== null && sent.split(",").some((t) => t.trim() === kept.etag))
    return new Response(null, {
      status: 304,
      headers: { etag: kept.etag, "cache-control": cache },
    });
  const res = text(kept.body, "application/json");
  res.headers.set("etag", kept.etag);
  return res;
}

/** The releases document and its ETag, per origin; the file is read once at boot. */
const releasesBodies = new Map<string, { body: string; etag: string }>();

/** GET /robots.txt */
export function robotsTxt(ctx: Ctx): Response {
  return text(
    [
      "User-agent: *",
      "Disallow: /signin",
      "Disallow: /signup",
      "Disallow: /settings",
      "Disallow: /search",
      "Disallow: /api/",
      "",
      `Sitemap: ${ctx.url.origin}/sitemap.xml`,
      "",
    ].join("\n"),
  );
}

function xml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === "<"
      ? "&lt;"
      : c === ">"
        ? "&gt;"
        : c === "&"
          ? "&amp;"
          : c === "'"
            ? "&apos;"
            : "&quot;",
  );
}

/** GET /sitemap.xml — the front page and every public repository. */
export function sitemapXml(ctx: Ctx): Response {
  // Kept without an origin, and the origin is put on per answer, so a
  // caller who varies `Host` cannot make the forge read the rows again.
  const paths = sitemapRepos(ctx.app.db).map((r) => xml(`/${r}`));
  // Escaping is per character, so the escaped origin and the escaped path
  // join into the escaped URL.
  const origin = xml(ctx.url.origin);
  const urls = [
    `<url><loc>${origin}/</loc></url>`,
    ...paths.map((path) => `<url><loc>${origin}${path}</loc></url>`),
  ];
  return text(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`,
    "application/xml; charset=utf-8",
  );
}

/** GET /manifest.webmanifest — the forge as an app on a home screen. */
export function webManifest(ctx: Ctx): Response {
  const name = ctx.app.config.edgeName ? "forge" : "forge";
  return new Response(
    JSON.stringify(
      {
        name,
        short_name: name,
        description: "Your code, your machine.",
        start_url: "/",
        scope: "/",
        id: "/",
        display: "standalone",
        // Sharing a link or text to the installed forge opens the home's
        // composer with it filled in (`sharedDraft`, studio/feed.ts).
        share_target: {
          action: "/",
          method: "GET",
          params: { title: "title", text: "text", url: "url" },
        },
        // The default light theme's ground, read from the theme registry
        // so the installed app's splash matches the page it opens on.
        background_color: metaThemeColor("light"),
        theme_color: metaThemeColor("light"),
        icons: [
          { src: "/icons/forge-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/forge-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/icons/forge-512-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      null,
      2,
    ),
    {
      headers: {
        "content-type": "application/manifest+json; charset=utf-8",
        "cache-control": "public, max-age=3600",
      },
    },
  );
}

const SIZES = new Set([180, 192, 512]);

/** GET /icons/forge-:spec.png — `<size>` or `<size>-maskable`. */
export function iconPng(ctx: Ctx): Response {
  const spec = ctx.params["spec"] ?? "";
  const m = /^forge-(\d{2,3})(-maskable)?$/.exec(spec);
  if (m === null) return notFound();
  const size = Number(m[1]);
  if (!SIZES.has(size)) return notFound();
  // iOS rounds its own corners, so the touch icon is painted edge to edge
  // like a maskable one.
  const shape: MarkShape = m[2] !== undefined || size === 180 ? "full" : "icon";
  const png = markPng(size, shape);
  return new Response(png, {
    headers: {
      "content-type": "image/png",
      "content-length": String(png.length),
      "cache-control": `public, max-age=${(7 * DAY) / 1000}, immutable`,
    },
  });
}

/**
 * GET /llms.txt — the forge as an agent should meet it (llmstxt.org): what
 * this is, how to report a problem with no account, how to offer a change,
 * where the API and the MCP are, and the public repositories. Facts only,
 * each with the method and URL that does it.
 */
export function llmsTxt(ctx: Ctx): Response {
  const o = ctx.url.origin;
  const repos = llmsRepos(ctx.app.db);
  return text(
    [
      `# forge at ${ctx.url.host}`,
      "",
      "> Git repositories, their issues and pulls, and the apps they run. Anyone may read a public repository, and report a problem in it without an account.",
      "",
      "## Report a problem (no account)",
      "",
      `- Page: ${o}/{owner}/{name}/report`,
      `- API: POST ${o}/api/v1/repos/{owner}/{name}/reports with JSON {"title": "...", "body": "...", "page": "https://..."} -> 202 {"id", "state": "pending"}`,
      `- MCP: POST ${o}/mcp, method tools/call, name "report", arguments {"repo": "owner/name", "title", "body", "page"}; this one tool needs no token`,
      `- Plain text: a title of 1-${TITLE_MAX} characters, a body of at most ${BODY_MAX}; a few a minute from one source. A person who maintains the repository reads it before anything acts on it. A private repository answers not_found.`,
      "",
      "## Offer a change",
      "",
      `- Needs an account. Fork: POST ${o}/api/v1/repos/{owner}/{name}/forks; push a branch to your fork over git; then POST ${o}/api/v1/repos/{owner}/{name}/pulls with {"title", "body", "base", "head", "headRepo": "you/name"}.`,
      "",
      "## What you can do on any page",
      "",
      `- GET ${o}/api/v1/here?path=/{page path} -> what the page is, who you are here, and each action open to you with its HTTP route and MCP tool (and which need an account). Every page links to it: rel="alternate" type="application/json". MCP: the tool "here" with the page URL.`,
      "",
      "## Find things (no account)",
      "",
      `- Explore repositories: GET ${o}/api/v1/explore?q=kind:app+sort:forks+garden. MCP: the tool "explore" with {"q"}. In q, kind: is app, person or forge; sort: is score, forks, ships, use, fresh or name; any other word is free text matched against name, owner and description.`,
      `- Search issues, pulls, repositories and code: GET ${o}/api/v1/search?q=websocket+timeout. MCP: the tool "search" with {"q"}.`,
      "- Both read only what is public to you.",
      "",
      "## For agents with an account",
      "",
      `- MCP: ${o}/mcp (OAuth discovery: ${o}/.well-known/oauth-protected-resource)`,
      `- API: ${o}/api/v1, Authorization: Bearer <token>`,
      `- OpenAPI: GET ${o}/api/v1/openapi.json (redirects to ${o}/contract/openapi.json)`,
      "",
      "## Public repositories",
      "",
      // Names and addresses only: a description is whatever its owner
      // wrote, and an agent reading this file must not meet anyone's words
      // as the forge's own.
      ...(repos.length > 0
        ? repos.map((r) => `- [${r}](${o}/${r})`)
        : ["None yet."]),
      "",
    ].join("\n"),
    "text/markdown; charset=utf-8",
  );
}

export interface PageLink {
  readonly rel: string;
  readonly href: string;
  readonly title?: string;
  readonly type?: string;
}

/**
 * What every page points an agent at, as link relations (RFC 8288): the
 * forge's own description for agents, and — on a public repository's pages
 * — where to report a problem without an account. `page()` writes them both
 * as `<link>` tags and as a `Link` header, so a reader of either finds them.
 */
export function pageLinks(ctx: Ctx): PageLink[] {
  const links: PageLink[] = [
    { rel: "service-doc", href: "/llms.txt", type: "text/markdown" },
    // What the reader of this page can do here, as who they are
    // (`actions/here.ts`), for an agent that would rather not scrape it.
    {
      rel: "alternate",
      href: `/api/v1/here?path=${encodeURIComponent(ctx.url.pathname)}`,
      type: "application/json",
    },
  ];
  const owner = ctx.params["owner"];
  const name = ctx.params["name"];
  if (
    owner !== undefined &&
    name !== undefined &&
    ctx.url.pathname.startsWith(`/${owner}/${name}`)
  ) {
    const repo = getRepo(ctx.app.db, owner, name.replace(/\.git$/, ""));
    if (repo !== undefined && canRead(ctx.app.db, repo, undefined))
      links.push({
        rel: "help",
        href: `/${repo.ownerName}/${repo.name}/report`,
        title: "Report a problem (no account needed)",
      });
  }
  return links;
}

/** The same links as an HTTP `Link` header value. */
export function linkHeader(links: readonly PageLink[]): string {
  return links
    .map(
      (l) =>
        `<${l.href}>; rel="${l.rel}"${l.title === undefined ? "" : `; title="${l.title}"`}${l.type === undefined ? "" : `; type="${l.type}"`}`,
    )
    .join(", ");
}
