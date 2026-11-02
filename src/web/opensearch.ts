/**
 * The forge as a browser search engine (OpenSearch 1.1): type the forge's
 * name in the address bar, tab, and the query goes to /search.
 *
 * The URL is built from the configured origin, never from the request's
 * Host header: a description is installed once and trusted afterwards, so
 * a forged Host must not be able to point it somewhere else.
 */

import type { App } from "../app.ts";
import type { Ctx } from "../http/context.ts";
import { escapeHtml } from "./html.ts";

export const OPENSEARCH_PATH = "/opensearch.xml";
export const OPENSEARCH_TYPE = "application/opensearchdescription+xml";
export const OPENSEARCH_TITLE = "forge";

function origin(app: App): string {
  return new URL(app.config.url ?? `http://localhost:${app.config.port}`).origin;
}

/** The description document for this forge. */
export function openSearchXml(app: App): string {
  const base = origin(app);
  const name = escapeHtml(OPENSEARCH_TITLE);
  return `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>${name}</ShortName>
  <Description>Search ${name}</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Url type="text/html" method="get" template="${escapeHtml(base)}/search?q={searchTerms}"/>
  <Url type="application/json" method="get" template="${escapeHtml(base)}/api/v1/search?q={searchTerms}"/>
  <Url type="${OPENSEARCH_TYPE}" rel="self" template="${escapeHtml(base)}${OPENSEARCH_PATH}"/>
</OpenSearchDescription>
`;
}

/** GET /opensearch.xml */
export function openSearch(ctx: Ctx): Response {
  return new Response(openSearchXml(ctx.app), {
    headers: {
      "content-type": `${OPENSEARCH_TYPE}; charset=utf-8`,
      "cache-control": "public, max-age=3600",
    },
  });
}
