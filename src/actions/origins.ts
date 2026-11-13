/**
 * Origin actions: connecting an account, picking repositories, mirroring
 * them, syncing, pinning — and the write-through path every mutation on a
 * mirrored repo travels.
 *
 * Two access rules run through the whole file and are worth stating plainly.
 *
 * **An origin belongs to one person.** Every lookup goes through
 * `getOriginFor(db, userId, id)`, so another user's connected account is
 * `not_found` — not `forbidden`, which would confirm it exists (invariant 9).
 *
 * **Only the origin's owner writes through it.** A repo writer who is not
 * the connecting user gets `origin_owner_only`. Their comment would otherwise
 * be posted upstream under someone else's identity, with someone else's
 * token, and appear on the origin as if that person had written it. Sharing a
 * mirror's write access across a team is a real thing to want; it needs an
 * explicit per-repo opt-in and a delegation model, and that is deliberately
 * not v1.
 */

import { NOT_A_MEMBER } from "../core/roles.ts";
import { requireAbility } from "./roles.ts";
import { requireVerified } from "./verify.ts";
import type { App } from "../app.ts";
import {
  cacheOriginRepos,
  clearCursor,
  createOrigin,
  deleteOrigin,
  detachedMirror,
  findOrigin,
  getOriginById,
  getOriginFor,
  hostOf,
  siteOf,
  linkRepoToOrigin,
  listDetachedMirrors,
  listMirrors,
  listOriginRepos,
  mirrorOfRemote,
  listOrigins,
  markNeedsReauth,
  originForRepo,
  rememberOriginRepo,
  renewOrigin,
  sealedSecrets,
  setCursor,
  type Origin,
  type OriginRepoRow,
} from "../core/origins.ts";
import {
  listPins,
  pin as addPin,
  unpin as dropPin,
  type Pin,
} from "../core/pins.ts";
import { RateLimiter, type RateLimits } from "../core/ratelimit.ts";
import { canAdmin, getRepoById, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { repoDir } from "../git/repos.ts";
import { bustOrigin } from "../view/cache.ts";
import { readAhead } from "../origins/ahead.ts";
import { discover, type UnreachableBecause } from "../origins/discover.ts";
import {
  lastGuardTry,
  noteGuardPassed,
  providerForOrigin,
  recheckOrigin,
  type Recheck,
} from "../origins/credential.ts";
import { safeRemoteUrl } from "../origins/credentials.ts";
import { configureMirror, mirrorRemoteUrl } from "../origins/git-mirror.ts";
import { getJob, type MirrorJob } from "../origins/jobs.ts";
import { startMirror } from "../origins/mirror.ts";
import {
  appFor,
  authorizeUrl,
  claimFlowByState,
  createFlow,
  deleteApp,
  exchangeCode,
  finishFlow,
  flowExpired,
  flowFor,
  flowSecrets,
  getFlowFor,
  listApps,
  newState,
  pkce,
  pollDevice,
  revokeGrant,
  saveApp,
  scopesFor,
  registerClient,
  startDevice,
  touchFlow,
  type AppRow,
  type FlowRow,
} from "../origins/oauth.ts";
import {
  BROKERED,
  VIA_PARENT,
  brokerOffers,
  deviceGrant,
  forgetOffers,
  FAILURE_WORDS,
  offerFor,
  redeemCode,
  startUrl,
} from "../origins/broker.ts";
import type { BrokerFailure } from "../spawn/origin_broker_wire.ts";
import { checkCredential, hostnameOf, type GuardRefusal } from "../origins/operator.ts";
import { forgetProvider, providerFor } from "../origins/providers/index.ts";
import { forgetTokenReach } from "../origins/token-reach.ts";
import { scopeWords } from "../origins/providers/http.ts";
import {
  requestSyncNow,
  syncOrigin,
  type SyncReport,
} from "../origins/sync.ts";
import { open } from "../kernel/secret.ts";
import {
  staticCredential,
  type OriginKind,
  type RemoteRepo,
  type RepoGroup,
} from "../origins/types.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import {
  requireRepoAdmin,
  requireUser,
  requireWriter,
  type AccessError,
} from "./access.ts";

/** The words a connect carries when the account is already connected. */
export const ORIGIN_ALREADY_CONNECTED = "that account is already connected";

// ---- abuse control ----

/**
 * Connect attempts per person: ten in a sliding minute. Connecting makes
 * the forge fetch a host the caller named, so an unbounded connect endpoint
 * is an outbound request amplifier; this is the cap that stops it being one.
 * A minute is enough to stop hammering, and short enough that a few honest
 * failures (a mistyped host, a token that lacked a scope) never lock anyone
 * out: the 429 says "wait a minute" and `retryAfter` says sixty. The same
 * limiter as the API's (`core/ratelimit.ts`): in memory on purpose, a
 * refused attempt not counted, and belonging to the forge it limits, so a
 * fresh `createApp` starts fresh.
 */
export const CONNECT_LIMITS: RateLimits = {
  perMinute: 10,
  adminPerMinute: 10,
  enabled: true,
  windowMs: 60_000,
};
const connects = new WeakMap<App, RateLimiter>();

function tooManyAttempts(app: App, userId: string): boolean {
  let limiter = connects.get(app);
  if (limiter === undefined) {
    limiter = new RateLimiter(CONNECT_LIMITS);
    connects.set(app, limiter);
  }
  return !limiter.take(userId, "rw").allowed;
}

// ---- connecting ----

export type ConnectError =
  | "unauthorized"
  | "unknown_host"
  | "private_host"
  | "unreachable"
  | "bad_token"
  | "already_connected"
  | "rate_limited"
  | "not_member";

export interface ConnectInput {
  /** What the user typed: `github`, `codeberg.org`, `https://git.example`. */
  host: string;
  /** Set when the user picked a forge explicitly (GitHub Enterprise). */
  kind?: OriginKind;
  token: string;
  /** Connect read-only: every write-through on its mirrors refuses. */
  readOnly?: boolean;
}

/**
 * Connect with a pasted token — the fallback path, and the only one that
 * works with no OAuth application registered anywhere. The token is
 * validated against the origin before it is stored, and `login` comes from
 * the origin's answer rather than anything the user typed. On a host the
 * operator guards, the account behind it is checked too (`checkCredential`)
 * and a refusal stores nothing: it comes back as a `GuardRefusal`, with the
 * sentence to show.
 */
export async function connectOrigin(
  app: App,
  actor: User | undefined,
  input: ConnectInput,
): Promise<Result<Connected, ConnectError | GuardRefusal | ScopeRefusal | UnreachableBecause>> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  // A credential held for an account, and a mirror it can make: not for a guest.
  if (!requireAbility(app, user.value, "make_it_yours").ok) return err("not_member");
  if (tooManyAttempts(app, user.value.id)) return err("rate_limited");
  if (input.token.trim() === "") return err("bad_token");

  const found = await discover(
    input.kind === undefined
      ? { host: input.host }
      : { host: input.host, kind: input.kind },
  );
  if (!found.ok) return err(found.error);

  const provider = providerFor(
    staticCredential({
      kind: found.value.kind,
      apiUrl: found.value.apiUrl,
      webUrl: found.value.webUrl,
      software: softwareOf(found.value.software),
      token: input.token.trim(),
    }),
  );
  const identity = await provider.whoami();
  if (!identity.ok) {
    // A token the origin knows but finds too narrow is not a bad token: say
    // which scope it lacks, in the words of the page that makes tokens.
    const missing = identity.error.missingScopes ?? [];
    if (missing.length > 0)
      return err({
        error: "missing_scopes",
        message: `This token is missing ${scopeWords(missing)}. ${TOKEN_NEEDS}`,
        scopes: missing,
      });
    return err(
      identity.error.error === "unreachable" ? "unreachable" : "bad_token",
    );
  }
  const guard = await checkCredential(provider, identity.value);
  if (!guard.ok) return err(guard.error);

  const stored = storeOrigin(app, user.value, {
    kind: found.value.kind,
    apiUrl: found.value.apiUrl,
    webUrl: found.value.webUrl,
    login: identity.value.login,
    token: input.token.trim(),
    authKind: "pat",
    software: softwareOf(found.value.software),
    ...(input.readOnly === true ? { readOnly: true } : {}),
  });
  if (!stored.ok) return stored;
  if (guard.value.checked) noteGuardPassed(app, stored.value.id);
  return ok({
    ...stored.value,
    reattached: await afterConnect(
      app,
      user.value,
      stored.value,
      guard.value.listed,
    ),
  });
}

/** What `discover` named the software, as the column that keeps it: another forge or nothing. */
const softwareOf = (named: string): string => (named.startsWith("forge ") ? "forge" : "");

export type ReplaceTokenError =
  | "unauthorized"
  | "not_found"
  | "rate_limited"
  | "bad_token"
  | "unreachable"
  | "other_account"
  | GuardRefusal["error"];

/**
 * Put a new pasted token on an origin that is already connected — one that
 * sees more, or one that still works. The row keeps its id, so its mirrors
 * and pins stay attached; the token must answer for the same account, or
 * it is a different origin and Connect is the way to add it. The picker's
 * rows are listed again at once with what the new token sees.
 */
export async function replaceOriginToken(
  app: App,
  actor: User | undefined,
  originId: string,
  token: string,
): Promise<Result<Origin, ReplaceTokenError>> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const origin = getOriginFor(app.db, user.value.id, originId);
  if (!origin) return err("not_found");
  if (tooManyAttempts(app, user.value.id)) return err("rate_limited");
  const secret = token.trim();
  if (secret === "") return err("bad_token");

  const provider = providerFor(
    staticCredential({
      kind: origin.kind,
      apiUrl: origin.apiUrl,
      webUrl: origin.webUrl,
      software: origin.software,
      token: secret,
    }),
  );
  const identity = await provider.whoami();
  if (!identity.ok)
    return err(
      identity.error.error === "unreachable" ? "unreachable" : "bad_token",
    );
  if (identity.value.login.toLowerCase() !== origin.login.toLowerCase())
    return err("other_account");
  // A new token is a new credential: on a guarded host it passes the same
  // check a connect does, and a refusal leaves the old token as it was.
  const guard = await checkCredential(provider, identity.value);
  if (!guard.ok) return err(guard.error.error);

  renewOrigin(app.db, app.config.dataDir, origin.id, {
    token: secret,
    authKind: "pat",
  });
  forgetProvider({ dataDir: app.config.dataDir, originId: origin.id });
  forgetTokenReach(app.config.dataDir, origin.id);
  if (guard.value.checked) noteGuardPassed(app, origin.id);
  app.bus.append({
    kind: "origin.connected",
    actorId: user.value.id,
    payload: {
      originId: origin.id,
      host: origin.webUrl,
      login: origin.login,
      authKind: "pat",
      renewed: true,
    },
  });
  const renewed = getOriginById(app.db, origin.id)!;
  await listRemoteRepos(app, user.value, origin.id, true);
  return ok(renewed);
}

/** What a token for a Forgejo origin needs, in the token page's words. */
export const TOKEN_NEEDS =
  "A token for this forge needs User: Read, Repository: Read and write, and Issue: Read and write.";

/** A token the origin refused for a scope it lacks: which, by name. */
export interface ScopeRefusal {
  readonly error: "missing_scopes";
  readonly message: string;
  /** In the origin's words: `read:user`. */
  readonly scopes: readonly string[];
}

/** A refused connect as a stable code and the words to show for it. */
export function connectRefusal(
  error: ConnectError | GuardRefusal | ScopeRefusal | UnreachableBecause,
): { code: string; message: string | undefined } {
  return typeof error === "string"
    ? { code: error, message: undefined }
    : { code: error.error, message: error.message };
}

/** A connected origin, and the frozen mirrors connecting it brought back. */
export type Connected = Origin & {
  readonly reattached: readonly Reattachment[];
};

function storeOrigin(
  app: App,
  user: User,
  input: {
    kind: OriginKind;
    apiUrl: string;
    webUrl: string;
    login: string;
    token: string;
    authKind: "pat" | "oauth";
    refreshToken?: string;
    expiresAt?: string | null;
    software?: string;
    readOnly?: boolean;
  },
): Result<Origin, "already_connected"> {
  // Connecting an account whose credential died is re-authorizing it: the
  // row keeps its id, so its mirrors never detach and nothing freezes
  // longer than the dead token already made it. A healthy account is still
  // `already_connected` — a second token for it is a mistake, not a fix.
  const existing = findOrigin(app.db, user.id, input.apiUrl, input.login);
  if (existing?.needsReauth) {
    renewOrigin(app.db, app.config.dataDir, existing.id, {
      token: input.token,
      authKind: input.authKind,
      ...(input.refreshToken === undefined
        ? {}
        : { refreshToken: input.refreshToken }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    });
    forgetProvider({ dataDir: app.config.dataDir, originId: existing.id });
    forgetTokenReach(app.config.dataDir, existing.id);
    app.bus.append({
      kind: "origin.connected",
      actorId: user.id,
      payload: {
        originId: existing.id,
        host: existing.webUrl,
        login: existing.login,
        authKind: input.authKind,
        renewed: true,
      },
    });
    return ok(getOriginById(app.db, existing.id)!);
  }
  const created = createOrigin(app.db, app.config.dataDir, {
    userId: user.id,
    kind: input.kind,
    apiUrl: input.apiUrl,
    webUrl: input.webUrl,
    login: input.login,
    token: input.token,
    authKind: input.authKind,
    ...(input.refreshToken === undefined
      ? {}
      : { refreshToken: input.refreshToken }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    ...(input.software === undefined ? {} : { software: input.software }),
    ...(input.readOnly === true ? { readOnly: true } : {}),
  });
  if (!created.ok) return created;
  // The payload names the host and the login and nothing else: an audit
  // trail that cannot itself become a leak.
  app.bus.append({
    kind: "origin.connected",
    actorId: user.id,
    payload: {
      originId: created.value.id,
      host: created.value.webUrl,
      login: created.value.login,
      authKind: input.authKind,
    },
  });
  return created;
}

/**
 * Disconnect. The upstream grant is revoked where the provider allows it
 * (GitHub, and only when a client secret is configured — the revoke endpoint
 * authenticates as the application); everywhere else the honest thing is to
 * destroy our copy and tell the user where to revoke it themselves. Either
 * way the local secret is gone when this returns.
 */
export async function disconnectOrigin(
  app: App,
  actor: User | undefined,
  originId: string,
): Promise<Result<{ revokedUpstream: boolean }, "unauthorized" | "not_found">> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const origin = getOriginFor(app.db, user.value.id, originId);
  if (!origin) return err("not_found");

  let revokedUpstream = false;
  if (origin.authKind === "oauth") {
    const registration = appFor(
      app.db,
      app.config.dataDir,
      user.value.id,
      origin,
    );
    const sealed = sealedSecrets(app.db, origin.id);
    if (registration.ok && sealed) {
      const token = open(app.config.dataDir, sealed.token, origin.id);
      if (token.ok) {
        const revoked = await revokeGrant(registration.value, token.value);
        revokedUpstream = revoked.ok;
      }
    }
  }

  deleteOrigin(app.db, user.value.id, originId);
  forgetProvider({ dataDir: app.config.dataDir, originId });
  forgetTokenReach(app.config.dataDir, originId);
  app.bus.append({
    kind: "origin.disconnected",
    actorId: user.value.id,
    payload: { originId, host: origin.webUrl, revokedUpstream },
  });
  return ok({ revokedUpstream });
}

export function listUserOrigins(app: App, actor: User): Origin[] {
  return listOrigins(app.db, actor.id);
}

// ---- checking again ----

/** How soon a person may ask for another check of the same origin. */
const CHECK_AGAIN_MS = 60_000;

/**
 * "Check again": the operator guard on one of the actor's origins, now
 * (`recheckOrigin`). The way out of paused writes without waiting for the
 * sweep — and, like it, refused outright when the account fails the guard.
 * Once a minute per origin at most: it is a walk of the origin's API.
 */
export async function checkOriginAgain(
  app: App,
  actor: User | undefined,
  originId: string,
): Promise<Result<Recheck, "unauthorized" | "not_found" | "too_soon">> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const origin = getOriginFor(app.db, user.value.id, originId);
  if (!origin) return err("not_found");
  const last = lastGuardTry(app, origin.id);
  if (last !== undefined && Date.now() - Date.parse(last) < CHECK_AGAIN_MS)
    return err("too_soon");
  const provider = providerForOrigin(app, origin);
  if (!provider.ok) return ok("refused");
  return ok(await recheckOrigin(app, origin, provider.value, { pauseMs: 250 }));
}

// ---- OAuth ----

export type OAuthStartError =
  | "not_member"
  | "unauthorized"
  | "unknown_host"
  | "private_host"
  | "unreachable"
  | "no_app"
  | "rate_limited"
  | "provider_refused";

export interface OAuthStart {
  readonly flowId: string;
  readonly flow: "device" | "code";
  /** Device flow: the code the human types into the other device. */
  readonly userCode: string;
  /** Where the human goes — a verification page, or the authorize URL. */
  readonly url: string;
  /** The `/go/<code>` half of the short link that redirects to `url`. */
  readonly shortCode: string;
  readonly intervalSecs: number;
  readonly expiresAt: string;
  /** The parent forge brokers this sign-in: the browser goes straight to `url`, the parent's. */
  readonly brokered?: true;
}

/**
 * Begin an OAuth connect. Which flow you get is a property of the forge, not
 * a choice: GitHub implements the device grant (which is what makes this
 * work over SSH, with no browser on the server), and Forgejo and Gitea
 * implement only the authorization code flow, so they get that with PKCE.
 */
export async function startOAuthConnect(
  app: App,
  actor: User | undefined,
  input: { host: string; kind?: OriginKind; redirectUri?: string; returnQuery?: string },
): Promise<Result<OAuthStart, { error: OAuthStartError; message: string; kind?: OriginKind }>> {
  const user = requireUser(actor);
  if (!user.ok) return err({ error: "unauthorized", message: "sign in first" });
  if (!requireAbility(app, user.value, "make_it_yours").ok)
    return err({ error: "not_member", message: NOT_A_MEMBER });
  if (tooManyAttempts(app, user.value.id))
    return err({ error: "rate_limited", message: "too many connect attempts; wait a minute" });

  const found = await discover(
    input.kind === undefined
      ? { host: input.host }
      : { host: input.host, kind: input.kind },
  );
  if (!found.ok)
    return err({
      error: typeof found.error === "string" ? found.error : found.error.error,
      message: typeof found.error === "string" ? `cannot identify ${input.host}` : found.error.message,
    });

  const software = softwareOf(found.value.software);
  const target = {
    kind: found.value.kind,
    apiUrl: found.value.apiUrl,
    webUrl: found.value.webUrl,
    software,
  };
  let registration = appFor(app.db, app.config.dataDir, user.value.id, target);
  if (!registration.ok && software === "forge" && (input.redirectUri ?? "") !== "") {
    // Another forge registers us itself: no client id to copy.
    const made = await registerClient(target.webUrl, {
      redirectUri: input.redirectUri!,
      name: `forge at ${new URL(input.redirectUri!).host}`,
    });
    if (!made.ok)
      return err({ error: "provider_refused", message: made.error.message });
    saveApp(app.db, app.config.dataDir, {
      userId: user.value.id,
      kind: target.kind,
      apiUrl: target.apiUrl,
      webUrl: target.webUrl,
      clientId: made.value,
    });
    registration = appFor(app.db, app.config.dataDir, user.value.id, target);
  }
  if (!registration.ok) {
    // A hosted forge holds no application of its own: its parent may run the sign-in for it.
    const brokered = await startBrokered(app, user.value, target, input.returnQuery ?? "");
    if (brokered !== undefined) return brokered;
    return err({
      error: "no_app",
      kind: found.value.kind,
      message:
        found.value.kind === "github"
          ? "no GitHub OAuth app is configured; paste a token instead"
          : "register an OAuth application on this instance first",
    });
  }
  const scope = scopesFor(found.value.kind, "oauth", software);

  if (flowFor(found.value.kind) === "device") {
    const started = await startDevice(registration.value, scope);
    if (!started.ok)
      return err({ error: "provider_refused", message: started.error.message });
    const flow = createFlow(app.db, app.config.dataDir, {
      userId: user.value.id,
      flow: "device",
      app: registration.value,
      deviceCode: started.value.deviceCode,
      userCode: started.value.userCode,
      verificationUri: started.value.verificationUri,
      target: started.value.verificationUri,
      intervalSecs: started.value.intervalSecs,
      ttlMs: started.value.expiresInSecs * 1000,
    });
    return ok({
      flowId: flow.id,
      flow: "device",
      userCode: started.value.userCode,
      url: started.value.verificationUri,
      shortCode: flow.shortCode,
      intervalSecs: started.value.intervalSecs,
      expiresAt: flow.expiresAt,
    });
  }

  const state = newState();
  const challenge = pkce();
  const redirectUri = input.redirectUri ?? "";
  if (redirectUri === "")
    return err({
      error: "no_app",
      message:
        "this forge does not know its own public URL; set FORGE_URL so it can register a callback",
    });
  const url = authorizeUrl(registration.value, {
    state,
    challenge: challenge.challenge,
    redirectUri,
    scope,
  });
  const flow = createFlow(app.db, app.config.dataDir, {
    userId: user.value.id,
    flow: "code",
    app: registration.value,
    state,
    verifier: challenge.verifier,
    redirectUri,
    returnQuery: input.returnQuery ?? "",
    target: url,
  });
  return ok({
    flowId: flow.id,
    flow: "code",
    userCode: "",
    url,
    shortCode: flow.shortCode,
    intervalSecs: 0,
    expiresAt: flow.expiresAt,
  });
}

/**
 * The sign-in a parent forge runs for this one (`origins/broker.ts`): undefined
 * when this forge has no parent, or its parent holds no application for the
 * host. GitHub's device grant is begun by the parent and polled here; a code
 * flow sends the browser to the parent, whose start URL this forge signs.
 */
async function startBrokered(
  app: App,
  user: User,
  target: { kind: OriginKind; apiUrl: string; webUrl: string; software: string },
  returnQuery: string,
): Promise<Result<OAuthStart, { error: OAuthStartError; message: string; kind?: OriginKind }> | undefined> {
  const offer = offerFor(await brokerOffers(app), hostnameOf(target.webUrl));
  if (offer === undefined) return undefined;
  const refused = (message: string) => err({ error: "provider_refused" as const, message });
  const registration = { kind: target.kind, apiUrl: target.apiUrl, webUrl: target.webUrl, software: target.software };

  if (flowFor(target.kind) === "device") {
    const grant = await deviceGrant(app, offer.host, target.kind);
    if (!grant.ok) {
      // A parent that no longer offers it is asked again next time, not remembered as offering.
      if (grant.error.error === "not_offered") forgetOffers(app);
      return refused("this forge's host could not start the sign-in; paste a token instead");
    }
    const flow = createFlow(app.db, app.config.dataDir, {
      userId: user.id,
      flow: "device",
      app: { ...registration, clientId: grant.value.clientId, clientSecret: "" },
      deviceCode: grant.value.deviceCode,
      userCode: grant.value.userCode,
      verificationUri: grant.value.verificationUri,
      target: grant.value.verificationUri,
      intervalSecs: grant.value.intervalSecs,
      redirectUri: BROKERED,
      returnQuery,
      ttlMs: grant.value.expiresInSecs * 1000,
    });
    return ok({
      flowId: flow.id,
      flow: "device",
      userCode: grant.value.userCode,
      url: grant.value.verificationUri,
      shortCode: flow.shortCode,
      intervalSecs: grant.value.intervalSecs,
      expiresAt: flow.expiresAt,
      brokered: true,
    });
  }

  const state = newState();
  const challenge = pkce();
  const url = await startUrl(app, { host: offer.host, state, challenge: challenge.challenge });
  if (url === undefined) return undefined;
  const flow = createFlow(app.db, app.config.dataDir, {
    userId: user.id,
    flow: "code",
    app: { ...registration, clientId: "", clientSecret: "" },
    state,
    verifier: challenge.verifier,
    redirectUri: BROKERED,
    returnQuery,
    target: url,
  });
  return ok({
    flowId: flow.id,
    flow: "code",
    userCode: "",
    url,
    shortCode: flow.shortCode,
    intervalSecs: 0,
    expiresAt: flow.expiresAt,
    brokered: true,
  });
}

export interface FlowStatus {
  readonly flowId: string;
  readonly status: "pending" | "done" | "failed";
  readonly detail: string;
  readonly originId: string | null;
  readonly returnQuery: string;
  readonly userCode: string;
  readonly url: string;
  readonly intervalSecs: number;
}

const statusOf = (flow: FlowRow): FlowStatus => ({
  flowId: flow.id,
  status: flow.status,
  detail: flow.detail,
  originId: flow.originId,
  returnQuery: flow.returnQuery,
  userCode: flow.userCode,
  url: flow.verificationUri,
  intervalSecs: flow.intervalSecs,
});

/**
 * Poll a device flow once, on the caller's behalf. The forge does the
 * polling rather than the client, so a terminal session only has to ask
 * "has it happened yet?" — and the token never crosses back to a surface.
 */
export async function pollOAuthConnect(
  app: App,
  actor: User | undefined,
  flowId: string,
): Promise<Result<FlowStatus, "unauthorized" | "not_found">> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const flow = getFlowFor(app.db, user.value.id, flowId);
  if (!flow) return err("not_found");
  if (flow.status !== "pending" || flow.flow !== "device")
    return ok(statusOf(flow));

  if (flowExpired(flow)) {
    finishFlow(app.db, flow.id, {
      status: "failed",
      detail: "the code expired; start again",
    });
    return ok(statusOf(getFlowFor(app.db, user.value.id, flowId)!));
  }

  const secrets = flowSecrets(app.db, app.config.dataDir, flow.id);
  if (!secrets || secrets.deviceCode === "") {
    finishFlow(app.db, flow.id, {
      status: "failed",
      detail: "this connect can no longer be completed",
    });
    return ok(statusOf(getFlowFor(app.db, user.value.id, flowId)!));
  }

  const registration = {
    kind: flow.kind,
    apiUrl: flow.apiUrl,
    webUrl: flow.webUrl,
    clientId: flow.clientId,
    clientSecret: secrets.clientSecret,
  };
  const polled = await pollDevice(registration, secrets.deviceCode);
  if (!polled.ok) {
    if (polled.error.error === "pending") {
      touchFlow(app.db, flow.id);
      return ok(statusOf(flow));
    }
    if (polled.error.error === "slow_down") {
      touchFlow(app.db, flow.id, flow.intervalSecs + 5);
      return ok(statusOf(getFlowFor(app.db, user.value.id, flowId)!));
    }
    finishFlow(app.db, flow.id, {
      status: "failed",
      detail: polled.error.message,
    });
    return ok(statusOf(getFlowFor(app.db, user.value.id, flowId)!));
  }

  const stored = await completeConnect(
    app,
    user.value,
    registration,
    polled.value,
    flow.redirectUri === BROKERED,
  );
  finishFlow(app.db, flow.id, stored);
  return ok(statusOf(getFlowFor(app.db, user.value.id, flowId)!));
}

/**
 * The callback leg of the code flow. Everything that makes it safe happens
 * in the first ten lines: the state must exist, must belong to the caller,
 * must not have expired, and is single-use (finishing the flow clears it).
 * A state from another user is refused exactly as an unknown one is.
 */
export async function completeOAuthCallback(
  app: App,
  actor: User | undefined,
  input: { state: string; code: string; error?: string },
): Promise<Result<FlowStatus, "unauthorized" | "not_found">> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  // Claimed, not merely looked up: the state is burned in the statement that
  // finds it, so a replayed callback finds nothing at all. A state belonging
  // to another user does not match either — and both are `not_found`, never a
  // "that is not yours", which would confirm it exists.
  const flow = claimFlowByState(app.db, input.state, user.value.id);
  if (!flow) return err("not_found");
  // A sign-in the parent runs comes back to its own path, never this one.
  if (flow.redirectUri === BROKERED) {
    finishFlow(app.db, flow.id, { status: "failed", detail: FAILURE_WORDS.failed });
    return err("not_found");
  }
  if (flowExpired(flow)) {
    finishFlow(app.db, flow.id, {
      status: "failed",
      detail: "this connect expired; start again",
    });
    return err("not_found");
  }
  if (input.code === "") {
    finishFlow(app.db, flow.id, {
      status: "failed",
      detail:
        input.error === "access_denied"
          ? `You said no at ${hostOf(flow.webUrl)}. Nothing was connected.`
          : `${hostOf(flow.webUrl)} did not finish the sign-in. Nothing was connected. Start again.`,
    });
    return ok(statusOf(getFlowFor(app.db, user.value.id, flow.id)!));
  }

  const secrets = flowSecrets(app.db, app.config.dataDir, flow.id);
  const registration = {
    kind: flow.kind,
    apiUrl: flow.apiUrl,
    webUrl: flow.webUrl,
    clientId: flow.clientId,
    clientSecret: secrets?.clientSecret ?? "",
    software: flow.software,
  };
  const exchanged = await exchangeCode(registration, {
    code: input.code,
    verifier: secrets?.verifier ?? "",
    redirectUri: flow.redirectUri,
  });
  if (!exchanged.ok) {
    finishFlow(app.db, flow.id, {
      status: "failed",
      detail: `${hostOf(flow.webUrl)} did not finish the sign-in. Nothing was connected. Start again.`,
    });
    return ok(statusOf(getFlowFor(app.db, user.value.id, flow.id)!));
  }

  const stored = await completeConnect(
    app,
    user.value,
    registration,
    exchanged.value,
  );
  finishFlow(app.db, flow.id, stored);
  return ok(statusOf(getFlowFor(app.db, user.value.id, flow.id)!));
}

/**
 * The return leg of a sign-in the parent ran. The state must be this
 * person's, unspent and unexpired (claimed in the statement that finds it, as
 * the ordinary callback's is); the code is then redeemed with the parent,
 * server to server, with the verifier that only this forge holds. What comes
 * back ends in `completeConnect`, the function a pasted token's sibling flows
 * end in. A failure the parent names is shown in its words; a code or token
 * is never in what is stored.
 */
export async function completeBrokeredCallback(
  app: App,
  actor: User | undefined,
  input: { state: string; code: string; error?: string },
): Promise<Result<FlowStatus, "unauthorized" | "not_found">> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const flow = claimFlowByState(app.db, input.state, user.value.id);
  if (!flow || flow.redirectUri !== BROKERED || flow.flow !== "code") return err("not_found");
  const fail = (detail: string) => {
    finishFlow(app.db, flow.id, { status: "failed", detail });
    return ok(statusOf(getFlowFor(app.db, user.value.id, flow.id)!));
  };
  if (flowExpired(flow)) return fail(FAILURE_WORDS.expired);
  if (input.code === "") {
    const named = (input.error ?? "") in FAILURE_WORDS ? (input.error as BrokerFailure) : "failed";
    return fail(FAILURE_WORDS[named]);
  }
  const secrets = flowSecrets(app.db, app.config.dataDir, flow.id);
  if (secrets === undefined || secrets.verifier === "") return fail(FAILURE_WORDS.failed);
  const redeemed = await redeemCode(app, { code: input.code, verifier: secrets.verifier, host: hostnameOf(flow.webUrl) });
  if (!redeemed.ok) return fail(FAILURE_WORDS.failed);

  const stored = await completeConnect(
    app,
    user.value,
    { kind: flow.kind, apiUrl: flow.apiUrl, webUrl: flow.webUrl, clientId: "", clientSecret: "", software: flow.software },
    redeemed.value.tokens,
    true,
  );
  finishFlow(app.db, flow.id, stored);
  return ok(statusOf(getFlowFor(app.db, user.value.id, flow.id)!));
}

/** Validate a freshly issued token and store the origin it belongs to. */
async function completeConnect(
  app: App,
  user: User,
  registration: {
    kind: OriginKind;
    apiUrl: string;
    webUrl: string;
    clientId: string;
    clientSecret: string;
    software?: string;
  },
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: string | null;
  },
  /** The parent ran the sign-in: the token refreshes through it, since the secret is its. */
  viaParent = false,
): Promise<{ status: "done" | "failed"; detail: string; originId?: string }> {
  const provider = providerFor(
    staticCredential({
      kind: registration.kind,
      apiUrl: registration.apiUrl,
      webUrl: registration.webUrl,
      authKind: "oauth",
      software: registration.software ?? "",
      token: tokens.accessToken,
    }),
  );
  const identity = await provider.whoami();
  if (!identity.ok)
    return {
      status: "failed",
      detail:
        (identity.error.missingScopes ?? []).length > 0
          ? `The grant is missing ${scopeWords(identity.error.missingScopes!)}. The application asks for it; remove the grant on the instance and connect again.`
          : `${hostOf(registration.webUrl)} did not accept the sign-in it had just given. Nothing was connected. Start again.`,
    };
  // The account that consented is the one checked: an administrator's grant
  // or a protected repository's pusher is refused here, before anything is
  // stored, and the grant is revoked where the provider lets us.
  const guard = await checkCredential(provider, identity.value);
  if (!guard.ok) {
    const revoked = await revokeGrant(registration, tokens.accessToken);
    return {
      status: "failed",
      detail: `${guard.error.message} ${
        revoked.ok
          ? "The grant was revoked."
          : `This forge did not keep the token. You can remove the grant at ${hostOf(registration.webUrl)} under Settings → Applications.`
      }`,
    };
  }

  const stored = storeOrigin(app, user, {
    kind: registration.kind,
    apiUrl: registration.apiUrl,
    webUrl: registration.webUrl,
    login: identity.value.login,
    token: tokens.accessToken,
    authKind: "oauth",
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    software: registration.software ?? "",
  });
  if (!stored.ok)
    return { status: "failed", detail: ORIGIN_ALREADY_CONNECTED };
  if (viaParent) setCursor(app.db, stored.value.id, VIA_PARENT, "1");
  else clearCursor(app.db, stored.value.id, VIA_PARENT);
  if (guard.value.checked) noteGuardPassed(app, stored.value.id);
  await afterConnect(app, user, stored.value, guard.value.listed);
  return { status: "done", detail: "", originId: stored.value.id };
}

// ---- OAuth application registrations ----

export function registerOriginApp(
  app: App,
  actor: User | undefined,
  input: {
    host: string;
    kind?: OriginKind;
    clientId: string;
    clientSecret?: string;
  },
): Promise<Result<
  AppRow,
  "unauthorized" | "unknown_host" | "private_host" | "unreachable"
>> {
  return (async () => {
    const user = requireUser(actor);
    if (!user.ok) return user;
    const found = await discover(
      input.kind === undefined
        ? { host: input.host }
        : { host: input.host, kind: input.kind },
    );
    if (!found.ok) return err(typeof found.error === "string" ? found.error : found.error.error);
    const row = saveApp(app.db, app.config.dataDir, {
      userId: user.value.id,
      kind: found.value.kind,
      apiUrl: found.value.apiUrl,
      webUrl: found.value.webUrl,
      clientId: input.clientId.trim(),
      ...(input.clientSecret === undefined
        ? {}
        : { clientSecret: input.clientSecret.trim() }),
    });
    app.bus.append({
      kind: "origin.app_registered",
      actorId: user.value.id,
      payload: { host: found.value.webUrl, kind: found.value.kind },
    });
    return ok(row);
  })();
}

export const listOriginApps = (app: App, actor: User): AppRow[] =>
  listApps(app.db, actor.id);

export function deleteOriginApp(
  app: App,
  actor: User | undefined,
  appId: string,
): Result<void, "unauthorized" | "not_found"> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  if (!deleteApp(app.db, user.value.id, appId)) return err("not_found");
  return ok();
}

// ---- the picker, mirroring, syncing ----

export async function listRemoteRepos(
  app: App,
  actor: User | undefined,
  originId: string,
  refresh = false,
): Promise<
  Result<OriginRepoRow[], "unauthorized" | "not_found" | "unreachable">
> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const origin = getOriginFor(app.db, user.value.id, originId);
  if (!origin) return err("not_found");

  const cached = listOriginRepos(app.db, origin.id);
  if (!refresh && cached.length > 0) return ok(cached);

  const provider = providerForOrigin(app, origin);
  if (!provider.ok) return err("unreachable");
  const collected = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const listed = await provider.value.listRepos(cursor);
    if (!listed.ok) {
      if (listed.error.error === "unauthorized")
        markNeedsReauth(app.db, origin.id, listed.error.message);
      return cached.length > 0 ? ok(cached) : err("unreachable");
    }
    collected.push(...listed.value.items);
    if (listed.value.next === null) break;
    cursor = listed.value.next;
  }
  cacheOriginRepos(app.db, origin.id, collected);
  return ok(listOriginRepos(app.db, origin.id));
}

/** One page of a group: `next` is where its next page starts, and null at the end. */
export interface OriginRepoGroup {
  readonly items: readonly OriginRepoRow[];
  readonly next: string | null;
}

/**
 * One group of what a person can see on an origin, read live and kept nowhere:
 * a whole forge's public repositories are not this person's list, and the
 * cache behind `listRemoteRepos` stays theirs. What they already mirror is
 * looked up in that cache, so a row says so.
 */
export async function listOriginRepoGroup(
  app: App,
  actor: User | undefined,
  originId: string,
  group: RepoGroup,
  query: { readonly q?: string; readonly cursor?: string } = {},
): Promise<Result<OriginRepoGroup, "unauthorized" | "not_found" | "unreachable">> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const origin = getOriginFor(app.db, user.value.id, originId);
  if (!origin) return err("not_found");
  const provider = providerForOrigin(app, origin);
  if (!provider.ok) return err("unreachable");

  if (provider.value.listRepoGroup === undefined) {
    // No such listing (GitHub): the account's own list, sorted; nothing is "public" here.
    if (group === "public") return ok({ items: [], next: null });
    const listed = await listRemoteRepos(app, actor, originId);
    if (!listed.ok) return listed;
    const login = origin.login.toLowerCase();
    const wanted = (query.q ?? "").trim().toLowerCase();
    return ok({
      items: listed.value.filter(
        (row) =>
          (row.fullName.split("/")[0]!.toLowerCase() === login) === (group === "yours") &&
          `${row.fullName} ${row.description}`.toLowerCase().includes(wanted),
      ),
      next: null,
    });
  }

  const read = await provider.value.listRepoGroup(group, query);
  if (!read.ok) {
    if (read.error.error === "unauthorized") markNeedsReauth(app.db, origin.id, read.error.message);
    return err("unreachable");
  }
  const known = new Map(listOriginRepos(app.db, origin.id).map((row) => [row.remoteId, row]));
  return ok({
    items: read.value.items.map((remote) => ({
      originId: origin.id,
      remoteId: remote.remoteId,
      fullName: remote.fullName,
      description: remote.description,
      private: remote.private,
      fork: remote.fork,
      defaultBranch: remote.defaultBranch,
      cloneUrl: remote.cloneUrl,
      htmlUrl: remote.htmlUrl,
      pushedAt: remote.pushedAt,
      canPush: remote.permissions.push,
      seenAt: new Date().toISOString(),
      forkOf: remote.parent ?? known.get(remote.remoteId)?.forkOf ?? null,
      mirroredAs: known.get(remote.remoteId)?.mirroredAs ?? null,
      openIssues: remote.openIssues,
      openPulls: remote.openPulls,
      openIssuesIncludingPulls: remote.openIssuesIncludesPulls,
      sizeKb: remote.sizeKb,
    })),
    next: read.value.next,
  });
}

/**
 * Start a mirror and hand back the job at once. The work runs detached; the
 * caller renders `job.stage` and subscribes (`origins/jobs.ts`) or polls.
 *
 * Only the origin's owner may ask — this spends their credential against
 * another forge, exactly like every other route on an origin — and anyone
 * else's origin is `not_found`.
 */
export function startMirrorJob(
  app: App,
  actor: User | undefined,
  originId: string,
  fullName: string,
  name?: string,
): Result<MirrorJob, "unauthorized" | "not_found" | "unverified" | "not_member"> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const proven = requireVerified(app, user.value);
  if (!proven.ok) return proven;
  const member = requireAbility(app, user.value, "make_it_yours");
  if (!member.ok) return member;
  const origin = getOriginFor(app.db, user.value.id, originId);
  if (!origin) return err("not_found");
  return ok(startMirror(app, user.value, origin, fullName, name));
}

/**
 * A job as its owner may see it. Jobs live in memory and are keyed by id
 * alone, so the origin check is what stops one account watching another's
 * import — the id is unguessable, but "unguessable" is not an access check.
 */
export function mirrorJobFor(
  app: App,
  actor: User | undefined,
  originId: string,
  jobId: string,
): Result<MirrorJob, "unauthorized" | "not_found"> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const origin = getOriginFor(app.db, user.value.id, originId);
  if (!origin) return err("not_found");
  const job = getJob(jobId);
  if (job === undefined || job.kind !== "mirror" || job.originId !== origin.id)
    return err("not_found");
  return ok(job);
}

export async function syncOriginNow(
  app: App,
  actor: User | undefined,
  originId: string,
): Promise<Result<SyncReport, "unauthorized" | "not_found">> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const origin = getOriginFor(app.db, user.value.id, originId);
  if (!origin) return err("not_found");
  requestSyncNow(app, origin.id);
  return ok(await syncOrigin(app, origin));
}

/**
 * Sync one mirror now. Any writer of the local repo may ask for this — it
 * only pulls, so it borrows nobody's identity and grants nobody anything.
 * It is the one path that overwrites a default branch holding commits the
 * origin lacks: the person asked for the origin's branches as they are.
 */
export async function syncRepoNow(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Promise<Result<SyncReport, "unauthorized" | "forbidden" | "not_found">> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  const link = originForRepo(app.db, repo.id);
  if (!link) return err("not_found");
  return ok(await syncOrigin(app, link.origin, { onlyRepoId: repo.id, overwrite: true }));
}

/** Taking the origin's new commits: what the sync did, or why it did not. */
export type Taking =
  | { readonly kind: "taken"; readonly count: number; readonly report: SyncReport }
  | { readonly kind: "conflict"; readonly count: number }
  | { readonly kind: "unread" };

/**
 * The one action behind "N new commits upstream": a mirror takes what its
 * origin has, unless its default branch holds commits the origin lacks — a
 * sync would overwrite them, so that is a conflict and nothing moves. When
 * the origin cannot be read, nothing moves either: it is not known whether
 * the sync would overwrite. The sweep holds such a mirror too; only Sync now
 * (`syncRepoNow`) overwrites, because a person asked for exactly that.
 */
export async function takeFromOrigin(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Promise<Result<Taking, "unauthorized" | "forbidden" | "not_found">> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  const link = originForRepo(app.db, repo.id);
  if (link === undefined) return err("not_found");
  const seen = await readAhead(app, repo);
  if (seen === undefined) return ok({ kind: "unread" });
  if (seen.diverged) return ok({ kind: "conflict", count: seen.count });
  const report = await syncOrigin(app, link.origin, { onlyRepoId: repo.id });
  await readAhead(app, repo);
  return ok({ kind: "taken", count: seen.count, report });
}

// ---- reconnecting a frozen mirror ----

export type ReattachError =
  | AccessError
  | "not_detached"
  | "wrong_host"
  | "remote_unknown"
  | "origin_cannot_see"
  | "not_the_same_repo"
  | "already_mirrored"
  | "needs_reauth"
  | "unreachable";

/** One detached mirror a connect tried to bring back, and how it went. */
export interface Reattachment {
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  /** Why it stayed frozen; null when it was re-attached. */
  readonly refused: ReattachError | null;
}

/**
 * Attach a detached mirror to one of the actor's origins, and start the
 * sync that moves its refs (#1090). A mirror whose origin was disconnected
 * keeps its provenance and refuses pushes; this is the one door back.
 *
 * Who may: an admin of the repo (anyone else is `not_found`, invariant 9)
 * who owns the origin (another person's origin is `not_found` too — it
 * would lend their credential to this mirror's every later sync and push).
 * What must hold: the origin lives on the host the mirror came from, and
 * its account can see the repository by the name the mirror remembers.
 */
export async function reattachMirror(
  app: App,
  actor: User | undefined,
  repo: Repo,
  originId: string,
): Promise<Result<{ origin: Origin; fullName: string }, ReattachError>> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  if (!detachedMirror(app.db, repo.id)) return err("not_detached");
  const origin = getOriginFor(app.db, admin.value.id, originId);
  if (!origin) return err("not_found");
  const attached = await attach(app, admin.value, repo, origin);
  if (!attached.ok) return attached;
  syncSoon(app, origin, repo.id);
  return attached;
}

/**
 * After a connect: every detached mirror the person owns that came from
 * this origin's host is attached to it, and one sync moves them all. A
 * refusal is reported beside the successes, never a failed connect — the
 * account is connected either way. A mirror whose host could only be read
 * from its git remote, and turns out to be elsewhere, is not this origin's
 * and is not mentioned.
 *
 * Owns, not administers: re-attaching lends this credential to every later
 * sync and push of the mirror, and an organization's mirror borrowing an
 * admin's personal account is a choice that admin makes with the Reconnect
 * button, never a side effect of connecting.
 */
async function afterConnect(
  app: App,
  user: User,
  origin: Origin,
  listed: readonly RemoteRepo[] | null = null,
): Promise<Reattachment[]> {
  // The guard listed what the account can see: that is the picker's list,
  // at once — no second walk of the same pages. Anywhere the guard did not
  // walk, the picker fetches it when it is opened, as before.
  if (listed !== null) cacheOriginRepos(app.db, origin.id, listed);
  const out: Reattachment[] = [];
  for (const mirror of listDetachedMirrors(app.db, {
    site: siteOf(origin.webUrl),
    ownerId: user.id,
  })) {
    const repo = getRepoById(app.db, mirror.repoId);
    if (!repo || !canAdmin(app.db, repo, user)) continue;
    const attached = await attach(app, user, repo, origin);
    if (!attached.ok && attached.error === "wrong_host") continue;
    out.push({
      owner: repo.ownerName,
      name: repo.name,
      fullName: attached.ok ? attached.value.fullName : mirror.fullName,
      refused: attached.ok ? null : attached.error,
    });
  }
  // Whatever now hangs off it moves at once: the mirrors just re-attached,
  // and a renewed origin's, which never detached but were only waiting.
  if (listMirrors(app.db, origin.id).length > 0) syncSoon(app, origin);
  return out;
}

/** The re-attach itself, for a caller that has already authorized it. */
async function attach(
  app: App,
  user: User,
  repo: Repo,
  origin: Origin,
): Promise<Result<{ origin: Origin; fullName: string }, ReattachError>> {
  const mirror = detachedMirror(app.db, repo.id);
  if (!mirror) return err("not_detached");
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const came =
    mirror.htmlUrl !== "" ? mirror.htmlUrl : await mirrorRemoteUrl(dir);
  if (siteOf(came) === "" || siteOf(came) !== siteOf(origin.webUrl))
    return err("wrong_host");
  // A mirror made before the forge kept the origin's id for it cannot be
  // told apart from a repository made again under the same name, and a
  // sync would prune its history into the newcomer's. It is not guessed.
  if (mirror.remoteId === "") return err("remote_unknown");
  if (origin.needsReauth) return err("needs_reauth");
  const provider = providerForOrigin(app, origin);
  if (!provider.ok) return err("needs_reauth");

  const found = await provider.value.getRepo(mirror.fullName);
  if (!found.ok)
    return err(
      found.error.error === "unreachable" ||
        found.error.error === "rate_limited" ||
        found.error.error === "invalid_response"
        ? "unreachable"
        : "origin_cannot_see",
    );
  const remote = found.value;
  // A name can be reused: a repository deleted upstream and made again under
  // the same name is not the one this mirror holds, and a sync would prune
  // its history into the newcomer's.
  if (mirror.remoteId !== "" && remote.remoteId !== mirror.remoteId)
    return err("not_the_same_repo");
  // The clone URL becomes a git remote; the origin's word is checked first.
  if (remote.cloneUrl === "" || safeRemoteUrl(remote.cloneUrl) === undefined)
    return err("unreachable");

  // Re-mirrored in the meantime: two local repos syncing one remote would
  // each think the other's writes were the origin's. Asked again after the
  // one wait below, so the check and the link have no await between them.
  const taken = () => mirrorOfRemote(app.db, origin.id, remote) !== undefined;
  if (taken()) return err("already_mirrored");
  const configured = await configureMirror(dir, remote.cloneUrl);
  if (!configured.ok) return err("unreachable");
  if (taken()) return err("already_mirrored");

  // The picker row is where the sync reads the clone URL back from.
  rememberOriginRepo(app.db, origin.id, remote);
  linkRepoToOrigin(app.db, repo.id, {
    originId: origin.id,
    fullName: remote.fullName,
    remoteId: remote.remoteId,
    htmlUrl: remote.htmlUrl,
  });
  bustOrigin(origin.id, remote.fullName);
  app.bus.append({
    kind: "origin.mirror_reattached",
    repoId: repo.id,
    actorId: user.id,
    payload: { origin: origin.id, fullName: remote.fullName },
  });
  return ok({ origin, fullName: remote.fullName });
}

/**
 * Sync now, in the background: the caller has a page to answer and the
 * refs follow within the request's shadow. A sync that throws is the
 * sync's to report (`fetch_error`), never the caller's; the worker's due
 * time is pulled in as well, so a sync this process loses still happens.
 */
function syncSoon(app: App, origin: Origin, onlyRepoId?: string): void {
  requestSyncNow(app, origin.id);
  const fresh = getOriginFor(app.db, origin.userId, origin.id) ?? origin;
  void syncOrigin(
    app,
    fresh,
    onlyRepoId === undefined ? {} : { onlyRepoId },
  ).catch((error: unknown) => {
    app.log.warn("sync after reconnect failed", {
      origin: origin.id,
      error: String(error),
    });
  });
}

// ---- pins ----

export function pinRepo(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Result<void, "unauthorized" | "not_found"> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  addPin(app.db, user.value.id, repo.id);
  app.bus.append({
    kind: "repo.pinned",
    repoId: repo.id,
    actorId: user.value.id,
  });
  return ok();
}

export function unpinRepo(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Result<void, "unauthorized" | "not_found"> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  if (!dropPin(app.db, user.value.id, repo.id)) return err("not_found");
  app.bus.append({
    kind: "repo.unpinned",
    repoId: repo.id,
    actorId: user.value.id,
  });
  return ok();
}

export function listPinned(app: App, actor: User): Pin[] {
  return listPins(app.db, actor.id);
}

// ---- write-through ----

// The guard itself lives in `origins/write-through.ts`, a leaf module, so
// that opening an issue does not pull the connect flows and the sync worker
// into the graph behind it. Re-exported here because this is where a reader
// looks for it.
export {
  isMirror,
  refusal,
  writeThroughFor,
  type WriteThrough,
  type WriteThroughError,
} from "../origins/write-through.ts";
