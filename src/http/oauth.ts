/**
 * OAuth for the MCP: the two well-known documents, dynamic client
 * registration, the authorize page (a person's session and consent) and the
 * token endpoint (a one-time code and its PKCE verifier for a forge token).
 *
 * Registration and the token endpoint take no cookie, so there is no ambient
 * authority for a cross-site page to ride; registration is limited per
 * address instead. The authorize page is session-bound and same-origin
 * checked on its POST.
 */
import type { App } from "../app.ts";
import { createClient, OAUTH_SCOPES, parseRegistration, redeemCode } from "../core/oauth.ts";
import { jwks, OIDC_SCOPES, userinfo } from "../core/oidc.ts";
import { RateLimiter } from "../core/ratelimit.ts";
import type { Handler } from "./context.ts";
import { clientBucket } from "./peer.ts";
import { readBounded } from "./limits.ts";
import { boundedBody, json } from "./respond.ts";
import type { Router } from "./router.ts";
import { authorizePage, authorizeSubmit } from "../web/pages/oauth.ts";

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

/**
 * The one challenge a refused client learns from; /mcp and the API send it.
 * It names the scopes, and says `invalid_token` (RFC 6750 §3) when a bearer
 * was sent and refused, so "sign in" and "re-authorize" are told apart.
 */
export const bearerChallenge = (origin: string, request?: Request): string => {
  const sent = /^Bearer\s+\S/i.test(request?.headers.get("authorization") ?? "");
  return (
    `Bearer realm="forge", resource_metadata="${resourceMetadataUrl(origin)}", scope="${OAUTH_SCOPES.join(" ")}"` +
    (sent ? `, error="invalid_token"` : "")
  );
};

const open = { "access-control-allow-origin": "*" };
const docHeaders = { ...open, "cache-control": "public, max-age=300" };

const noStore = { ...open, "cache-control": "no-store", pragma: "no-cache" };
const grantError = (error: string, status = 400) =>
  json({ error }, status, noStore);

/** The token endpoint's parameters: a form (RFC 6749) or, leniently, JSON. */
async function tokenParams(
  request: Request,
): Promise<((n: string) => string) | null> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const raw = await boundedBody(request, BODY_MAX);
    if (raw === "too_large") return null;
    return (n) => (typeof raw[n] === "string" ? (raw[n] as string) : "");
  }
  const bytes = await readBounded(request, BODY_MAX);
  if (bytes === "too_large") return null;
  const form = new URLSearchParams(new TextDecoder().decode(bytes));
  return (n) => form.get(n) ?? "";
}

export function oauthRoutes(router: Router<Handler>): void {
  router.add("GET", "/oauth/authorize", authorizePage);
  router.add("POST", "/oauth/authorize", authorizeSubmit);
  router.add("POST", "/oauth/token", async (ctx) => {
    const get = await tokenParams(ctx.request);
    if (get === null) return grantError("invalid_request", 413);
    if (get("grant_type") !== "authorization_code")
      return grantError("unsupported_grant_type");
    const minted = await redeemCode(ctx.app.db, ctx.app.config.dataDir, {
      code: get("code"),
      clientId: get("client_id"),
      redirectUri: get("redirect_uri"),
      verifier: get("code_verifier"),
      issuer: ctx.url.origin,
    });
    if (!minted.ok) return grantError(minted.error);
    return json(
      {
        ...(minted.value.token === undefined ? {} : { access_token: minted.value.token }),
        token_type: "Bearer",
        ...(minted.value.token === undefined ? {} : { scope: minted.value.scope }),
        ...(minted.value.idToken === undefined ? {} : { id_token: minted.value.idToken }),
        ...(minted.value.expiresIn === null
          ? {}
          : { expires_in: minted.value.expiresIn }),
      },
      200,
      noStore,
    );
  });
  router.add("GET", "/oauth/jwks", async (ctx) =>
    json(await jwks(ctx.app.db, ctx.app.config.dataDir), 200, docHeaders),
  );
  const userinfoRoute: Handler = (ctx) => {
    const header = ctx.request.headers.get("authorization") ?? "";
    const presented = /^Bearer (\S+)$/i.exec(header)?.[1];
    const claims = presented === undefined ? null : userinfo(ctx.app.db, presented);
    if (claims === null || !claims.ok)
      return json({ error: "invalid_token" }, 401, {
        ...noStore,
        "www-authenticate": 'Bearer error="invalid_token"',
      });
    return json(claims.value, 200, noStore);
  };
  router.add("GET", "/oauth/userinfo", userinfoRoute);
  router.add("POST", "/oauth/userinfo", userinfoRoute);
  router.add("GET", "/.well-known/openid-configuration", (ctx) =>
    json(
      {
        issuer: ctx.url.origin,
        authorization_endpoint: `${ctx.url.origin}/oauth/authorize`,
        token_endpoint: `${ctx.url.origin}/oauth/token`,
        userinfo_endpoint: `${ctx.url.origin}/oauth/userinfo`,
        jwks_uri: `${ctx.url.origin}/oauth/jwks`,
        registration_endpoint: `${ctx.url.origin}/oauth/register`,
        scopes_supported: [...OIDC_SCOPES, ...OAUTH_SCOPES],
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["ES256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        claims_supported: ["sub", "iss", "aud", "exp", "iat", "nonce", "name", "preferred_username", "email", "email_verified"],
      },
      200,
      docHeaders,
    ),
  );
  router.add("GET", "/.well-known/oauth-protected-resource", (ctx) =>
    json(
      {
        resource: `${ctx.url.origin}/mcp`,
        resource_name: "forge",
        resource_documentation: `${ctx.url.origin}/llms.txt`,
        authorization_servers: [ctx.url.origin],
        scopes_supported: [...OAUTH_SCOPES],
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
        scopes_supported: [...OAUTH_SCOPES],
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
    const raw = await boundedBody(ctx.request, BODY_MAX);
    if (raw === "too_large")
      return json({ error: "invalid_client_metadata", error_description: `at most ${BODY_MAX} bytes` }, 413, { ...open, "cache-control": "no-store" });
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
