/**
 * OpenID Connect on top of the OAuth grant: the signing keys (ES256, kept in
 * the database, rotated), the id_token a code exchange returns beside the
 * access token, and the claims `/oauth/userinfo` answers with. There is no
 * second credential: the id_token is a statement about the same grant that
 * minted the ro/rw token.
 */
import type { Database } from "bun:sqlite";
import { sha256 } from "../kernel/hash.ts";
import { id } from "../kernel/id.ts";
import { open, seal } from "../kernel/secret.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { verifyToken } from "./tokens.ts";
import { getUserById, type User } from "./users.ts";

/** A key signs for this long, then a new one takes over. */
export const ROTATE_MS = 30 * 86_400_000;
/** An id_token is good for an hour. */
export const ID_TOKEN_TTL_S = 3600;
/** The scopes that mean OIDC; `openid` is the one that turns it on. */
export const OIDC_SCOPES = ["openid", "profile", "email"] as const;
export type OidcScope = (typeof OIDC_SCOPES)[number];
export const NONCE_MAX = 256;

const ALG = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const b64json = (v: unknown): string => b64(new TextEncoder().encode(JSON.stringify(v)));

interface KeyRow {
  kid: string;
  private_jwk: string;
  public_jwk: string;
  created_at: string;
}

/** The scopes of a request that are OIDC's, in a fixed order, deduplicated. */
export function oidcScopes(scope: string): OidcScope[] {
  const asked = new Set(scope.split(/\s+/));
  return OIDC_SCOPES.filter((s) => asked.has(s));
}

/** The private key is sealed with the data dir's key, bound to its kid. */
async function generate(db: Database, dataDir: string, now: number, onlyIfStale = false): Promise<KeyRow> {
  const pair = (await crypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  const kid = id();
  const row: KeyRow = {
    kid,
    private_jwk: seal(
      dataDir,
      JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)),
      kid,
    ),
    public_jwk: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    created_at: new Date(now).toISOString(),
  };
  // Check and insert in one transaction: of two requests racing past the
  // rotation mark, the second finds the first one's key and uses it.
  return db.transaction((): KeyRow => {
    if (onlyIfStale) {
      const current = newest(db);
      if (current !== null && now - Date.parse(current.created_at) < ROTATE_MS)
        return current;
    }
    db.query(
      "INSERT INTO oidc_key (kid, private_jwk, public_jwk, created_at) VALUES (?1, ?2, ?3, ?4)",
    ).run(row.kid, row.private_jwk, row.public_jwk, row.created_at);
    // Only the current key and the one before it are kept.
    db.query(
      "DELETE FROM oidc_key WHERE kid NOT IN (SELECT kid FROM oidc_key ORDER BY created_at DESC, rowid DESC LIMIT 2)",
    ).run();
    return row;
  })();
}

const newest = (db: Database): KeyRow | null =>
  db
    .query<KeyRow, []>("SELECT * FROM oidc_key ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get();

/** The key that signs now; a new one is made when none exists or it is old. */
export async function signingKey(db: Database, dataDir: string, now = Date.now()): Promise<KeyRow> {
  const current = newest(db);
  if (current !== null && now - Date.parse(current.created_at) < ROTATE_MS)
    return current;
  return generate(db, dataDir, now, true);
}

/** Make a new current key now; the one it replaces stays published. */
export const rotateKeys = (db: Database, dataDir: string, now = Date.now()): Promise<KeyRow> =>
  generate(db, dataDir, now);

/** The JWK Set: the current public key and the previous one. */
export async function jwks(db: Database, dataDir: string): Promise<{ keys: Record<string, unknown>[] }> {
  await signingKey(db, dataDir);
  const rows = db
    .query<KeyRow, []>("SELECT * FROM oidc_key ORDER BY created_at DESC, rowid DESC LIMIT 2")
    .all();
  return {
    keys: rows.map((r) => ({
      ...(JSON.parse(r.public_jwk) as Record<string, unknown>),
      kid: r.kid,
      use: "sig",
      alg: "ES256",
    })),
  };
}

/** Claims about a person for the scopes they consented to. */
export function claimsFor(user: User, scopes: readonly string[]): Record<string, unknown> {
  return {
    sub: user.id,
    ...(scopes.includes("profile")
      ? {
          preferred_username: user.username,
          name: user.displayName === "" ? user.username : user.displayName,
        }
      : {}),
    ...(scopes.includes("email") ? { email: user.email, email_verified: false } : {}),
  };
}

export async function signIdToken(
  db: Database,
  dataDir: string,
  input: {
    issuer: string;
    clientId: string;
    user: User;
    scopes: readonly string[];
    nonce: string;
  },
  now = Date.now(),
): Promise<string> {
  const key = await signingKey(db, dataDir, now);
  const iat = Math.floor(now / 1000);
  const head = b64json({ alg: "ES256", typ: "JWT", kid: key.kid });
  const body = b64json({
    iss: input.issuer,
    aud: input.clientId,
    iat,
    exp: iat + ID_TOKEN_TTL_S,
    ...(input.nonce === "" ? {} : { nonce: input.nonce }),
    ...claimsFor(input.user, input.scopes),
  });
  const opened = open(dataDir, key.private_jwk, key.kid);
  if (!opened.ok) throw new Error("oidc signing key cannot be opened");
  const priv = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(opened.value) as never,
    ALG,
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(SIGN, priv, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64(new Uint8Array(sig))}`;
}

/** Check a JWT against the published keys, its expiry and its issuer. */
export async function verifyIdToken(
  db: Database,
  dataDir: string,
  jwt: string,
  expect: { issuer: string; clientId: string },
  now = Date.now(),
): Promise<Result<Record<string, unknown>, "invalid_token">> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return err("invalid_token");
  try {
    const head = JSON.parse(Buffer.from(parts[0]!, "base64url").toString()) as Record<string, unknown>;
    if (head["alg"] !== "ES256") return err("invalid_token");
    const jwk = (await jwks(db, dataDir)).keys.find((k) => k["kid"] === head["kid"]);
    if (jwk === undefined) return err("invalid_token");
    const pub = await crypto.subtle.importKey("jwk", jwk as never, ALG, false, ["verify"]);
    const good = await crypto.subtle.verify(
      SIGN,
      pub,
      Buffer.from(parts[2]!, "base64url"),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!good) return err("invalid_token");
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as Record<string, unknown>;
    if (claims["iss"] !== expect.issuer || claims["aud"] !== expect.clientId)
      return err("invalid_token");
    if (typeof claims["exp"] !== "number" || claims["exp"] * 1000 <= now)
      return err("invalid_token");
    return ok(claims);
  } catch {
    return err("invalid_token");
  }
}

/** Remember that an access token came from an OpenID grant, and for which scopes. */
export function recordGrant(db: Database, tokenId: string, scopes: readonly string[]): void {
  db.query("INSERT INTO oidc_token (token_id, scopes) VALUES (?1, ?2)").run(
    tokenId,
    scopes.join(" "),
  );
}

/** The claims for a bearer token, if it came from an OpenID grant. */
export function userinfo(
  db: Database,
  presented: string,
): Result<Record<string, unknown>, "invalid_token"> {
  const verified = verifyToken(db, presented);
  if (!verified.ok) return err("invalid_token");
  const row = db
    .query<{ scopes: string; user_id: string }, [string]>(
      `SELECT o.scopes, t.user_id FROM oidc_token o JOIN token t ON t.id = o.token_id
        WHERE t.token_hash = ?1`,
    )
    .get(sha256(presented));
  if (row === null) return err("invalid_token");
  const user = getUserById(db, row.user_id);
  if (user === null || user === undefined) return err("invalid_token");
  return ok(claimsFor(user, row.scopes.split(" ")));
}
