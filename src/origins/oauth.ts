/**
 * Connecting an origin without pasting a token.
 *
 * Two flows, because two problems. GitHub's **device authorization grant**
 * (RFC 8628) is the one that works when the thing asking has no browser: the
 * forge shows a short code, you type it into a phone, the forge polls. That
 * is exactly the SSH/terminal case, and it needs no client secret — only a
 * client id, which is public. Forgejo and Gitea explicitly do **not**
 * implement the device grant, so they get the **authorization code flow with
 * PKCE** (RFC 7636, S256): the browser goes there and comes back to
 * `/settings/origins/callback` with a code we exchange.
 *
 * What makes it safe, and each of these has a test:
 *
 * - `state` is random, hashed at rest, bound to the user who started the
 *   flow, expiring, single-use, and compared in constant time. A callback
 *   carrying someone else's state is refused as if it did not exist.
 * - PKCE means an intercepted authorization code is worthless without the
 *   verifier, which never leaves this forge.
 * - The redirect URI is fixed by the forge and sent on both legs; a
 *   provider that honours it cannot be talked into redirecting elsewhere.
 * - Refresh-token rotation is written before the new access token is used.
 *   A rotation we fail to persist is a permanently dead origin, so the
 *   ordering is not a nicety.
 * - Every failure path stores a reason, never a token; `detail` is rendered
 *   to users and is checked for exactly that.
 */

import type { Database } from "bun:sqlite";
import { sha256 } from "../kernel/hash.ts";
import { id, secret as randomSecret } from "../kernel/id.ts";
import { open, seal } from "../kernel/secret.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import type { AuthKind, OriginKind } from "./types.ts";

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 64 * 1024;
/** A connect the user never finishes is garbage after this long. */
export const FLOW_TTL_MS = 10 * 60 * 1000;

export type OAuthError =
  | "no_app"
  | "unsupported_flow"
  | "unreachable"
  | "denied"
  | "expired"
  | "invalid_grant"
  | "invalid_response"
  | "slow_down"
  | "pending";

/**
 * The refusals no retry can fix. `invalid_grant` is the documented one;
 * Forgejo answers `unauthorized_client` when a rotated refresh token is
 * replayed, which is the same situation wearing a different name. Both mean
 * the credential is spent and a human has to reconnect.
 */
const TERMINAL = new Set(["invalid_grant", "unauthorized_client"]);

export const isTerminal = (code: string): boolean => TERMINAL.has(code);

/**
 * Which OAuth flow a forge actually implements. GitHub runs the device
 * grant, which needs no client secret and works from a terminal. Forgejo and
 * Gitea do not implement it at all — their token endpoints accept only
 * `authorization_code` and `refresh_token` — so they get the code flow with
 * PKCE, and the browser can be on a different machine entirely.
 */
export function flowFor(kind: OriginKind): FlowKind {
  return kind === "github" ? "device" : "code";
}

export interface OAuthFailure {
  readonly error: OAuthError;
  /** Safe to show a user and safe to log: never contains a secret. */
  readonly message: string;
}

export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** ISO 8601, or null when the provider issues non-expiring tokens. */
  readonly expiresAt: string | null;
  readonly scope: string;
}

export interface AppRegistration {
  readonly kind: OriginKind;
  readonly apiUrl: string;
  readonly webUrl: string;
  readonly clientId: string;
  /** Empty for a public client — PKCE carries the proof instead. */
  readonly clientSecret: string;
  /** `forge` when the origin is another forge, else absent or "". */
  readonly software?: string;
}

// ---- the OAuth endpoints, per forge ----

/**
 * Both GitHub and Forgejo hang their OAuth endpoints off the *web* origin,
 * not the API base — a distinction that matters on GitHub Enterprise, where
 * the API lives under `/api/v3` and the login endpoints do not.
 */
export function endpoints(app: AppRegistration): {
  device: string;
  authorize: string;
  token: string;
} {
  const web = app.webUrl.replace(/\/+$/, "");
  // Another forge keeps its OAuth at `/oauth/*` (RFC 8414 paths it also
  // publishes); it has no device grant.
  if (app.software === "forge")
    return { device: "", authorize: `${web}/oauth/authorize`, token: `${web}/oauth/token` };
  return {
    device: `${web}/login/device/code`,
    authorize: `${web}/login/oauth/authorize`,
    token: `${web}/login/oauth/access_token`,
  };
}

// ---- device authorization grant (GitHub) ----

export interface DeviceStart {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly intervalSecs: number;
  readonly expiresInSecs: number;
}

export async function startDevice(
  app: AppRegistration,
  scope: string,
): Promise<Result<DeviceStart, OAuthFailure>> {
  const body = await postForm(endpoints(app).device, {
    client_id: app.clientId,
    scope,
  });
  if (!body.ok) return body;

  const deviceCode = str(body.value, "device_code");
  const userCode = str(body.value, "user_code");
  const uri =
    str(body.value, "verification_uri_complete") ||
    str(body.value, "verification_uri");
  if (deviceCode === "" || userCode === "" || uri === "") {
    return err(fault(body.value, "the origin did not start a device flow"));
  }
  return ok({
    deviceCode,
    userCode,
    verificationUri: uri,
    intervalSecs: Math.max(num(body.value, "interval") || 5, 1),
    expiresInSecs: num(body.value, "expires_in") || 900,
  });
}

/**
 * One poll. `pending` and `slow_down` are the normal states of a flow whose
 * human has not finished yet — the worker treats them as "call again",
 * widening the interval on `slow_down` exactly as the spec asks.
 */
export async function pollDevice(
  app: AppRegistration,
  deviceCode: string,
): Promise<Result<TokenSet, OAuthFailure>> {
  const body = await postForm(endpoints(app).token, {
    client_id: app.clientId,
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    ...(app.clientSecret === "" ? {} : { client_secret: app.clientSecret }),
  });
  if (!body.ok) return body;

  const problem = str(body.value, "error");
  if (problem !== "") return err(deviceProblem(problem, body.value));
  return tokenSetFrom(body.value);
}

function deviceProblem(
  code: string,
  body: Record<string, unknown>,
): OAuthFailure {
  switch (code) {
    case "authorization_pending":
      return { error: "pending", message: "waiting for you to approve it" };
    case "slow_down":
      return { error: "slow_down", message: "polling too fast; backing off" };
    case "expired_token":
      return { error: "expired", message: "the code expired; start again" };
    case "access_denied":
      return { error: "denied", message: "the request was declined" };
    default:
      // An unknown client id answers `{"error":"Not Found"}` here, which is in
      // no table anywhere; anything unrecognised must stop the poller.
      return {
        error: "invalid_grant",
        message: `the origin refused: ${safeDetail(code, body)}`,
      };
  }
}

// ---- authorization code + PKCE (Forgejo, Gitea) ----

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

/** S256 only. `plain` exists in the spec and has no reason to exist here. */
export function pkce(): PkcePair {
  const verifier = `${randomSecret()}${randomSecret()}`.slice(0, 96);
  return { verifier, challenge: base64url(sha256Bytes(verifier)) };
}

export function authorizeUrl(
  app: AppRegistration,
  input: {
    state: string;
    challenge: string;
    redirectUri: string;
    scope: string;
  },
): string {
  const url = new URL(endpoints(app).authorize);
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.scope !== "") url.searchParams.set("scope", input.scope);
  return url.toString();
}

export async function exchangeCode(
  app: AppRegistration,
  input: { code: string; verifier: string; redirectUri: string },
): Promise<Result<TokenSet, OAuthFailure>> {
  const body = await postForm(endpoints(app).token, {
    client_id: app.clientId,
    ...(app.clientSecret === "" ? {} : { client_secret: app.clientSecret }),
    code: input.code,
    grant_type: "authorization_code",
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
  });
  if (!body.ok) return body;
  const problem = str(body.value, "error");
  if (problem !== "")
    return err({
      error: isTerminal(problem) ? "invalid_grant" : "invalid_response",
      message: `the origin refused the code: ${safeDetail(problem, body.value)}`,
    });
  return tokenSetFrom(body.value);
}

/**
 * Trade a refresh token for a new access token. A rotating provider hands
 * back a NEW refresh token here and invalidates the old one, which is why
 * the caller must persist the result before using the access token.
 */
export async function refresh(
  app: AppRegistration,
  refreshToken: string,
): Promise<Result<TokenSet, OAuthFailure>> {
  const body = await postForm(endpoints(app).token, {
    client_id: app.clientId,
    ...(app.clientSecret === "" ? {} : { client_secret: app.clientSecret }),
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (!body.ok) return body;
  const problem = str(body.value, "error");
  if (problem !== "")
    return err({
      error: isTerminal(problem) ? "invalid_grant" : "invalid_response",
      message: `the origin would not refresh: ${safeDetail(problem, body.value)}`,
    });
  return tokenSetFrom(body.value);
}

function tokenSetFrom(
  body: Record<string, unknown>,
): Result<TokenSet, OAuthFailure> {
  const accessToken = str(body, "access_token");
  if (accessToken === "")
    return err(fault(body, "the origin issued no access token"));
  const expiresIn = num(body, "expires_in");
  return ok({
    accessToken,
    refreshToken: str(body, "refresh_token"),
    expiresAt:
      expiresIn > 0
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : null,
    scope: str(body, "scope"),
  });
}

/**
 * Ask the origin to forget a grant, where it will. GitHub's revoke endpoint
 * authenticates with the *application's* credentials, so it is only reachable
 * when the operator configured a client secret; a public-client install can
 * only destroy its local copy and say so. Forgejo exposes no revoke endpoint
 * at all. Either way the local secret is gone — this is best-effort tidying
 * upstream, never the thing disconnect depends on.
 */
export async function revokeGrant(
  app: AppRegistration,
  accessToken: string,
): Promise<Result<void, OAuthFailure>> {
  if (app.kind !== "github" || app.clientSecret === "")
    return err({
      error: "unsupported_flow",
      message: "this origin cannot revoke a grant from here",
    });
  const url = `${app.apiUrl.replace(/\/+$/, "")}/applications/${encodeURIComponent(app.clientId)}/grant`;
  try {
    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "forge",
        authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`,
      },
      body: JSON.stringify({ access_token: accessToken }),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status >= 200 && response.status < 400) return ok();
    return err({
      error: "invalid_response",
      message: `the origin answered ${response.status}`,
    });
  } catch (error) {
    return err({ error: "unreachable", message: String(error) });
  }
}

// ---- flow records ----

export type FlowKind = "device" | "code";

export interface FlowRow {
  readonly id: string;
  readonly userId: string;
  /** The `/go/<code>` half of the short link. Empty on pre-migration rows. */
  readonly shortCode: string;
  readonly flow: FlowKind;
  readonly kind: OriginKind;
  readonly apiUrl: string;
  readonly webUrl: string;
  readonly clientId: string;
  /** `forge` when the origin is another forge, learned when the connect began. */
  readonly software: string;
  readonly redirectUri: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly intervalSecs: number;
  readonly status: "pending" | "done" | "failed";
  readonly detail: string;
  readonly originId: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastPollAt: string | null;
}

interface RawFlow {
  id: string;
  user_id: string;
  short_code: string | null;
  target_enc: string;
  flow: FlowKind;
  kind: OriginKind;
  api_url: string;
  web_url: string;
  client_id: string;
  software: string;
  client_secret_enc: string;
  state_hash: string | null;
  verifier_enc: string;
  redirect_uri: string;
  device_code_enc: string;
  user_code: string;
  verification_uri: string;
  interval_secs: number;
  status: "pending" | "done" | "failed";
  detail: string;
  origin_id: string | null;
  created_at: string;
  expires_at: string;
  last_poll_at: string | null;
}

const toFlow = (row: RawFlow): FlowRow => ({
  id: row.id,
  userId: row.user_id,
  shortCode: row.short_code ?? "",
  flow: row.flow,
  kind: row.kind,
  apiUrl: row.api_url,
  webUrl: row.web_url,
  clientId: row.client_id,
  software: row.software,
  redirectUri: row.redirect_uri,
  userCode: row.user_code,
  verificationUri: row.verification_uri,
  intervalSecs: row.interval_secs,
  status: row.status,
  detail: row.detail,
  originId: row.origin_id,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  lastPollAt: row.last_poll_at,
});

/**
 * The alphabet a person retypes off a screen: Crockford base32 without the
 * letters that read as digits. Ten characters is fifty bits — nothing an
 * attacker enumerates inside a ten-minute window, and short enough that the
 * whole link fits a version 1–3 QR code and one line of a terminal.
 */
const SHORT_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function newShortCode(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let out = "";
  // One byte per character, taken modulo 32. The bias that leaves (0–7 are a
  // shade likelier than 8–31) costs a fraction of a bit out of fifty, which
  // is worth less than the rejection loop it would take to remove.
  for (const byte of bytes) out += SHORT_ALPHABET[byte % 32];
  return out;
}

export interface NewFlow {
  userId: string;
  flow: FlowKind;
  app: AppRegistration;
  /** Where the short link sends a browser: verification page, or authorize. */
  target?: string;
  /** Device flow: the secret half we poll with. */
  deviceCode?: string;
  userCode?: string;
  verificationUri?: string;
  intervalSecs?: number;
  /** Code flow: the random state we will match the callback against. */
  state?: string;
  verifier?: string;
  redirectUri?: string;
  ttlMs?: number;
}

export function createFlow(
  db: Database,
  dataDir: string,
  input: NewFlow,
): FlowRow {
  const flowId = id();
  db.query(
    `INSERT INTO oauth_flow
       (id, user_id, flow, kind, api_url, web_url, client_id, client_secret_enc,
        state_hash, verifier_enc, redirect_uri, device_code_enc, user_code,
        verification_uri, interval_secs, expires_at, short_code, target_enc, software)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
             ?17, ?18, ?19)`,
  ).run(
    flowId,
    input.userId,
    input.flow,
    input.app.kind,
    input.app.apiUrl,
    input.app.webUrl,
    input.app.clientId,
    input.app.clientSecret === ""
      ? ""
      : seal(dataDir, input.app.clientSecret, flowId),
    // The state is stored only as a digest: a database read cannot hand an
    // attacker a state they could complete.
    input.state === undefined ? null : sha256(input.state),
    input.verifier === undefined ? "" : seal(dataDir, input.verifier, flowId),
    input.redirectUri ?? "",
    input.deviceCode === undefined
      ? ""
      : seal(dataDir, input.deviceCode, flowId),
    input.userCode ?? "",
    input.verificationUri ?? "",
    input.intervalSecs ?? 5,
    new Date(Date.now() + (input.ttlMs ?? FLOW_TTL_MS)).toISOString(),
    newShortCode(),
    // Sealed for the same reason the state is hashed: a code flow's target
    // carries the `state`, and nothing readable in this table may complete a
    // connect on its own.
    input.target === undefined || input.target === ""
      ? ""
      : seal(dataDir, input.target, flowId),
    input.app.software ?? "",
  );
  return getFlow(db, flowId)!;
}

/**
 * Resolve a short link. Only a live flow answers: pending, unexpired, and
 * with a target it was created with. A code that was never issued, one whose
 * flow expired, and one already claimed are all the same answer, because the
 * difference is only interesting to somebody guessing codes.
 */
export function targetForShortCode(
  db: Database,
  dataDir: string,
  code: string,
  now = new Date(),
): string | undefined {
  if (code === "") return undefined;
  const row = db
    .query<
      RawFlow,
      [string]
    >("SELECT * FROM oauth_flow WHERE short_code = ?1 AND status = 'pending'")
    .get(code);
  if (!row || row.target_enc === "") return undefined;
  if (Date.parse(row.expires_at) <= now.getTime()) return undefined;
  const opened = open(dataDir, row.target_enc, row.id);
  return opened.ok ? opened.value : undefined;
}

/**
 * Where a pending flow sends the person — the authorize URL a code flow was
 * started with, or a device flow's verification page — as it was sealed on
 * the row when the flow began. Expiry is the caller's to judge (a page says
 * "expired"; a short link just stops answering).
 */
export function flowTarget(
  db: Database,
  dataDir: string,
  flowId: string,
): string | undefined {
  const row = db
    .query<RawFlow, [string]>(
      "SELECT * FROM oauth_flow WHERE id = ?1 AND status = 'pending'",
    )
    .get(flowId);
  if (!row || row.target_enc === "") return undefined;
  const opened = open(dataDir, row.target_enc, row.id);
  return opened.ok ? opened.value : undefined;
}

export function getFlow(db: Database, flowId: string): FlowRow | undefined {
  const row = db
    .query<RawFlow, [string]>("SELECT * FROM oauth_flow WHERE id = ?1")
    .get(flowId);
  return row ? toFlow(row) : undefined;
}

/** A flow as its starter sees it; anyone else gets nothing at all. */
export function getFlowFor(
  db: Database,
  userId: string,
  flowId: string,
): FlowRow | undefined {
  const flow = getFlow(db, flowId);
  return flow && flow.userId === userId ? flow : undefined;
}

/**
 * Claim a pending code flow by its `state`, atomically and once. The state
 * is cleared in the same statement that finds it, so a replayed callback —
 * an attacker's, or a browser's double-submit — finds nothing. Anything
 * gentler leaves a window in which two exchanges race for one code.
 *
 * The lookup is by SHA-256 digest, which is also what makes it timing-safe:
 * the comparison happens on a hash, so what a timing difference could leak
 * is a prefix of the digest, and inverting that is the hash's whole job. The
 * raw state is never stored, so a database read hands nobody a usable one.
 */
export function claimFlowByState(
  db: Database,
  state: string,
  userId: string,
): FlowRow | undefined {
  if (state === "") return undefined;
  const row = db
    .query<RawFlow, [string, string]>(
      `UPDATE oauth_flow SET state_hash = NULL
       WHERE state_hash = ?1 AND user_id = ?2 AND status = 'pending'
       RETURNING *`,
    )
    .get(sha256(state), userId);
  return row ? toFlow(row) : undefined;
}

export function flowSecrets(
  db: Database,
  dataDir: string,
  flowId: string,
): { deviceCode: string; verifier: string; clientSecret: string } | undefined {
  const row = db
    .query<RawFlow, [string]>("SELECT * FROM oauth_flow WHERE id = ?1")
    .get(flowId);
  if (!row) return undefined;
  const unseal = (value: string): string => {
    if (value === "") return "";
    const opened = open(dataDir, value, flowId);
    return opened.ok ? opened.value : "";
  };
  return {
    deviceCode: unseal(row.device_code_enc),
    verifier: unseal(row.verifier_enc),
    clientSecret: unseal(row.client_secret_enc),
  };
}

/**
 * Retire a flow. A finished flow keeps its outcome (so a poller can read it
 * once) but loses every secret it held — the code, the verifier and the
 * client secret are blanked in the same statement.
 */
export function finishFlow(
  db: Database,
  flowId: string,
  outcome: {
    status: "done" | "failed";
    detail: string;
    originId?: string | null;
  },
): void {
  db.query(
    `UPDATE oauth_flow
     SET status = ?1, detail = ?2, origin_id = ?3,
         device_code_enc = '', verifier_enc = '', client_secret_enc = '',
         state_hash = NULL, target_enc = '', short_code = NULL
     WHERE id = ?4`,
  ).run(outcome.status, outcome.detail, outcome.originId ?? null, flowId);
}

export function touchFlow(
  db: Database,
  flowId: string,
  intervalSecs?: number,
): void {
  db.query(
    `UPDATE oauth_flow SET last_poll_at = ?1,
       interval_secs = CASE WHEN ?2 > 0 THEN ?2 ELSE interval_secs END
     WHERE id = ?3`,
  ).run(new Date().toISOString(), intervalSecs ?? 0, flowId);
}

/** Drop finished and expired flows. Cheap, and it takes secrets with it. */
export function pruneFlows(db: Database, now = new Date()): number {
  return db
    .query(
      `DELETE FROM oauth_flow
       WHERE expires_at < ?1 OR (status != 'pending' AND created_at < ?2)`,
    )
    .run(
      now.toISOString(),
      new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    ).changes;
}

export const flowExpired = (flow: FlowRow, now = new Date()): boolean =>
  Date.parse(flow.expiresAt) <= now.getTime();

// ---- registered apps ----

export interface AppRow {
  readonly id: string;
  readonly userId: string;
  readonly kind: OriginKind;
  readonly apiUrl: string;
  readonly webUrl: string;
  readonly clientId: string;
  readonly hasSecret: boolean;
  readonly createdAt: string;
}

interface RawApp {
  id: string;
  user_id: string;
  kind: OriginKind;
  api_url: string;
  web_url: string;
  client_id: string;
  client_secret_enc: string;
  created_at: string;
}

const toApp = (row: RawApp): AppRow => ({
  id: row.id,
  userId: row.user_id,
  kind: row.kind,
  apiUrl: row.api_url,
  webUrl: row.web_url,
  clientId: row.client_id,
  hasSecret: row.client_secret_enc !== "",
  createdAt: row.created_at,
});

export function saveApp(
  db: Database,
  dataDir: string,
  input: {
    userId: string;
    kind: OriginKind;
    apiUrl: string;
    webUrl: string;
    clientId: string;
    clientSecret?: string;
  },
): AppRow {
  const existing = db
    .query<
      RawApp,
      [string, string]
    >("SELECT * FROM origin_app WHERE user_id = ?1 AND api_url = ?2")
    .get(input.userId, input.apiUrl);
  const appId = existing?.id ?? id();
  const sealed =
    input.clientSecret === undefined || input.clientSecret === ""
      ? ""
      : seal(dataDir, input.clientSecret, appId);
  if (existing) {
    db.query(
      `UPDATE origin_app SET kind = ?1, web_url = ?2, client_id = ?3,
         client_secret_enc = CASE WHEN ?4 = '' THEN client_secret_enc ELSE ?4 END
       WHERE id = ?5`,
    ).run(input.kind, input.webUrl, input.clientId, sealed, appId);
  } else {
    db.query(
      `INSERT INTO origin_app (id, user_id, kind, api_url, web_url, client_id, client_secret_enc)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).run(
      appId,
      input.userId,
      input.kind,
      input.apiUrl,
      input.webUrl,
      input.clientId,
      sealed,
    );
  }
  return toApp(
    db
      .query<RawApp, [string]>("SELECT * FROM origin_app WHERE id = ?1")
      .get(appId)!,
  );
}

export function listApps(db: Database, userId: string): AppRow[] {
  return db
    .query<
      RawApp,
      [string]
    >("SELECT * FROM origin_app WHERE user_id = ?1 ORDER BY api_url")
    .all(userId)
    .map(toApp);
}

export function deleteApp(
  db: Database,
  userId: string,
  appId: string,
): boolean {
  return (
    db
      .query("DELETE FROM origin_app WHERE id = ?1 AND user_id = ?2")
      .run(appId, userId).changes > 0
  );
}

/**
 * The app registration to use for one instance: the user's own if they
 * registered one, otherwise the operator's for github.com. GitHub is the
 * only forge where one client id can serve every user of a forge — every
 * Forgejo instance needs its own registration, which is why the user pastes
 * a client id once per host, or the operator registers the host once for
 * everyone (`FORGE_ORIGIN_CLIENT_ID`).
 */
export function appFor(
  db: Database,
  dataDir: string,
  userId: string,
  target: { kind: OriginKind; apiUrl: string; webUrl: string; software?: string },
  env: Record<string, string | undefined> = process.env,
): Result<AppRegistration, "no_app"> {
  const row = db
    .query<
      RawApp,
      [string, string]
    >("SELECT * FROM origin_app WHERE user_id = ?1 AND api_url = ?2")
    .get(userId, target.apiUrl);
  if (row) {
    const opened =
      row.client_secret_enc === ""
        ? ""
        : (() => {
            const value = open(dataDir, row.client_secret_enc, row.id);
            return value.ok ? value.value : "";
          })();
    return ok({
      kind: row.kind,
      apiUrl: row.api_url,
      webUrl: row.web_url,
      clientId: row.client_id,
      clientSecret: opened,
      software: target.software ?? "",
    });
  }

  // The operator can register a host once, for everyone on this forge.
  const registered = operatorClientId(env, target.apiUrl);
  if (registered !== undefined) {
    return ok({
      kind: target.kind,
      apiUrl: target.apiUrl,
      webUrl: target.webUrl,
      clientId: registered,
      clientSecret: "",
      software: target.software ?? "",
    });
  }

  const clientId = (env.FORGE_GITHUB_CLIENT_ID ?? "").trim();
  if (target.kind === "github" && clientId !== "") {
    return ok({
      kind: "github",
      apiUrl: target.apiUrl,
      webUrl: target.webUrl,
      clientId,
      clientSecret: (env.FORGE_GITHUB_CLIENT_SECRET ?? "").trim(),
    });
  }
  return err("no_app");
}

/**
 * `FORGE_ORIGIN_CLIENT_ID` is `host=client id`, comma-separated: the
 * operator registering an origin's OAuth application once, for every user of
 * this forge, instead of each person pasting the id. A public client (PKCE)
 * needs no secret. Matched on the origin's hostname.
 */
export function operatorClientId(
  env: Record<string, string | undefined>,
  apiUrl: string,
): string | undefined {
  const raw = (env.FORGE_ORIGIN_CLIENT_ID ?? "").trim();
  if (raw === "") return undefined;
  let host: string;
  try {
    host = new URL(apiUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  for (const entry of raw.split(",")) {
    const at = entry.indexOf("=");
    if (at === -1) continue;
    const name = entry.slice(0, at).trim().toLowerCase();
    const id = entry.slice(at + 1).trim();
    if (name === host && id !== "") return id;
  }
  return undefined;
}

// ---- scopes we ask for ----

/**
 * The narrowest scopes that let forge do what it offers. On Forgejo this is
 * exactly the set a *repository-scoped* token may hold, so a user can grant
 * access to one repo and nothing else.
 */
export function scopesFor(
  kind: OriginKind,
  authKind: AuthKind = "oauth",
  software = "",
): string {
  void authKind;
  // Another forge offers `ro` and `rw`; bringing code across needs only `ro`,
  // and the approval page there shows what is asked.
  if (software === "forge") return "ro";
  if (kind === "github") return "repo read:org";
  return "read:repository write:repository read:issue write:issue read:user";
}

// ---- dynamic client registration (RFC 7591), forge to forge ----

/**
 * Register this forge at another forge as a public client, once, so nobody
 * copies a client id by hand. The other forge answers `POST /oauth/register`
 * with a `client_id`; PKCE stands in for a secret.
 */
export async function registerClient(
  webUrl: string,
  input: { redirectUri: string; name: string },
): Promise<Result<string, OAuthFailure>> {
  let response: Response;
  try {
    response = await fetch(`${webUrl.replace(/\/+$/, "")}/oauth/register`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": "forge" },
      body: JSON.stringify({
        client_name: input.name,
        redirect_uris: [input.redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return err({ error: "unreachable", message: String(error) });
  }
  if (response.status !== 201 && response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    return err({
      error: "no_app",
      message: `the origin refused to register this forge (${response.status})`,
    });
  }
  const buffer = await readCapped(response);
  if (buffer === undefined)
    return err({ error: "invalid_response", message: "answer too large" });
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(buffer));
    const clientId =
      typeof parsed === "object" && parsed !== null
        ? str(parsed as Record<string, unknown>, "client_id")
        : "";
    if (clientId === "")
      return err({
        error: "invalid_response",
        message: "the origin issued no client id",
      });
    return ok(clientId);
  } catch {
    return err({ error: "invalid_response", message: "the origin's registration answer was not JSON" });
  }
}

// ---- transport ----

/**
 * The body of an answer, read from the stream and abandoned the moment it
 * passes MAX_BYTES: the bytes actually read are the cap, not a header the
 * host chose. Undefined when the host sent more.
 */
async function readCapped(response: Response): Promise<Uint8Array | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * A form POST to a token endpoint, answered as JSON. Both forges will
 * happily answer `application/x-www-form-urlencoded` bodies with a URL-
 * encoded body of their own unless asked otherwise, so `Accept` is not
 * optional here.
 */
async function postForm(
  url: string,
  fields: Record<string, string>,
): Promise<Result<Record<string, unknown>, OAuthFailure>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "forge",
      },
      body: new URLSearchParams(fields).toString(),
      // A token endpoint that redirects is a token endpoint we do not follow:
      // the body carries a client secret.
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return err({ error: "unreachable", message: String(error) });
  }
  if (response.status >= 300 && response.status < 400)
    return err({ error: "unreachable", message: "the origin redirected us" });

  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES)
    return err({ error: "invalid_response", message: "answer too large" });
  const buffer = await readCapped(response);
  if (buffer === undefined)
    return err({ error: "invalid_response", message: "answer too large" });
  const text = new TextDecoder().decode(buffer);

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null)
      return err({ error: "invalid_response", message: "not a JSON object" });
    return ok(parsed as Record<string, unknown>);
  } catch {
    // Some instances answer form-encoded regardless of Accept.
    const params = new URLSearchParams(text);
    if (params.has("access_token") || params.has("error")) {
      return ok(Object.fromEntries(params.entries()));
    }
    return err({
      error: "invalid_response",
      message: `the origin answered ${response.status} with no usable body`,
    });
  }
}

// ---- readers ----

const str = (body: Record<string, unknown>, key: string): string =>
  typeof body[key] === "string" ? (body[key] as string) : "";

const num = (body: Record<string, unknown>, key: string): number => {
  const raw = body[key];
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : 0;
};

/**
 * A message safe to store and render. The provider's own description is
 * used when it gave one, and only ever the description — never the whole
 * body, which on a successful-but-unexpected answer would contain a token.
 */
function safeDetail(code: string, body: Record<string, unknown>): string {
  const described = str(body, "error_description");
  const text = described !== "" ? described : code;
  return text.replace(/\s+/g, " ").slice(0, 200);
}

const fault = (
  body: Record<string, unknown>,
  message: string,
): OAuthFailure => ({
  error: "invalid_response",
  message: `${message}${
    str(body, "error") === ""
      ? ""
      : ` (${safeDetail(str(body, "error"), body)})`
  }`,
});

// ---- PKCE primitives ----

function sha256Bytes(text: string): Uint8Array {
  const hex = sha256(text);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

const base64url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64url");

/** A fresh, unguessable `state`. */
export const newState = (): string => randomSecret();
