/**
 * The forge's public API as an OpenAPI 3.1 document: the routes the
 * manifest (`actions/here.ts`) names to an agent, one row each, so a client
 * that reads OpenAPI (OpenCode's Code Mode, any agent harness) can call the
 * forge without a hand-written wrapper. Plain data in, plain data out;
 * `GET /contract/openapi.json` serves it. A route added to the manifest is
 * added here, and `test/openapi.test.ts` fails until it is.
 */

interface Route {
  readonly method: "get" | "post" | "patch" | "delete";
  readonly path: string;
  readonly summary: string;
  /** Whether it needs a token; reads of public things do not. */
  readonly auth: boolean;
  /** A JSON body's fields, when it takes one. */
  readonly body?: Readonly<Record<string, string>>;
}

const REPO = "/api/v1/repos/{owner}/{name}";

export const ROUTES: readonly Route[] = [
  { method: "get", path: "/api/v1/repos", summary: "List public repositories", auth: false },
  { method: "get", path: REPO, summary: "Read one repository", auth: false },
  {
    method: "post",
    path: `${REPO}/reports`,
    summary: "Report a problem in a public repository, without an account",
    auth: false,
    body: { title: "string", body: "string", page: "string" },
  },
  {
    method: "post",
    path: `${REPO}/issues`,
    summary: "Open an issue",
    auth: true,
    body: { title: "string", body: "string" },
  },
  {
    method: "post",
    path: `${REPO}/issues/{number}/comments`,
    summary: "Comment on an issue or pull",
    auth: true,
    body: { body: "string" },
  },
  { method: "post", path: `${REPO}/forks`, summary: "Fork a repository", auth: true },
  {
    method: "post",
    path: `${REPO}/pulls`,
    summary: "Offer a change as a pull",
    auth: true,
    body: { title: "string", head: "string", headRepo: "string" },
  },
  {
    method: "post",
    path: `${REPO}/pulls/{number}/reviews`,
    summary: "Give a verdict on a pull",
    auth: true,
    body: { verdict: "string", body: "string" },
  },
  { method: "post", path: `${REPO}/pulls/{number}/merge`, summary: "Merge a pull (a person's)", auth: true },
  { method: "patch", path: REPO, summary: "Change a repository's settings", auth: true },
  { method: "get", path: `${REPO}/app/production/open`, summary: "Open the running app", auth: false },
  { method: "get", path: `${REPO}/map`, summary: "Read the plan: issues, their dependency edges and pillars", auth: false },
  {
    method: "post",
    path: `${REPO}/plan`,
    summary: "Open a plan of issues and their dependencies, all or nothing",
    auth: true,
    body: { issues: "array" },
  },
  {
    method: "post",
    path: `${REPO}/issues/{number}/dependencies`,
    summary: "Make an issue wait for another",
    auth: true,
    body: { blockedBy: "integer" },
  },
  {
    method: "delete",
    path: `${REPO}/issues/{number}/dependencies/{blocker}`,
    summary: "Stop an issue waiting for another",
    auth: true,
  },
  {
    method: "post",
    path: "/mcp",
    summary: "The forge as an MCP server (JSON-RPC 2.0); see docs/MCP.md",
    auth: true,
    body: { jsonrpc: "string", id: "integer", method: "string", params: "object" },
  },
];

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
    (paths[r.path] ??= {})[r.method] = {
      operationId: `${r.method}${r.path.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ?? "").toUpperCase())}`,
      summary: r.summary,
      parameters: params,
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
        "200": { description: "Done" },
        default: {
          description: "An error: { error, message }; `error` is a stable code",
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
