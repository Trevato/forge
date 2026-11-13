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

import { readSource, SOURCE_PREFIX, SOURCE_TEMPLATE } from "./mcp/source_resource.ts";
import { CARD_KINDS, CARD_MIME, CARD_OF_TOOL, CARD_SHELL, CARD_URI, cardFor } from "../web/studio/cards.ts";
import { getRepo } from "../core/repos.ts";
import { scopeAllows } from "../core/tokens.ts";
import type { User } from "../core/users.ts";
import type { Ctx, Handler } from "./context.ts";
import { running } from "../kernel/version.ts";
import { bearerChallenge } from "./oauth.ts";
import { body, boundedBody, json } from "./respond.ts";
import { page, signInHref } from "../web/layout.ts";
import { html } from "../web/html.ts";
import type { Router } from "./router.ts";
import { clientBucket } from "./peer.ts";
import { TOKEN_FREE_TOOLS } from "../core/mcp_card.ts";
import { proofOf } from "./report_filer.ts";
import { fileReport } from "../actions/reports.ts";
import { START_HINT, START_WORDS, startBuilding } from "../actions/start.ts";
import { REPORT_RECEIVED } from "../actions/report_words.ts";
import { BODY_MAX, REQUEST_MAX, TITLE_MAX } from "../core/reports.ts";
import { everydayOf } from "../core/everyday.ts";
import { claimDone, completeWrite, dropWrite, recordWrite } from "../core/conversation_writes.ts";
import { type Args, alreadyDone, notAdminTool, visible, plansOnly, str, REPO_ARG, lean, fenceAnswer, heldWrite, askedFirst, readThrough } from "./mcp/shared.ts";
import { CONVERSATION_BRIEF } from "../crew/conversation_brief.ts";
import { TOOLS } from "./mcp/tools.ts";

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
/** The tools/list entries for these tools, then `report`: what is served, and what docs/MCP.md measures. */
export function toolEntries(tools: readonly (typeof TOOLS)[number][]) {
  return [
    ...tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: lean(t.inputSchema),
      // readOnlyHint defaults to false (MCP tool annotations), so only a
      // read says so: 57 copies of the default were 2 KB of the 40 KB.
      ...(t.writes ? {} : { annotations: { readOnlyHint: true } }),
      ...(CARD_OF_TOOL[t.name] === undefined
        ? {}
        : { _meta: { ui: { resourceUri: CARD_URI(CARD_OF_TOOL[t.name]!) } } }),
    })),
    ...[REPORT_TOOL, START_TOOL].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  ];
}

// One page of tools/list stays within this many bytes of tools; `nextCursor`
// names the rest, so adding a tool never busts one response.
export const TOOLS_PAGE_BYTES = 20_000;

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

/**
 * Said to an admin whose token is short of admin scope (#7650): which tools
 * it hides, and the two deliberate ways to them. Empty for anyone else.
 */
export function hiddenAdminNote(ctx: Ctx, user: User): string {
  if (!user.isAdmin || scopeAllows(ctx.auth.scope ?? "ro", "admin")) return "";
  const hidden = TOOLS.filter((t) => t.needsAdminScope === true).map((t) => t.name);
  return `Hidden from this token, as admin-scope tools: ${hidden.join(", ")}; reach them with an admin-scope token, or as the forge's agent by a confirm the person answers in the conversation.`;
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
      const hidden = hiddenAdminNote(ctx, user);
      return reply({
        protocolVersion: (PROTOCOLS as readonly string[]).includes(asked)
          ? asked
          : PROTOCOLS[0],
        capabilities: { tools: {}, resources: {} },
        serverInfo: server(),
        instructions: `This is a person's forge: their apps, and the crew that builds them. \`tell\` and \`say\` are how they direct it. Keep what you relay short — three sentences and the real options. A tool with \`dryRun\` plans unless it is \`false\`.${adminNote(ctx, user)}${hidden === "" ? "" : ` ${hidden}`}${
          ctx.auth.through === undefined ? "" : ` ${CONVERSATION_BRIEF}`
        }`,
      });
    }
    case "ping":
      return reply({});
    case "tools/list": {
      const all = toolEntries(TOOLS.filter((t) => visible(t, ctx, user)));
      // The cursor is the name of the last tool of the page before, so a tool
      // added between two requests moves nothing.
      const cursor = params["cursor"];
      let from = 0;
      if (cursor !== undefined) {
        const at =
          typeof cursor === "string" ? all.findIndex((t) => t.name === cursor) : -1;
        if (at < 0) return refuse(-32602, "unknown cursor");
        from = at + 1;
      }
      let end = from;
      let bytes = 0;
      while (end < all.length) {
        bytes += Buffer.byteLength(JSON.stringify(all[end]));
        if (end > from && bytes > TOOLS_PAGE_BYTES) break;
        end++;
      }
      const hidden = from === 0 ? hiddenAdminNote(ctx, user) : "";
      return reply({
        tools: all.slice(from, end),
        ...(end < all.length ? { nextCursor: all[end - 1]!.name } : {}),
        ...(hidden === "" ? {} : { _meta: { hidden } }),
      });
    }
    case "resources/list":
      return reply({
        resources: CARD_KINDS.map((k) => ({
          uri: CARD_URI(k),
          name: `forge-${k}-card`,
          mimeType: CARD_MIME,
        })),
      });
    case "resources/templates/list":
      return reply({
        resourceTemplates: [{ uriTemplate: SOURCE_TEMPLATE, name: "forge-source", mimeType: "application/gzip" }],
      });
    case "resources/read": {
      const uri = str(params["uri"]);
      if (uri.startsWith(SOURCE_PREFIX))
        return readSource(ctx, user, uri).then((r) =>
          r.ok ? reply({ contents: [{ uri: r.uri, mimeType: r.mimeType, blob: r.blob }] }) : refuse(-32002, r.message),
        );
      const kind = CARD_KINDS.find((k) => CARD_URI(k) === uri);
      if (kind === undefined) return refuse(-32002, `no resource ${uri}`);
      return reply({
        contents: [{ uri, mimeType: CARD_MIME, text: CARD_SHELL(kind) }],
      });
    }
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params["name"]);
      const args =
        typeof params["arguments"] === "object" && params["arguments"] !== null
          ? (params["arguments"] as Args)
          : {};
      // An admin's tool stays out of an everyday account's list, and a call to
      // it by name is told how to reach it before anything is held or asked (#11818).
      if (tool?.adminOnly === true && !user.isAdmin) return refuse(-32602, notAdminTool(tool.name));
      // Before the scope floor, so an admin tool the forge's agent was
      // steered to is held as a confirm too, not merely refused (#7649), and
      // one the person asked for waits for their yes (#7650).
      const held =
        tool === undefined ? undefined : (askedFirst(ctx, user, tool, args) ?? heldWrite(ctx, user, tool, args));
      if (held !== undefined) return reply(held);
      if (tool === undefined || !visible(tool, ctx, user))
        return refuse(-32602, `no tool named ${String(params["name"])}`);
      if (tool.writes && !plansOnly(tool, args) && !scopeAllows(ctx.auth.scope ?? "ro", "rw"))
        return reply({
          content: [
            { type: "text", text: "forbidden: this token may read, not act" },
          ],
          isError: true,
        });
      // The forge's agent's write is recorded before it runs; one a cut turn
      // already sent is answered with what was done, not done again (#8254).
      const via = ctx.auth.through;
      const writing = via !== undefined && tool.writes && !plansOnly(tool, args);
      if (writing) {
        const done = claimDone(ctx.app.db, via, tool.name, args);
        if (done !== undefined) return reply(alreadyDone(tool.name, done.result));
      }
      const recorded = writing ? recordWrite(ctx.app.db, via, tool.name, args) : undefined;
      readThrough(ctx);
      return Promise.resolve(tool.run(ctx, user, args)).then((ran) => {
        const answer = fenceAnswer(ctx, ran);
        if (recorded !== undefined) {
          // A refused or failed write did nothing, so a resumed turn may send it again.
          if (answer.ok) completeWrite(ctx.app.db, recorded, JSON.stringify(answer.value));
          else dropWrite(ctx.app.db, recorded);
        }
        return reply(
          answer.ok
            ? {
                content: [{ type: "text", text: JSON.stringify(answer.value) }],
                // The forge's agent reads the fenced text, never a card drawn around it.
                ...(ctx.auth.through === undefined
                  ? cardResult(String(params["name"]), answer.value, ctx.url.origin, answer.card)
                  : {}),
              }
            : {
                content: [
                  { type: "text", text: `${answer.error}: ${answer.message}` },
                ],
                isError: true,
              },
        );
      });
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
export const REPORT_TOOL = {
  name: "report",
  /** Its line in /llms.txt's `## MCP tools`; never sent to a client. */
  doc: "`{ repo, title, body?, page?, agent? }`: report a problem in a public repository, the one tool open without a token; it still stores the report, which a person reads first; plain text. With a token the report carries your account; `agent` without one is shown as a claim",
  writes: true,
  description:
    "Report a problem in a public repository, no account needed. Plain text; a person reads it first.",
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
      agent: {
        type: "string",
        maxLength: 64,
        description: "Your name; a claim without a token.",
      },
    },
    required: ["repo", "title"],
  },
} as const;

/**
 * `start`, the other tool open without a token (#10912): an agent with only
 * the forge's URL gets an account, a repository, its app and a token; the
 * same call as `POST /api/v1/start` (`actions/start.ts`).
 */
export const START_TOOL = {
  name: "start",
  /** Its line in /llms.txt's `## MCP tools`; never sent to a client. */
  doc: "`{ name, description? }`: an account, repo, live app and token; push to main to deploy; `claim` is for a person",
  writes: true,
  description: "Start building with no account: an account, a repo, a live app and a token in one call.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", maxLength: 40 },
      description: { type: "string", maxLength: 2000 },
      agent: { type: "string", maxLength: 64 },
      code: { type: "string", maxLength: 100 },
    },
    required: ["name"],
  },
} as const;

/** What a token-free tool does with its call: the JSON-RPC answer. One entry per name in TOKEN_FREE_TOOLS. */
type FreeHandler = (ctx: Ctx, id: unknown, args: Args) => unknown;

/** The gate picks its handler here, so a name listed in TOKEN_FREE_TOOLS without one is caught by a test. */
export const TOKEN_FREE_HANDLERS: Readonly<Record<string, FreeHandler>> = { report: reportAnswer, start: startAnswer };

/** The JSON-RPC answer to a token-free tool call, or undefined for any other message. */
function reportCall(ctx: Ctx, message: unknown): unknown | undefined {
  const m =
    typeof message === "object" && message !== null
      ? (message as Record<string, unknown>)
      : {};
  const params =
    typeof m["params"] === "object" && m["params"] !== null
      ? (m["params"] as Record<string, unknown>)
      : {};
  const name = typeof params["name"] === "string" ? params["name"] : "";
  const handler =
    TOKEN_FREE_TOOLS.includes(name) && Object.hasOwn(TOKEN_FREE_HANDLERS, name)
      ? TOKEN_FREE_HANDLERS[name]
      : undefined;
  if (
    m["jsonrpc"] !== "2.0" ||
    m["method"] !== "tools/call" ||
    handler === undefined ||
    m["id"] === undefined
  )
    return undefined;
  const args =
    typeof params["arguments"] === "object" && params["arguments"] !== null
      ? (params["arguments"] as Args)
      : {};
  return handler(ctx, m["id"], args);
}

function reportAnswer(ctx: Ctx, id: unknown, args: Args): unknown {
  const text = (t: string, isError = false) => ({
    jsonrpc: "2.0",
    id,
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
      agent: typeof args["agent"] === "string" ? args["agent"] : "",
    },
    clientBucket(ctx.request),
    proofOf(ctx),
  );
  if (!filed.ok) {
    const e = filed.error;
    return text(
      e.error === "not_found"
        ? "not_found: no such public repository (owner/name)"
        : e.error === "rate_limited"
          ? `rate_limited: try again in ${e.retryAfter} seconds`
          : `${e.error}: plain text, a title of 1-${TITLE_MAX} characters, a body of at most ${BODY_MAX}, agent a name of letters, digits, . _ -`,
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

async function startAnswer(ctx: Ctx, id: unknown, args: Args): Promise<unknown> {
  const text = (t: string, isError = false) => ({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) },
  });
  const started = await startBuilding(ctx.app, args, clientBucket(ctx.request), ctx.url.origin);
  if (started.ok) return text(JSON.stringify(started.value));
  const e = started.error;
  return text(
    `${e.error}: ${START_WORDS[e.error]}${e.retryAfter === undefined ? "" : ` (try again in ${e.retryAfter} seconds)`} ${START_HINT}`,
    true,
  );
}

const NOT_HERE = (allow: string): Response =>
  new Response(null, { status: 405, headers: { allow } });

/** Every tool name the forge lists, admin-only ones included. */
export const toolNames = (): string[] => [...TOOLS.map((t) => t.name), REPORT_TOOL.name, START_TOOL.name];

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
      if (reported !== undefined) return json(await reported);
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
    if (reported !== undefined) return json(await reported);
    // The refusal keeps the OAuth challenge a client starts from, and names
    // the one thing a stranger can do without signing in.
    return new Response(
      JSON.stringify({
        error: "unauthorized",
        hint: "Send `Authorization: Bearer <token>` with a token you hold, then repeat the call; without one, only the `report` tool answers.",
        message:
          "send a forge token: Authorization: Bearer <token>. Without one, the tool `start` (tools/call, name \"start\", arguments {name, description?, agent?}) makes you an account, a repo and a live app with a token; and the tool `report` (tools/call, name \"report\", arguments {repo, title, body?, page?, agent?}) files a problem report on a public repository; see /llms.txt",
        report: {
          method: "tools/call",
          name: "report",
          arguments: ["repo", "title", "body", "page", "agent"],
        },
      }),
      {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate": bearerChallenge(ctx.url.origin, ctx.request),
          link: `<${ctx.url.origin}/llms.txt>; rel="service-doc"; type="text/markdown"`,
        },
      },
    );
  });
  // No server-to-client stream is offered: nothing to hold open, nothing
  // for a proxy to cut.
  // A browser (Accept names text/html) is told what this is; every other
  // Accept, an MCP client's event-stream included, gets the 405 with a
  // short text/plain explanation of how to connect.
  router.add("GET", "/mcp", (ctx) => {
    const origin = ctx.url.origin;
    if (!(ctx.request.headers.get("accept") ?? "").toLowerCase().includes("text/html"))
      return new Response(
        [
          "This is the forge's MCP endpoint.",
          `It speaks JSON-RPC over POST: send POST ${origin}/mcp with Authorization: Bearer <token>.`,
          `OAuth discovery: ${origin}/.well-known/oauth-protected-resource`,
          "Docs: docs/MCP.md, and /llms.txt for what an agent can do here.",
          "",
        ].join("\n"),
        {
          status: 405,
          headers: { allow: "POST", "content-type": "text/plain; charset=utf-8" },
        },
      );
    const res = page(
      {
        ctx,
        title: "MCP",
        body: html`<div class="page-head"><h1>The forge's MCP server</h1></div>
          <p>This is the forge's MCP server. Connect a harness to POST ${origin}/mcp with a token.</p>
          <ul>
            <li><a href="/llms.txt">/llms.txt</a>: what an agent can do here</li>
            <li><a href="/.well-known/mcp.json">/.well-known/mcp.json</a>: the server's card</li>
            <li>${ctx.auth.user === undefined
              ? html`<a href="${signInHref(ctx)}">Sign in</a> to make a token`
              : html`<a href="/settings/tokens">Settings › Tokens</a>`}</li>
          </ul>`,
      },
      405,
    );
    res.headers.set("allow", "POST");
    return res;
  });
  router.add("DELETE", "/mcp", () => NOT_HERE("POST"));
}
