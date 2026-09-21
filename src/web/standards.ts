/**
 * The well-known files a site on the open web is expected to have, served
 * by default so a forge is a good citizen the moment it boots:
 *
 *   /.well-known/security.txt     who to tell about a vulnerability (RFC 9116)
 *   /.well-known/change-password  where a password manager sends someone
 *   /robots.txt                   what a crawler may index, and the sitemap
 *   /sitemap.xml                  every public repository
 *   /manifest.webmanifest         the forge as an installable app
 *   /icons/forge-<size>.png       the mark, rastered for the manifest and iOS
 *
 * Nothing here is configured; everything is derived from what the forge
 * already knows — its URL, its first account, its public repositories, its
 * own mark. Operators who want a different security contact set
 * FORGE_SECURITY_CONTACT.
 */

import { markPng, type MarkShape } from "../design/mark.ts";
import { listReposVisibleTo } from "../core/repos.ts";
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
  const origin = ctx.url.origin;
  const repos = listReposVisibleTo(ctx.app.db, undefined, { limit: 5000 });
  const urls = [
    `<url><loc>${xml(origin)}/</loc></url>`,
    ...repos.map(
      (r) =>
        `<url><loc>${xml(`${origin}/${r.ownerName}/${r.name}`)}</loc></url>`,
    ),
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
        background_color: "#fafafa",
        theme_color: "#fafafa",
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
