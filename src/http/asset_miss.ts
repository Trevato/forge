/**
 * A path that names a file (`/feed.xml`, `/x.png`) and matches no route is a
 * crawler or a tool, not a person: it gets a 404 in a few dozen bytes instead
 * of the full not-found page. Extensionless and `.html` paths keep the page.
 */

const ASSET_EXTENSION = /\.(?:xml|json|txt|js|css|map|png|ico)$/;
/** Machine surfaces that keep their own JSON miss; the one list server.ts shares. */
export const MACHINE_PREFIX = /^\/(?:api|contract|mcp|oauth|\.well-known|metrics|healthz)(?:\/|$)/;

export function isAssetMiss(request: Request, pathname: string): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  return ASSET_EXTENSION.test(pathname) && !MACHINE_PREFIX.test(pathname);
}

export function assetNotFound(): Response {
  return new Response("not found\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
