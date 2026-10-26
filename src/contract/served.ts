/**
 * The OpenAPI document as `/contract/openapi.json` serves it: built once per
 * origin and version, tagged by its own bytes, answered 304 to that tag.
 */

import { holds, weakEtag } from "../http/etag.ts";
import type { Handler } from "../http/context.ts";
import type { Router } from "../http/router.ts";
import { running } from "../kernel/version.ts";
import { openapi } from "./openapi.ts";

const MAX = 8;
const built = new Map<string, { text: string; etag: string }>();

/**
 * The document and its tag. The origin comes from the request, so the map
 * is bounded; the oldest entry goes first. The tag hashes the text, so a
 * build without a version stamp still changes it when the contract does.
 */
export function openapiText(origin: string, version: string): { text: string; etag: string } {
  const key = `${version}\n${origin}`;
  let hit = built.get(key);
  if (!hit) {
    const text = JSON.stringify(openapi(origin, version));
    hit = { text, etag: weakEtag(text) };
    if (built.size >= MAX) built.delete(built.keys().next().value as string);
    built.set(key, hit);
  }
  return hit;
}

export function openapiRoute(router: Router<Handler>): void {
  router.add("GET", "/contract/openapi.json", (ctx) => {
    const { text, etag } = openapiText(ctx.url.origin, running().version);
    const headers = { "cache-control": "public, max-age=300", etag };
    if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
    return new Response(text, { headers: { "content-type": "application/json", ...headers } });
  });
}
