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

import type { Route } from "./openapi/shared.ts";
import * as each from "./openapi/routes/index.ts";

/** Every row, sorted by operationId: the index's order. */
export const ROUTES: readonly Route[] = Object.values(each);

/** A route's operationId, and the name of the file that holds it. */
export function operationId(r: Pick<Route, "method" | "path">): string {
  return `${r.method}${r.path.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ?? "").toUpperCase())}`;
}

const schema = (t: string) => (t === "object" ? { type: "object" } : t === "array" ? { type: "array", items: { type: "object" } } : { type: t });

/** The document, for the forge served at `origin`. */
export function openapi(origin: string, version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) {
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
      summary: r.summary,
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
      ...(r.auth ? { security: [{ token: [] }] } : {}),
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
        default: {
          description:
            "An error: { error, message }; `error` is a stable code" +
            (r.refusals === undefined
              ? ""
              : `. Refusals: ${Object.entries(r.refusals).map(([c, w]) => `\`${c}\` (${w})`).join("; ")}`),
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
        "The routes the forge names to an agent. `not_found` means missing or not yours to see.",
    },
    servers: [{ url: origin }],
    paths,
    components: {
      securitySchemes: { token: { type: "http", scheme: "bearer" } },
    },
  };
}
