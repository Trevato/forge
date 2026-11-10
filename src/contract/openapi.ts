/**
 * The forge's public API as an OpenAPI 3.1 document: the routes the
 * manifest (`actions/here.ts`) names to an agent, one row each, so a client
 * that reads OpenAPI (OpenCode's Code Mode, any agent harness) can call the
 * forge without a hand-written wrapper. Plain data in, plain data out;
 * `GET /contract/openapi.json` serves it. A route added to the manifest is
 * added here, and `test/openapi.test.ts` fails until it is.
 *
 * Each row is its own file, `openapi/routes/<operationId>.ts`, gathered by
 * the generated `openapi/routes/index.ts` (`bun scripts/openapi-routes.ts`),
 * so pulls describing different routes do not collide (#5936).
 */

import type { QueryType, Route } from "./openapi/shared.ts";
import { OAUTH_SCOPES, type OAuthScope } from "../core/oauth.ts";
import { tagList, tagOf } from "./tags.ts";
import * as each from "./openapi/routes/index.ts";

/** What each OAuth scope grants; a scope added to OAUTH_SCOPES without a line here fails the type check. */
const SCOPE_WORDS: Readonly<Record<OAuthScope, string>> = {
  ro: "Read the API as the person",
  rw: "Read and write the API as the person",
};

/**
 * The one scope an operation asks for. Scopes in one requirement are all
 * required (OpenAPI 3.1 §4.8.30) and `/oauth/authorize` grants a single
 * one, so a read asks for `ro` and anything else for `rw`, which reads too.
 */
export const oauthScopeFor = (method: Route["method"]): OAuthScope => (method === "get" ? "ro" : "rw");

/** Every row, sorted by operationId: the index's order. */
export const ROUTES: readonly Route[] = Object.values(each);

/** A GET that declares a `cursor` pages by it; `?page=` and `?offset=` are refused with a 400 (`http/cursor_lists.ts`). */
export const pagesByCursor = (r: Pick<Route, "method" | "query">): boolean => r.method === "get" && r.query !== undefined && "cursor" in r.query;

const PAGE_REFUSAL = "page or offset was sent: this list pages by cursor, pass next_cursor as ?cursor= (400)";

/** A route's operationId, and the name of the file that holds it. */
export function operationId(r: Pick<Route, "method" | "path">): string {
  return `${r.method}${r.path.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ?? "").toUpperCase())}`;
}

const schema = (t: QueryType) =>
  typeof t !== "string"
    ? { type: t.type, ...(t.min === undefined ? {} : { minimum: t.min }), ...(t.max === undefined ? {} : { maximum: t.max }) }
    : (t === "object" ? { type: "object" } : t === "array" ? { type: "array", items: { type: "object" } } : { type: t });

/** The document, for the forge served at `origin`. */
export function openapi(origin: string, version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) {
    const refusals = pagesByCursor(r) ? { invalid_query: PAGE_REFUSAL, ...r.refusals } : r.refusals;
    const params = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: m[1] === "number" || m[1] === "blocker" ? "integer" : "string" },
    }));
    const query = Object.entries(r.query ?? {}).map(([name, t]) => ({
      name,
      in: "query",
      required: false,
      schema:
        name === "state"
          ? { type: "string", enum: ["open", "closed", "all"] }
          : name === "fields"
            ? { type: "string", enum: ["brief"] }
            : name === "diff"
              ? { type: "string", enum: ["0", "1"], default: "1" }
              : schema(t),
    }));
    (paths[r.path] ??= {})[r.method] = {
      operationId: operationId(r),
      tags: [tagOf(r.path)],
      summary: r.summary,
      "x-role": r.role,
      parameters: [...params, ...query],
      ...(r.body === undefined
        ? {}
        : {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: Object.fromEntries(
                      Object.entries(r.body).map(([k, t]) => [k, schema(t)]),
                    ),
                  },
                },
              },
            },
          }),
      // Routes that need no credential opt out of the document's default with `security: []`.
      security: r.auth ? [{ token: [] }, { oauth2: [oauthScopeFor(r.method)] }] : [],
      responses: {
        [String(r.status ?? 200)]: {
          description: "Done",
          ...(r.reply === undefined
            ? {}
            : {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: Object.fromEntries(Object.entries(r.reply).map(([k, t]) => [k, schema(t)])),
                    },
                  },
                },
              }),
        },
        ...Object.fromEntries((r.alsoStatus ?? []).map((c) => [String(c), { description: "Done" }])),
        ...(pagesByCursor(r) ? { "400": { description: PAGE_REFUSAL } } : {}),
        default: {
          description:
            "An error: { error, message }; `error` is a stable code" +
            (refusals === undefined
              ? ""
              : `. Refusals: ${Object.entries(refusals).map(([c, w]) => `\`${c}\` (${w})`).join("; ")}`),
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "forge",
      version,
      description:
        "The routes the forge names to an agent. `not_found` means missing or not yours to see. Every 429 and 503 carries an integer `Retry-After` and `retryAfter` (the same seconds) in a JSON body.",
    },
    servers: [{ url: origin }],
    tags: tagList(ROUTES.map((r) => tagOf(r.path))),
    // The default: a bearer token. Open routes say `security: []`.
    security: [{ token: [] }],
    paths,
    components: {
      securitySchemes: {
        token: { type: "http", scheme: "bearer" },
        // RFC 6749 §4.1 authorization code (with PKCE), §6 refresh; the token endpoint serves both grants.
        oauth2: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: `${origin}/oauth/authorize`,
              tokenUrl: `${origin}/oauth/token`,
              refreshUrl: `${origin}/oauth/token`,
              scopes: Object.fromEntries(OAUTH_SCOPES.map((scope) => [scope, SCOPE_WORDS[scope]])),
            },
          },
        },
        openid: { type: "openIdConnect", openIdConnectUrl: `${origin}/.well-known/openid-configuration` },
      },
    },
  };
}
