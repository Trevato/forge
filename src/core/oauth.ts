/**
 * OAuth clients: who may later ask a person for a token. Step one stores the
 * registration (RFC 7591) and nothing else — no grant, no code, no token.
 */
import type { Database } from "bun:sqlite";
import { id } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";

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
