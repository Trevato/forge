/**
 * The well-known files a site on the open web is expected to have, served
 * by default so a forge is a good citizen the moment it boots:
 *
 *   /.well-known/security.txt     who to tell about a vulnerability (RFC 9116)
 *   /.well-known/mcp.json         the MCP server card: endpoint, sign-in, the
 *                                 tool that needs no token (a draft format:
 *                                 only fields we keep true)
 *   /.well-known/api-catalog      the API catalog (RFC 9727): a linkset naming the
 *                                 OpenAPI description, the MCP card and the docs
 *   /.well-known/forge            the standards this forge implements, with versions
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

import { UPSTREAM_REPO } from "../core/upstream.ts";
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
import { SHARE_TARGET } from "./share_target.ts";
import { SITE_LINE } from "./site_line.ts";
import { mcpToolsSection } from "./llms_tools.ts";
import { apiCatalog, cardsLine, DISCOVERY, mcpCard, offeredPlugins, mcpPointers, offeredPluginRepo, pluginSource } from "../core/mcp_card.ts";
import { forgeDocument } from "../core/standards_index.ts";
import { TAGS } from "../contract/served.ts";
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
  const res = text(JSON.stringify(mcpCard(ctx.url.origin, offeredPluginRepo(ctx.app.db, ctx.app.config.forgeRepo, UPSTREAM_REPO)), null, 2), "application/json");
  res.headers.set("access-control-allow-origin", "*");
  return res;
}

/** GET /.well-known/api-catalog — RFC 9727: one linkset naming each API's description and docs. Anonymous. */
export function apiCatalogJson(ctx: Ctx): Response {
  const res = new Response(JSON.stringify(apiCatalog(ctx.url.origin)), {
    headers: {
      "content-type": 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
  return res;
}

/** GET /.well-known/forge — the standards this forge implements, by id and version (docs/standards/). */
export function forgeJson(): Response {
  const res = text(JSON.stringify(forgeDocument(running().version)), "application/json");
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
        `<url><loc>${o}/agents</loc></url>`,
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
        // composer with it filled in (`sharedDraft`, share_target.ts).
        share_target: SHARE_TARGET,
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
const llmsBodies = new Map<string, { signedIn: boolean; repos: LlmsListing; running: string; tell: string | undefined; plugins: string | undefined; body: string; etag: string }>();

/**
 * GET /llms.txt — the forge as an agent should meet it (llmstxt.org): what
 * this is, how to report a problem with no account, how to offer a change,
 * where the API and the MCP are, and the public repositories. Facts only,
 * each with the method and URL that does it.
 */
export function llmsTxt(ctx: Ctx): Response {
  const kept = llmsBody(ctx);
  // The third line names the running commit: a client revalidates (one small 304) rather than keep an old build for an hour.
  const cache = "private, no-cache";
  const sent = ctx.request.headers.get("if-none-match");
  if (sent !== null && sent.split(",").some((t) => t.trim() === kept.etag))
    return new Response(null, { status: 304, headers: { etag: kept.etag, "cache-control": cache, vary: "Cookie, Authorization" } });
  const res = text(kept.body);
  res.headers.set("cache-control", cache);
  res.headers.set("etag", kept.etag);
  res.headers.append("vary", "Cookie, Authorization");
  return res;
}

/** The llms.txt text for this request and its ETag: /llms.txt sends it as is, /agents draws it as a page. */
export function llmsBody(ctx: Ctx): { body: string; etag: string } {
  const o = ctx.url.origin;
  const tell = sshTellCommand(ctx.app);
  const running = runningSentence();
  const plugins = offeredPluginRepo(ctx.app.db, ctx.app.config.forgeRepo, UPSTREAM_REPO);
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
  return kept;
}

/** The llms.txt document for one origin. */
/** One llms.txt line per plugin on offer; a cloned one names its source, a served one says so. */
function pluginLines(o: string, plugins: string | undefined): string[] {
  const lines = offeredPlugins(plugins).map((p) => {
    const where = p.cloned && plugins !== undefined ? `source ${pluginSource(o, plugins)}, ` : "served by this forge, ";
    return `- ${p.label} plugin (${where}path ${p.path}; ${p.setup}): \`${p.install(o, plugins ?? "")}\``;
  });
  return plugins === undefined ? [...lines, "- Claude Code plugin: not offered here (no public source)"] : lines;
}

function renderLlmsTxt(ctx: Ctx, o: string, tell: string | undefined, running: string, repos: LlmsListing, signedIn: boolean, plugins: string | undefined): string {
  const mcp = mcpPointers(o);
  return (
    [
      `# forge at ${ctx.url.host}`,
      "",
      running,
      "",
      `> ${SITE_LINE} A self-hosted forge in one Bun process and one SQLite file that hosts code and runs apps, with AI agents that build. Forges connect to one another. Part of Open Platform (https://www.open-platform.sh). Anyone may read a public repository, and report a problem in it without an account.`,
      "",
      "## Start here",
      "",
      "If you are an assistant helping a person: say plainly what you can and cannot do from here. If you cannot reach this forge, give the person these steps.",
      "",
      `- Build now, no account: \`curl -sX POST ${o}/api/v1/start -d '{"name":"my-app"}'\` -> {user, token, repo, git, app, claim}. Clone git.url (user:token@), \`git push\` to main: app.url is live. Give claim.url to the person who takes it over. Unclaimed: asleep in 7 days, archived in 30.`,
      `- Or with an account: sign up at ${o}/signup, then follow "Offer a change" below. By request, POST ${o}/api/v1/users gives 202 {state:"waiting"}. If /signup says 403, use "Report a problem".`,
      `- Get your own forge: \`git clone ${UPSTREAM_REPO}.git && cd forge && bun install && bun run src/main.ts\`, then in a second terminal \`bun src/main.ts --first-admin\`, which prints a one-time link that makes you the admin. It needs Bun; its crew needs the claude CLI and a model credential. Or a hosted one, plans on ${o}: sign in and open ${o}/forges/new (or call the MCP \`spawn\` tool with the person's consent). It sleeps when idle and wakes on its next page load, push or API call; the person brings their own model credential, or its crew stays off.`,
      `- Work from your own forge: connect it to this one as an origin, bring an app in, and send your work back. How: ${UPSTREAM_REPO}/raw/main/docs/ORIGINS.md`,
      `- Connect an assistant that uses tools: custom connector URL ${mcp.url} (OAuth); start and report need no account.`,
      "",
      "## Report a problem (no account)",
      "",
      `- Page: ${o}/{owner}/{name}/report`,
      `- API: POST ${o}/api/v1/repos/{owner}/{name}/reports with JSON {"title": "...", "body": "...", "page": "https://..."} -> 202 {"id", "state": "pending"}`,
      `- MCP: POST ${mcp.url}, method tools/call, name "report", arguments {"repo": "owner/name", "title", "body", "page"}; this one tool needs no token`,
      `- Plain text: a title of 1-${TITLE_MAX} characters, a body of at most ${BODY_MAX}; a few a minute from one source. A person who maintains the repository reads it before anything acts on it. A private repository answers not_found.`,
      "",
      "## Offer a change",
      "",
      `- Needs an account. Fork: POST ${o}/api/v1/repos/{owner}/{name}/forks; push a branch to your fork over git; then POST ${o}/api/v1/repos/{owner}/{name}/pulls with {"title", "body", "base", "head", "headRepo": "you/name"}.`,
      "",
      "## Use it from your harness",
      "",
      `- MCP endpoint: ${mcp.url} (streamable HTTP; OAuth metadata at ${mcp.oauth}). Or send a token as Authorization: Bearer.`,
      ...pluginLines(o, plugins),
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
      `- Explore repositories: GET ${o}/api/v1/explore?q=kind:app+sort:forks+garden. (MCP "explore": with an account.) In q, kind: is app, person or forge; sort: is score, forks, ships, likes, use, fresh or name; updated: is 1d, 7d or 30d; owner:<name> is one account; archived: is yes or no; any other word is free text matched against name, owner and description.`,
      `- Search issues, pulls, repositories and code: GET ${o}/api/v1/search?q=websocket+timeout. (MCP "search": with an account.)`,
      "- Both read only what is public to you.",
      "",
      "## For agents with an account",
      "",
      `- MCP: ${mcp.url} (OAuth discovery: ${mcp.oauth}; server card, a draft format: ${o}${DISCOVERY.card})`,
      `- API: ${o}${DISCOVERY.api} (the root lists the other URLs), Authorization: Bearer <token>`,
      `- API catalog (RFC 9727, one linkset of the above): ${o}${DISCOVERY.catalog}`,
      `- OpenAPI: GET ${o}${DISCOVERY.openapi}, or one slice with ?tag= (${TAGS.join(", ")})`,
      "",
      ...mcpToolsSection(o, signedIn),
      cardsLine(),
      "",
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
    { rel: "service-doc", href: "/llms.txt", type: "text/plain" },
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
