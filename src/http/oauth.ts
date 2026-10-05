/**
 * OAuth discovery for the MCP, step one: the two well-known documents and
 * dynamic client registration. The authorize page and the token endpoint
 * the documents name come next; until then a client can find the forge and
 * register, and still signs in with a bearer token.
 *
 * Registration takes no cookie and grants nothing, so there is no ambient
 * authority for a cross-site page to ride; it is limited per address instead.
 */
import type { App } from "../app.ts";
import { createClient, parseRegistration } from "../core/oauth.ts";
import { RateLimiter } from "../core/ratelimit.ts";
import type { Handler } from "./context.ts";
import { clientBucket } from "./peer.ts";
import { body, json } from "./respond.ts";
import type { Router } from "./router.ts";

/** Registrations per address per minute. */
const REGISTER_PER_MINUTE = 10;
/** A registration is a few hundred bytes; refuse anything past this. */
const BODY_MAX = 16 * 1024;

const limiters = new WeakMap<App, RateLimiter>();
const limiterOf = (app: App): RateLimiter => {
  let limiter = limiters.get(app);
  if (limiter === undefined) {
    limiter = new RateLimiter({
      perMinute: REGISTER_PER_MINUTE,
      adminPerMinute: REGISTER_PER_MINUTE,
      enabled: true,
    });
    limiters.set(app, limiter);
  }
  return limiter;
};

export const resourceMetadataUrl = (origin: string): string =>
  `${origin}/.well-known/oauth-protected-resource`;

const open = { "access-control-allow-origin": "*" };
const docHeaders = { ...open, "cache-control": "public, max-age=300" };

export function oauthRoutes(router: Router<Handler>): void {
  router.add("GET", "/.well-known/oauth-protected-resource", (ctx) =>
    json(
      {
        resource: `${ctx.url.origin}/mcp`,
        authorization_servers: [ctx.url.origin],
        scopes_supported: ["ro", "rw"],
        bearer_methods_supported: ["header"],
      },
      200,
      docHeaders,
    ),
  );
  router.add("GET", "/.well-known/oauth-authorization-server", (ctx) =>
    json(
      {
        issuer: ctx.url.origin,
        authorization_endpoint: `${ctx.url.origin}/oauth/authorize`,
        token_endpoint: `${ctx.url.origin}/oauth/token`,
        registration_endpoint: `${ctx.url.origin}/oauth/register`,
        scopes_supported: ["ro", "rw"],
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      },
      200,
      docHeaders,
    ),
  );
  router.add("POST", "/oauth/register", async (ctx) => {
    const verdict = limiterOf(ctx.app).take(clientBucket(ctx.request), "ro");
    if (!verdict.allowed)
      return json(
        {
          error: "rate_limited",
          message: `too many registrations — retry in ${verdict.retryAfter}s`,
        },
        429,
        { ...open, "retry-after": String(verdict.retryAfter), "cache-control": "no-store" },
      );
    const declared = Number(ctx.request.headers.get("content-length") ?? 0);
    const raw = declared > BODY_MAX ? {} : await body(ctx.request);
    const parsed = parseRegistration(raw);
    if (!parsed.ok)
      return json(parsed.error, 400, { ...open, "cache-control": "no-store" });
    const client = createClient(ctx.app.db, parsed.value);
    return json(
      {
        client_id: client.id,
        client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
        client_name: client.name,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      },
      201,
      { ...open, "cache-control": "no-store" },
    );
  });
}
