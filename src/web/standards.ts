/**
 * The well-known files a site on the open web is expected to have, served
 * by default so a forge is a good citizen the moment it boots:
 *
 *   /.well-known/security.txt     who to tell about a vulnerability (RFC 9116)
 *   /.well-known/mcp.json         the MCP server card: endpoint, sign-in, the
 *                                 tool that needs no token (a draft format:
 *                                 only fields we keep true)
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
 *   /favicon.ico                  the 32px mark, for a browser that asks by habit
 *
 * Nothing here is configured; everything is derived from what the forge
 * already knows — its URL, its first account, its public repositories, its
 * own mark. Operators who want a different security contact set
 * FORGE_SECURITY_CONTACT.
 */

import { CRAWL_DELAY_S, DEEP_SEGMENTS } from "../http/crawl.ts";
import { markPng, type MarkShape } from "../design/mark.ts";
import { metaThemeColor } from "../design/themes.ts";
import { BODY_MAX, TITLE_MAX } from "../core/reports.ts";
import { dayOf } from "../release/days.ts";
import { readLandings } from "../release/landings.ts";
import { REPORT_LINK_TITLE } from "../actions/report_words.ts";
import { sshTellCommand } from "../ssh/command.ts";
import { llmsRepos, sitemapRepos, type LlmsListing } from "../core/listings.ts";
import { canRead, getRepo, type Repo } from "../core/repos.ts";
import { publicForgeRepo } from "../core/forge_repo.ts";
import type { Ctx } from "../http/context.ts";
import { notFound } from "../http/respond.ts";
import { SITE_LINE } from "./site_line.ts";
import { mcpToolsSection } from "./llms_tools.ts";
import { HARNESS_PLUGINS, mcpCard, mcpPointers, pluginSource, pluginsOffered } from "../core/mcp_card.ts";
import { running } from "../kernel/version.ts";
import { timePhase, timePhaseAsync } from "../core/route_timing.ts";
import { shippedReleases, type Shipped } from "../release/shipped.ts";

const DAY = 24 * 60 * 60 * 1000;

function text(body: string, type = "text/plain; charset=utf-8"): Response {
  return new Response(body, {
    headers: { "content-type": type, "cache-control": "public, max-age=3600" },
  });
}

/**
 * Where a vulnerability report goes. An address is published only when the
 * operator wrote one down for the purpose: a default must never put a
 * person's email on the open web. Without one, the contact is the sealed
 * new-issue form of the forge's own repository (the one the changelog
 * reads), a private place to send it; failing that, the first account's
 * page on this forge — already public, and a real way to reach whoever
 * runs it.
 */
function securityContact(ctx: Ctx, own: Repo | undefined): string {
  const configured = process.env["FORGE_SECURITY_CONTACT"]?.trim();
  if (configured) return configured;
  if (own !== undefined)
    return `${ctx.url.origin}/${own.ownerName}/${own.name}/issues/new?sealed=1`;
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
      `Contact: ${securityContact(ctx, publicForgeRepo(ctx.app))}`,
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

/** GET /.well-known/mcp.json — the MCP server card (a draft format; see docs/MCP.md). */
export function mcpJson(ctx: Ctx): Response {
  const res = text(JSON.stringify(mcpCard(ctx.url.origin, pluginsOffered(ctx.app.db)), null, 2), "application/json");
  res.headers.set("access-control-allow-origin", "*");
  return res;
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
  const list = shippedReleases();
  let kept = releasesBodies.get(origin);
  if (kept === undefined || kept.list !== list) {
    const body = JSON.stringify({
      releases: list.map((r) => ({
        name: r.version,
        url: `${origin}/releases.json#${encodeURIComponent(r.version)}`,
      })),
    });
    const etag = `"${new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 32)}"`;
    kept = { list, body, etag };
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

/** The releases document and its ETag, per origin, made again when the tags read differently. */
const releasesBodies = new Map<string, { list: readonly Shipped[]; body: string; etag: string }>();

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
      // The deep paths, at every ref and in every mirror: each is a git walk
      // (#8129). Repository roots, docs and the home page stay open.
      ...DEEP_SEGMENTS.map((segment) => `Disallow: /*/*/${segment}`),
      "Disallow: /origins/",
      "Allow: /$",
      `Crawl-delay: ${CRAWL_DELAY_S}`,
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

/** The sitemap and its ETag per origin, valid while the listing read is the same one. */
const sitemapBodies = new Map<string, { rows: unknown; changed: string | null; body: string; etag: string }>();

/** GET /sitemap.xml — the front page, the changelog and every public repository. */
export async function sitemapXml(ctx: Ctx): Promise<Response> {
  // The rows are kept without an origin, and the origin is put on per answer,
  // so a caller who varies `Host` cannot make the forge read the rows again.
  const repos = timePhase(ctx.request, "repos", () => sitemapRepos(ctx.app.db));
  const origin = ctx.url.origin;
  // The newest landing's day (UTC), the changelog's lastmod; none when nothing has landed.
  const newest = await timePhaseAsync(ctx.request, "landings", async () => (await readLandings(ctx.app).catch(() => undefined))?.live[0]?.at);
  const changed = newest === undefined ? null : dayOf(newest, "UTC");
  let kept = sitemapBodies.get(origin);
  if (kept === undefined || kept.rows !== repos || kept.changed !== changed) {
    // Escaping is per character, so the escaped origin and the escaped path
    // join into the escaped URL.
    const body = timePhase(ctx.request, "render", () => {
      const o = xml(origin);
      const urls = [
        `<url><loc>${o}/</loc></url>`,
        `<url><loc>${o}/explore</loc></url>`,
        `<url><loc>${o}/changelog</loc>${changed === null ? "" : `<lastmod>${changed}</lastmod>`}</url>`,
        ...repos.map((r) => {
          const mod = r.pushedAt === null ? "" : `<lastmod>${r.pushedAt.slice(0, 10)}</lastmod>`;
          return `<url><loc>${o}${xml(`/${r.path}`)}</loc>${mod}</url>`;
        }),
      ];
      return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
    });
    const etag = timePhase(ctx.request, "etag", () => `"${new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 32)}"`);
    kept = { rows: repos, changed, body, etag };
    // Origins come from the Host header: keep a handful, not one per guess.
    if (sitemapBodies.size >= 16) sitemapBodies.clear();
    sitemapBodies.set(origin, kept);
  }
  const cache = "public, max-age=300";
  const sent = ctx.request.headers.get("if-none-match");
  if (sent !== null && sent.split(",").some((t) => t.trim() === kept.etag))
    return new Response(null, { status: 304, headers: { etag: kept.etag, "cache-control": cache } });
  const res = text(kept.body, "application/xml; charset=utf-8");
  res.headers.set("etag", kept.etag);
  res.headers.set("cache-control", cache);
  return res;
}

/** GET /manifest.webmanifest — the forge as an app on a home screen. */
export function webManifest(ctx: Ctx): Response {
  const name = ctx.app.config.edgeName ? "forge" : "forge";
  return new Response(
    JSON.stringify(
      {
        name,
        short_name: name,
        description: SITE_LINE,
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
        // A long-press on the installed icon: what is on the owner, or a
        // word with the forge's agents, one tap from the home screen.
        shortcuts: [
          { name: "On you", short_name: "On you", url: "/asks", icons: [{ src: "/icons/forge-192.png", sizes: "192x192", type: "image/png" }] },
          { name: "Talk", short_name: "Talk", url: "/talk", icons: [{ src: "/icons/forge-192.png", sizes: "192x192", type: "image/png" }] },
        ],
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

const SIZES = new Set([32, 180, 192, 512]);

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
  return pngResponse(markPng(size, shape));
}

/**
 * GET /favicon.ico — the mark at 32px (`/icons/forge-32.png`). Every page
 * carries its own inline SVG icon, but a browser asks here anyway on a page
 * that is not ours (a raw file, a JSON answer); a PNG under an .ico name is
 * read by every browser that asks, and answering spares the console a 404.
 */
export function favicon(): Response {
  return pngResponse(markPng(32, "icon"));
}

function pngResponse(png: Uint8Array): Response {
  return new Response(png, {
    headers: {
      "content-type": "image/png",
      "content-length": String(png.length),
      "cache-control": `public, max-age=${(7 * DAY) / 1000}, immutable`,
    },
  });
}

/** The icon a browser, a home screen or an unfurler asks for by habit. */
function fixedIcon(spec: string) {
  return (ctx: Ctx): Response => iconPng({ ...ctx, params: { ...ctx.params, spec } });
}

/** GET /apple-touch-icon.png and the -precomposed twin — the 180 icon. */
export const appleTouchIcon = fixedIcon("forge-180");

/** `Running 0.7.51 at a1b2c3d`: which build these instructions describe. */
function runningSentence(): string {
  const r = running();
  return r.commit === null
    ? `Running ${r.version}`
    : `Running ${r.version} at ${r.commit.slice(0, 7)}`;
}

/** llms.txt and its ETag per origin, valid while the listing read, the build, the tell command and the plugin source being public are the same. */
const llmsBodies = new Map<string, { signedIn: boolean; repos: LlmsListing; running: string; tell: string | undefined; plugins: boolean; body: string; etag: string }>();

/**
 * GET /llms.txt — the forge as an agent should meet it (llmstxt.org): what
 * this is, how to report a problem with no account, how to offer a change,
 * where the API and the MCP are, and the public repositories. Facts only,
 * each with the method and URL that does it.
 */
export function llmsTxt(ctx: Ctx): Response {
  const o = ctx.url.origin;
  const tell = sshTellCommand(ctx.app);
  const running = runningSentence();
  const plugins = pluginsOffered(ctx.app.db);
  const repos = timePhase(ctx.request, "repos", () => llmsRepos(ctx.app.db));
  // The tools section depends on who asks, so the signed-in and the anonymous body are kept apart.
  const signedIn = ctx.auth.user !== undefined;
  const key = `${o} ${signedIn}`;
  let kept = llmsBodies.get(key);
  if (kept === undefined || kept.repos !== repos || kept.running !== running || kept.tell !== tell || kept.plugins !== plugins) {
    const body = timePhase(ctx.request, "render", () => renderLlmsTxt(ctx, o, tell, running, repos, signedIn, plugins));
    const etag = timePhase(ctx.request, "etag", () => `"${new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 32)}"`);
    kept = { signedIn, repos, running, tell, plugins, body, etag };
    // Origins come from the Host header: keep a handful, not one per guess.
    if (llmsBodies.size >= 16) llmsBodies.clear();
    llmsBodies.set(key, kept);
  }
  // The third line names the running commit: a client revalidates (one small 304) rather than keep an old build for an hour.
  const cache = "private, no-cache";
  const sent = ctx.request.headers.get("if-none-match");
  if (sent !== null && sent.split(",").some((t) => t.trim() === kept.etag))
    return new Response(null, { status: 304, headers: { etag: kept.etag, "cache-control": cache, vary: "Cookie, Authorization" } });
  const res = text(kept.body, "text/markdown; charset=utf-8");
  res.headers.set("cache-control", cache);
  res.headers.set("etag", kept.etag);
  res.headers.append("vary", "Cookie, Authorization");
  return res;
}

/** The llms.txt document for one origin. */
function renderLlmsTxt(ctx: Ctx, o: string, tell: string | undefined, running: string, repos: LlmsListing, signedIn: boolean, plugins: boolean): string {
  const mcp = mcpPointers(o);
  return (
    [
      `# forge at ${ctx.url.host}`,
      "",
      running,
      "",
      `> ${SITE_LINE} A self-hosted forge in one Bun process and one SQLite file that hosts code and runs apps, with AI agents that build. Forges connect to one another. Anyone may read a public repository, and report a problem in it without an account.`,
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
      "## Use it from your harness",
      "",
      `- MCP endpoint: ${mcp.url} (streamable HTTP; OAuth metadata at ${mcp.oauth}). Or send a token as Authorization: Bearer.`,
      ...(plugins
        ? HARNESS_PLUGINS.map(
            (p) => `- ${p.label} plugin (source ${pluginSource(o)}, path ${p.path}; ${p.setup}): \`${p.install(o)}\``,
          )
        : ["- Harness plugins: not offered on this forge (their source is private)"]),
      "",
      "## What you can do on any page",
      "",
      `- GET ${o}/api/v1/here?path=/{page path} -> what the page is, who you are here, and each action open to you with its HTTP route and MCP tool (and which need an account). Every page links to it: rel="alternate" type="application/json". On an app's own pages the forge's link is the one titled "this app's repository on its forge"; follow that one. MCP: the tool "here" with the page URL.`,
      "",
      ...(tell === undefined
        ? []
        : [
            "## Tell the crew from a shell",
            "",
            `- With an account and an SSH key added under Settings -> Keys: \`${tell}\` tells the crew in one line and prints where it went.`,
            "",
          ]),
      "## Find things (no account)",
      "",
      `- Explore repositories: GET ${o}/api/v1/explore?q=kind:app+sort:forks+garden. MCP: the tool "explore" with {"q"}. In q, kind: is app, person or forge; sort: is score, forks, ships, likes, use, fresh or name; updated: is 1d, 7d or 30d; owner:<name> is one account; archived: is yes or no; any other word is free text matched against name, owner and description.`,
      `- Search issues, pulls, repositories and code: GET ${o}/api/v1/search?q=websocket+timeout. MCP: the tool "search" with {"q"}.`,
      "- Both read only what is public to you.",
      "",
      "## For agents with an account",
      "",
      `- MCP: ${mcp.url} (OAuth discovery: ${mcp.oauth}; server card, a draft format: ${o}/.well-known/mcp.json)`,
      `- API: ${o}/api/v1, Authorization: Bearer <token>`,
      `- OpenAPI: GET ${o}/api/v1/openapi.json (redirects to ${o}/contract/openapi.json)`,
      "",
      ...mcpToolsSection(o, signedIn),
      "## Public repositories",
      "",
      // Names and addresses only: a description is whatever its owner
      // wrote, and an agent reading this file must not meet anyone's words
      // as the forge's own.
      ...(repos.lines.length > 0
        ? [
            ...repos.lines.map(
              (r) =>
                `- [${r.path}](${o}/${r.path})` +
                (r.forks > 0
                  ? ` · ${r.forks} ${r.forks === 1 ? "fork" : "forks"}`
                  : ""),
            ),
            ...(repos.more
              ? [`- More: ${o}/api/v1/explore`]
              : []),
          ]
        : ["None yet."]),
      "",
    ].join("\n")
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
        title: REPORT_LINK_TITLE,
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
