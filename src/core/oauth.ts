/**
 * OAuth for the MCP: clients (RFC 7591), the authorization request a person
 * consents to, the one-time code, and its PKCE exchange for the same token
 * Settings mints.
 */
import type { Database } from "bun:sqlite";
import { sha256 } from "../kernel/hash.ts";
import { id, secret } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { NONCE_MAX, oidcScopes, recordGrant, signIdToken } from "./oidc.ts";
import { createToken } from "./tokens.ts";
import { getUserById, isActive } from "./users.ts";

export const NAME_MAX = 100;
export const REDIRECTS_MAX = 10;
export const REDIRECT_MAX = 2000;

export interface OAuthClient {
  readonly id: string;
  readonly name: string;
  readonly redirectUris: readonly string[];
  readonly createdAt: string;
}

/** A refused registration: the RFC 7591 error code and a hint. */
export interface Refusal {
  readonly error: "invalid_redirect_uri" | "invalid_client_metadata";
  readonly message: string;
}

const refuse = (
  error: Refusal["error"],
  message: string,
): Result<never, Refusal> => err({ error, message });

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** https anywhere; http only to the machine the client runs on. */
function redirectOk(raw: string): boolean {
  if (raw.length > REDIRECT_MAX) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "")
    return false;
  if (url.protocol === "https:") return url.hostname !== "";
  return url.protocol === "http:" && LOCAL.has(url.hostname);
}

export interface Registration {
  readonly name: string;
  readonly redirectUris: readonly string[];
}

/** Check the untrusted metadata of a registration request. */
export function parseRegistration(
  input: Record<string, unknown>,
): Result<Registration, Refusal> {
  const uris = input["redirect_uris"];
  if (!Array.isArray(uris) || uris.length === 0)
    return refuse("invalid_redirect_uri", "redirect_uris is required");
  if (uris.length > REDIRECTS_MAX)
    return refuse(
      "invalid_redirect_uri",
      `at most ${REDIRECTS_MAX} redirect_uris`,
    );
  for (const uri of uris) {
    if (typeof uri !== "string" || !redirectOk(uri))
      return refuse(
        "invalid_redirect_uri",
        "each redirect_uri must be an https URL (http only for localhost) without credentials or a fragment",
      );
  }
  const rawName = input["client_name"];
  if (rawName !== undefined && typeof rawName !== "string")
    return refuse("invalid_client_metadata", "client_name must be a string");
  const name = (rawName ?? "").trim();
  if (name.length > NAME_MAX)
    return refuse(
      "invalid_client_metadata",
      `client_name is at most ${NAME_MAX} characters`,
    );
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name))
    return refuse("invalid_client_metadata", "client_name has control characters");
  const method = input["token_endpoint_auth_method"];
  if (method !== undefined && method !== "none")
    return refuse(
      "invalid_client_metadata",
      'only token_endpoint_auth_method "none" (a public client with PKCE) is offered',
    );
  return ok({
    name: name === "" ? "MCP client" : name,
    redirectUris: [...new Set(uris as string[])],
  });
}

export function createClient(
  db: Database,
  registration: Registration,
): OAuthClient {
  const client: OAuthClient = {
    id: id(),
    name: registration.name,
    redirectUris: registration.redirectUris,
    createdAt: new Date().toISOString(),
  };
  db.query(
    "INSERT INTO oauth_client (id, name, redirect_uris, created_at) VALUES (?1, ?2, ?3, ?4)",
  ).run(
    client.id,
    client.name,
    JSON.stringify(client.redirectUris),
    client.createdAt,
  );
  return client;
}

export function getClient(db: Database, clientId: string): OAuthClient | null {
  const row = db
    .query<
      { id: string; name: string; redirect_uris: string; created_at: string },
      [string]
    >("SELECT * FROM oauth_client WHERE id = ?1")
    .get(clientId);
  return row === null
    ? null
    : {
        id: row.id,
        name: row.name,
        redirectUris: JSON.parse(row.redirect_uris) as string[],
        createdAt: row.created_at,
      };
}

// ---- the authorization request, the code, and the exchange ----

/** A code is a minute's grace between consent and exchange, no more. */
export const CODE_TTL_MS = 60_000;
export const TOKEN_NAME_MAX = 100;
/** What a person may choose for how long the minted token lives, in seconds. */
export const LIFETIMES: Readonly<Record<string, number | null>> = {
  never: null,
  day: 86_400,
  month: 30 * 86_400,
  year: 365 * 86_400,
};

export type OAuthScope = "ro" | "rw";
export const isOAuthScope = (v: string): v is OAuthScope =>
  v === "ro" || v === "rw";

/** A valid authorization request: the client is real and the redirect is one it registered. */
export interface AuthRequest {
  readonly client: OAuthClient;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly state: string;
  readonly scope: OAuthScope;
  /** `openid` and the OIDC scopes asked with it; empty for a plain OAuth grant. */
  readonly oidcScopes: readonly string[];
  readonly nonce: string;
}

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const STATE_MAX = 1000;

/**
 * Check the untrusted parameters of an authorization request. Anything wrong
 * is a refusal shown to the person, never a redirect: an unregistered
 * redirect must never be sent anywhere, and the rest are the client's bugs.
 * The redirect must equal a registered one exactly — no prefix, no pattern.
 */
export function parseAuthRequest(
  db: Database,
  get: (name: string) => string,
): Result<AuthRequest, string> {
  const client = getClient(db, get("client_id"));
  if (client === null) return err("This client is not registered here.");
  const redirectUri = get("redirect_uri");
  if (!client.redirectUris.includes(redirectUri))
    return err("The redirect address is not one this client registered.");
  if (get("response_type") !== "code")
    return err("Only response_type=code is offered.");
  if (get("code_challenge_method") !== "S256")
    return err("PKCE with code_challenge_method=S256 is required.");
  const challenge = get("code_challenge");
  if (!CHALLENGE.test(challenge))
    return err("The code_challenge is not a base64url SHA-256.");
  const state = get("state");
  if (state.length > STATE_MAX) return err("The state is too long.");
  const asked = get("scope").split(/\s+/).find(isOAuthScope);
  const oidc = oidcScopes(get("scope"));
  const openid = oidc.includes("openid");
  const nonce = get("nonce");
  if (nonce.length > NONCE_MAX) return err("The nonce is too long.");
  return ok({
    client,
    redirectUri,
    challenge,
    state,
    scope: asked ?? "ro",
    oidcScopes: openid ? oidc : [],
    nonce: openid ? nonce : "",
  });
}

/** The name a person gave a token: plain text, bounded, never empty. */
export function tokenName(raw: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return (name === "" ? fallback : name).slice(0, TOKEN_NAME_MAX);
}

/** Where the person goes next: the registered redirect with the answer in its query. */
export function redirectWith(
  redirectUri: string,
  params: Record<string, string>,
): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params))
    if (v !== "") url.searchParams.set(k, v);
  return url.toString();
}

/** Record a person's consent and return the one-time code that proves it. */
export function issueCode(
  db: Database,
  userId: string,
  request: AuthRequest,
  grant: { scope: OAuthScope; name: string; lifetimeS: number | null },
): string {
  const code = secret();
  db.query(
    `INSERT INTO oauth_code (code_hash, client_id, user_id, redirect_uri, challenge, scope, name, lifetime_s, expires_at, oidc_scopes, nonce)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  ).run(
    sha256(code),
    request.client.id,
    userId,
    request.redirectUri,
    request.challenge,
    grant.scope,
    grant.name,
    grant.lifetimeS,
    new Date(Date.now() + CODE_TTL_MS).toISOString(),
    request.oidcScopes.join(" "),
    request.nonce,
  );
  db.query("DELETE FROM oauth_code WHERE expires_at <= ?1").run(
    new Date().toISOString(),
  );
  return code;
}

export interface Minted {
  readonly token: string;
  readonly scope: OAuthScope;
  /** Seconds the token lives, or null for one that does not expire. */
  readonly expiresIn: number | null;
  /** The signed id_token, when the grant was an OpenID one. */
  readonly idToken?: string;
}

/**
 * Exchange a code for a token. The code is spent before anything else is
 * decided, so a replay, a wrong verifier or a wrong redirect all find it
 * gone: one try per code. Every refusal is `invalid_grant`.
 */
export async function redeemCode(
  db: Database,
  dataDir: string,
  input: {
    code: string;
    clientId: string;
    redirectUri: string;
    verifier: string;
    issuer: string;
  },
): Promise<Result<Minted, "invalid_grant">> {
  const row = db
    .query<
      {
        client_id: string;
        user_id: string;
        redirect_uri: string;
        challenge: string;
        scope: OAuthScope;
        name: string;
        lifetime_s: number | null;
        expires_at: string;
        oidc_scopes: string;
        nonce: string;
      },
      [string]
    >("DELETE FROM oauth_code WHERE code_hash = ?1 RETURNING *")
    .get(sha256(input.code));
  if (row === null) return err("invalid_grant");
  if (Date.parse(row.expires_at) <= Date.now()) return err("invalid_grant");
  if (row.client_id !== input.clientId) return err("invalid_grant");
  if (row.redirect_uri !== input.redirectUri) return err("invalid_grant");
  if (!VERIFIER.test(input.verifier)) return err("invalid_grant");
  const digest = new Bun.CryptoHasher("sha256")
    .update(input.verifier)
    .digest("base64url");
  if (digest !== row.challenge) return err("invalid_grant");
  const user = getUserById(db, row.user_id);
  if (user === null || user === undefined || !isActive(user)) return err("invalid_grant");
  const minted = createToken(db, row.user_id, row.name, row.scope, {
    ...(row.lifetime_s === null
      ? {}
      : { expiresAt: new Date(Date.now() + row.lifetime_s * 1000).toISOString() }),
  });
  const scopes = row.oidc_scopes === "" ? [] : row.oidc_scopes.split(" ");
  if (scopes.length === 0)
    return ok({ token: minted.token, scope: row.scope, expiresIn: row.lifetime_s });
  recordGrant(db, minted.id, scopes);
  const idToken = await signIdToken(db, dataDir, {
    issuer: input.issuer,
    clientId: row.client_id,
    user,
    scopes,
    nonce: row.nonce,
  });
  return ok({ token: minted.token, scope: row.scope, expiresIn: row.lifetime_s, idToken });
}
