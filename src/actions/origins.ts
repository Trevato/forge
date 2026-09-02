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

import type { App } from "../app.ts";
import {
  cacheOriginRepos,
  createOrigin,
  deleteOrigin,
  getOriginFor,
  listOriginRepos,
  listOrigins,
  markNeedsReauth,
  originForRepo,
  sealedSecrets,
  type Origin,
  type OriginRepoRow,
} from "../core/origins.ts";
import {
  listPins,
  pin as addPin,
  unpin as dropPin,
  type Pin,
} from "../core/pins.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { discover } from "../origins/discover.ts";
import { providerForOrigin } from "../origins/credential.ts";
import {
  mirrorRepo as runMirror,
  type MirrorError,
} from "../origins/mirror.ts";
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
  startDevice,
  touchFlow,
  type AppRow,
  type FlowRow,
} from "../origins/oauth.ts";
import { forgetProvider, providerFor } from "../origins/providers/index.ts";
import {
  requestSyncNow,
  syncOrigin,
  type SyncReport,
} from "../origins/sync.ts";
import { open } from "../kernel/secret.ts";
import {
  staticCredential,
  type OriginKind,
  type Provider,
} from "../origins/types.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireUser, requireWriter } from "./access.ts";

// ---- abuse control ----

/**
 * Connect attempts per user per window. Connecting makes the forge fetch a
 * host the caller named, so an unbounded connect endpoint is an outbound
 * request amplifier; this is the cap that stops it being one. In-memory on
 * purpose — a restart clearing it costs nothing, and a table would be state
 * that cannot be rebuilt from anything.
 */
const CONNECT_LIMIT = 5;
const CONNECT_WINDOW_MS = 15 * 60_000;
const attempts = new Map<string, number[]>();

function tooManyAttempts(userId: string, now = Date.now()): boolean {
  const recent = (attempts.get(userId) ?? []).filter(
    (at) => now - at < CONNECT_WINDOW_MS,
  );
  recent.push(now);
  attempts.set(userId, recent);
  return recent.length > CONNECT_LIMIT;
}

/** Test seam: forget the connect-attempt window. */
export function resetConnectLimit(): void {
  attempts.clear();
}

// ---- connecting ----

export type ConnectError =
  | "unauthorized"
  | "unknown_host"
  | "unreachable"
  | "bad_token"
  | "already_connected"
  | "rate_limited";

export interface ConnectInput {
  /** What the user typed: `github`, `codeberg.org`, `https://git.example`. */
  host: string;
  /** Set when the user picked a forge explicitly (GitHub Enterprise). */
  kind?: OriginKind;
  token: string;
}

/**
 * Connect with a pasted token — the fallback path, and the only one that
 * works with no OAuth application registered anywhere. The token is
 * validated against the origin before it is stored, and `login` comes from
 * the origin's answer rather than anything the user typed.
 */
export async function connectOrigin(
  app: App,
  actor: User | undefined,
  input: ConnectInput,
): Promise<Result<Origin, ConnectError>> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  if (tooManyAttempts(user.value.id)) return err("rate_limited");
  if (input.token.trim() === "") return err("bad_token");

  const found = await discover(
    input.kind === undefined
      ? { host: input.host }
      : { host: input.host, kind: input.kind },
  );
  if (!found.ok) return err(found.error);

  const identity = await providerFor(
    staticCredential({
      kind: found.value.kind,
      apiUrl: found.value.apiUrl,
      webUrl: found.value.webUrl,
      token: input.token.trim(),
    }),
  ).whoami();
  if (!identity.ok)
    return err(
      identity.error.error === "unreachable" ? "unreachable" : "bad_token",
    );

  return storeOrigin(app, user.value, {
    kind: found.value.kind,
    apiUrl: found.value.apiUrl,
    webUrl: found.value.webUrl,
    login: identity.value.login,
    token: input.token.trim(),
    authKind: "pat",
  });
}

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
  },
): Result<Origin, "already_connected"> {
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

// ---- OAuth ----

export type OAuthStartError =
  | "unauthorized"
  | "unknown_host"
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
  input: { host: string; kind?: OriginKind; redirectUri?: string },
): Promise<Result<OAuthStart, { error: OAuthStartError; message: string }>> {
  const user = requireUser(actor);
  if (!user.ok) return err({ error: "unauthorized", message: "sign in first" });
  if (tooManyAttempts(user.value.id))
    return err({ error: "rate_limited", message: "too many connect attempts" });

  const found = await discover(
    input.kind === undefined
      ? { host: input.host }
      : { host: input.host, kind: input.kind },
  );
  if (!found.ok)
    return err({
      error: found.error,
      message: `cannot identify ${input.host}`,
    });

  const registration = appFor(app.db, app.config.dataDir, user.value.id, {
    kind: found.value.kind,
    apiUrl: found.value.apiUrl,
    webUrl: found.value.webUrl,
  });
  if (!registration.ok) {
    return err({
      error: "no_app",
      message:
        found.value.kind === "github"
          ? "no GitHub OAuth app is configured; paste a token instead"
          : "register an OAuth application on this instance first",
    });
  }
  const scope = scopesFor(found.value.kind);

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

export interface FlowStatus {
  readonly flowId: string;
  readonly status: "pending" | "done" | "failed";
  readonly detail: string;
  readonly originId: string | null;
  readonly userCode: string;
  readonly url: string;
  readonly intervalSecs: number;
}

const statusOf = (flow: FlowRow): FlowStatus => ({
  flowId: flow.id,
  status: flow.status,
  detail: flow.detail,
  originId: flow.originId,
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
  input: { state: string; code: string },
): Promise<Result<FlowStatus, "unauthorized" | "not_found">> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  // Claimed, not merely looked up: the state is burned in the statement that
  // finds it, so a replayed callback finds nothing at all. A state belonging
  // to another user does not match either — and both are `not_found`, never a
  // "that is not yours", which would confirm it exists.
  const flow = claimFlowByState(app.db, input.state, user.value.id);
  if (!flow) return err("not_found");
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
      detail: "the origin returned no authorization code",
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
  };
  const exchanged = await exchangeCode(registration, {
    code: input.code,
    verifier: secrets?.verifier ?? "",
    redirectUri: flow.redirectUri,
  });
  if (!exchanged.ok) {
    finishFlow(app.db, flow.id, {
      status: "failed",
      detail: exchanged.error.message,
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
  },
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: string | null;
  },
): Promise<{ status: "done" | "failed"; detail: string; originId?: string }> {
  const identity = await providerFor(
    staticCredential({
      kind: registration.kind,
      apiUrl: registration.apiUrl,
      webUrl: registration.webUrl,
      authKind: "oauth",
      token: tokens.accessToken,
    }),
  ).whoami();
  if (!identity.ok)
    return { status: "failed", detail: "the new token did not work" };

  const stored = storeOrigin(app, user, {
    kind: registration.kind,
    apiUrl: registration.apiUrl,
    webUrl: registration.webUrl,
    login: identity.value.login,
    token: tokens.accessToken,
    authKind: "oauth",
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  });
  if (!stored.ok)
    return { status: "failed", detail: "that account is already connected" };
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
): Promise<Result<AppRow, "unauthorized" | "unknown_host" | "unreachable">> {
  return (async () => {
    const user = requireUser(actor);
    if (!user.ok) return user;
    const found = await discover(
      input.kind === undefined
        ? { host: input.host }
        : { host: input.host, kind: input.kind },
    );
    if (!found.ok) return err(found.error);
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

export async function mirrorRepo(
  app: App,
  actor: User | undefined,
  originId: string,
  fullName: string,
  name?: string,
): Promise<Result<Repo, "unauthorized" | MirrorError>> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const origin = getOriginFor(app.db, user.value.id, originId);
  if (!origin) return err("not_found");
  const mirrored = await runMirror(app, user.value, origin, fullName, name);
  if (!mirrored.ok) return mirrored;
  return ok(mirrored.value.repo);
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
  return ok(await syncOrigin(app, link.origin, { onlyRepoId: repo.id }));
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
