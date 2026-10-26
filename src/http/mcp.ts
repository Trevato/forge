/**
 * The forge as a Model Context Protocol server: `POST /mcp`.
 *
 * The studio's verbs — tell, say, now, stop, and a fork's
 * following — as tools, so an assistant a person already talks to can run
 * their forge from wherever they are. Added to Claude as a connector, the
 * Claude app is the forge's phone UI with no app to build.
 *
 * Built to survive a tunnel and a sleeping forge: every call is one short
 * JSON-RPC request and one JSON answer. No stream is ever held open, so
 * there is nothing for a proxy to cut, and the first call is what wakes a
 * forge that scaled to zero. Writes are the same actions the pages call,
 * with the same checks; nothing here is a second way in.
 *
 * Identity is a forge token (`Authorization: Bearer …`), never a browser
 * session: a cookie is what a cross-site page could ride, and this door has
 * no page. `ro` tokens read; `rw` tokens act.
 */

import { CARD_KINDS, CARD_MIME, CARD_OF_TOOL, CARD_SHELL, CARD_URI, cardFor } from "../web/studio/cards.ts";
import { getRepo } from "../core/repos.ts";
import { scopeAllows } from "../core/tokens.ts";
import type { User } from "../core/users.ts";
import { openapi } from "../contract/openapi.ts";
import type { Ctx, Handler } from "./context.ts";
import { running } from "../kernel/version.ts";
import { resourceMetadataUrl } from "./oauth.ts";
import { body, boundedBody, json } from "./respond.ts";
import type { Router } from "./router.ts";
import { clientBucket } from "./peer.ts";
import { fileReport } from "../actions/reports.ts";
import { REPORT_RECEIVED } from "../actions/report_words.ts";
import { BODY_MAX, REQUEST_MAX, TITLE_MAX } from "../core/reports.ts";
import { everydayOf } from "../core/everyday.ts";
import { type Args, visible, plansOnly, str, REPO_ARG, lean } from "./mcp/shared.ts";
import { TOOLS } from "./mcp/tools.ts";

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
/** Who answers: the forge, at the version its build stamped. */
const server = () => ({ name: "forge", version: running().version });


/**
 * Said to an MCP client whose token belongs to a site admin (#596): it acts
 * as admin, and the person's everyday account is where daily work belongs.
 */
function adminNote(ctx: Ctx, user: User): string {
  if (!user.isAdmin) return "";
  const daily = everydayOf(ctx.app.db, user);
  return ` Note: this token belongs to ${user.username}, the forge's admin, so what you do here acts as admin.${
    daily === undefined
      ? " Daily work belongs on an everyday account, apart from admin."
      : ` Daily work belongs on ${daily.username}, their everyday account.`
  }`;
}

/** A card's model beside the text, for a host that draws `ui://` resources. */
function cardResult(
  name: string,
  value: unknown,
  origin: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const card = cardFor(name, value, origin, extra);
  return card === undefined ? {} : { structuredContent: { card } };
}

function rpcOne(
  ctx: Ctx,
  user: User,
  message: unknown,
): Promise<unknown | undefined> | unknown | undefined {
  const m =
    typeof message === "object" && message !== null
      ? (message as Record<string, unknown>)
      : {};
  const id = m["id"] ?? null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const refuse = (code: number, text: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message: text },
  });
  if (m["jsonrpc"] !== "2.0" || typeof m["method"] !== "string")
    return refuse(-32600, "not a JSON-RPC 2.0 request");
  // A notification expects nothing back.
  if (m["id"] === undefined) return undefined;
  const params =
    typeof m["params"] === "object" && m["params"] !== null
      ? (m["params"] as Record<string, unknown>)
      : {};
  switch (m["method"]) {
    case "initialize": {
      const asked = str(params["protocolVersion"]);
      return reply({
        protocolVersion: (PROTOCOLS as readonly string[]).includes(asked)
          ? asked
          : PROTOCOLS[0],
        capabilities: { tools: {}, resources: {} },
        serverInfo: server(),
        instructions: `This is a person's forge: their apps, and the crew that builds them. \`tell\` and \`say\` are how they direct it. Keep what you relay short — three sentences and the real options.${adminNote(ctx, user)}`,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: [
          ...TOOLS.filter((t) => visible(t, ctx, user)).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: lean(t.inputSchema),
            // readOnlyHint defaults to false (MCP tool annotations), so only a
            // read says so: 57 copies of the default were 2 KB of the 40 KB.
            ...(t.writes ? {} : { annotations: { readOnlyHint: true } }),
            ...(CARD_OF_TOOL[t.name] === undefined
              ? {}
              : {
                  _meta: {
                    ui: { resourceUri: CARD_URI(CARD_OF_TOOL[t.name]!) },
                  },
                }),
          })),
          REPORT_TOOL,
        ],
      });
    case "resources/list":
      return reply({
        resources: CARD_KINDS.map((k) => ({
          uri: CARD_URI(k),
          name: `forge-${k}-card`,
          mimeType: CARD_MIME,
        })),
      });
    case "resources/read": {
      const uri = str(params["uri"]);
      const kind = CARD_KINDS.find((k) => CARD_URI(k) === uri);
      if (kind === undefined) return refuse(-32002, `no resource ${uri}`);
      return reply({
        contents: [{ uri, mimeType: CARD_MIME, text: CARD_SHELL(kind) }],
      });
    }
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params["name"]);
      if (tool === undefined || !visible(tool, ctx, user))
        return refuse(-32602, `no tool named ${String(params["name"])}`);
      const args =
        typeof params["arguments"] === "object" && params["arguments"] !== null
          ? (params["arguments"] as Args)
          : {};
      if (tool.writes && !plansOnly(tool, args) && !scopeAllows(ctx.auth.scope ?? "ro", "rw"))
        return reply({
          content: [
            { type: "text", text: "forbidden: this token may read, not act" },
          ],
          isError: true,
        });
      return Promise.resolve(tool.run(ctx, user, args)).then((answer) =>
        reply(
          answer.ok
            ? {
                content: [{ type: "text", text: JSON.stringify(answer.value) }],
                ...cardResult(String(params["name"]), answer.value, ctx.url.origin, answer.card),
              }
            : {
                content: [
                  { type: "text", text: `${answer.error}: ${answer.message}` },
                ],
                isError: true,
              },
        ),
      );
    }
    default:
      return refuse(-32601, `no method ${String(m["method"])}`);
  }
}

/**
 * `report`, the one tool open without a token: a stranger's report on a
 * public repository (`actions/reports.ts`), with the same limits as the
 * page and the API. Everything else here needs a token.
 */
const REPORT_TOOL = {
  name: "report",
  description:
    "Report a problem in a public repository, without an account. Plain text; a person reads it first.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      title: { type: "string", maxLength: TITLE_MAX },
      body: { type: "string", maxLength: BODY_MAX },
      page: {
        type: "string",
        description: "Address where seen.",
      },
    },
    required: ["repo", "title"],
  },
} as const;

/** The JSON-RPC answer to a `report` call, or undefined for any other message. */
function reportCall(ctx: Ctx, message: unknown): unknown | undefined {
  const m =
    typeof message === "object" && message !== null
      ? (message as Record<string, unknown>)
      : {};
  const params =
    typeof m["params"] === "object" && m["params"] !== null
      ? (m["params"] as Record<string, unknown>)
      : {};
  if (
    m["jsonrpc"] !== "2.0" ||
    m["method"] !== "tools/call" ||
    params["name"] !== "report" ||
    m["id"] === undefined
  )
    return undefined;
  const args =
    typeof params["arguments"] === "object" && params["arguments"] !== null
      ? (params["arguments"] as Args)
      : {};
  const text = (t: string, isError = false) => ({
    jsonrpc: "2.0",
    id: m["id"],
    result: { content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) },
  });
  const [owner, name, ...rest] = str(args["repo"]).split("/");
  const repo =
    owner && name && rest.length === 0
      ? getRepo(ctx.app.db, owner, name)
      : undefined;
  if (repo === undefined)
    return text("not_found: no such public repository (owner/name)", true);
  const filed = fileReport(
    ctx.app,
    repo,
    {
      title: typeof args["title"] === "string" ? args["title"] : "",
      body: typeof args["body"] === "string" ? args["body"] : "",
      page: typeof args["page"] === "string" ? args["page"] : "",
    },
    clientBucket(ctx.request),
  );
  if (!filed.ok) {
    const e = filed.error;
    return text(
      e.error === "not_found"
        ? "not_found: no such public repository (owner/name)"
        : e.error === "rate_limited"
          ? `rate_limited: try again in ${e.retryAfter} seconds`
          : `${e.error}: plain text, a title of 1-${TITLE_MAX} characters, a body of at most ${BODY_MAX}`,
      true,
    );
  }
  return text(
    JSON.stringify({
      id: filed.value.id,
      state: filed.value.state,
      message: REPORT_RECEIVED,
    }),
  );
}

const NOT_HERE = (allow: string): Response =>
  new Response(null, { status: 405, headers: { allow } });

/** Every tool name the forge lists, admin-only ones included. */
export const toolNames = (): string[] => [...TOOLS.map((t) => t.name), REPORT_TOOL.name];

/** What each tool declares about itself, for the test that walks them all. */
export const toolRegistry = () =>
  TOOLS.map((t) => ({
    name: t.name,
    writes: t.writes,
    needsAdminScope: t.needsAdminScope === true,
    readsWithout: t.readsWithout,
    plansOnly: (args: Args) => plansOnly(t, args),
  }));

export function mcpRoutes(router: Router<Handler>): void {
  router.add("POST", "/mcp", async (ctx) => {
    const user = ctx.auth.user;
    // A token or the account's own password; never a cookie.
    if (
      user !== undefined &&
      (ctx.auth.via === "token" || ctx.auth.via === "password")
    ) {
      const message: unknown = await body(ctx.request);
      const reported = reportCall(ctx, message);
      if (reported !== undefined) return json(reported);
      const answer = await rpcOne(ctx, user, message);
      if (answer === undefined) return new Response(null, { status: 202 });
      return json(answer);
    }
    // A stranger may call `report` and nothing else, so their body is read
    // to a hard byte limit and no further.
    const message = await boundedBody(ctx.request, REQUEST_MAX);
    if (message === "too_large")
      return json(
        { error: "too_large", message: `at most ${REQUEST_MAX} bytes without a token` },
        413,
      );
    const reported = reportCall(ctx, message);
    if (reported !== undefined) return json(reported);
    // The refusal keeps the OAuth challenge a client starts from, and names
    // the one thing a stranger can do without signing in.
    return new Response(
      JSON.stringify({
        error: "unauthorized",
        message:
          "send a forge token: Authorization: Bearer <token>. Without one, the tool `report` (tools/call, name \"report\", arguments {repo, title, body?, page?}) files a problem report on a public repository; see /llms.txt",
        report: {
          method: "tools/call",
          name: "report",
          arguments: ["repo", "title", "body", "page"],
        },
      }),
      {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate": `Bearer realm="forge", resource_metadata="${resourceMetadataUrl(ctx.url.origin)}"`,
          link: `<${ctx.url.origin}/llms.txt>; rel="service-doc"; type="text/markdown"`,
        },
      },
    );
  });
  // No server-to-client stream is offered: nothing to hold open, nothing
  // for a proxy to cut.
  router.add("GET", "/mcp", () => NOT_HERE("POST"));
  router.add("DELETE", "/mcp", () => NOT_HERE("POST"));
  // The public API as OpenAPI, for any client that reads it.
  router.add("GET", "/contract/openapi.json", (ctx) =>
    json(openapi(ctx.url.origin, running().version), 200, {
      "cache-control": "public, max-age=300",
    }),
  );
}
