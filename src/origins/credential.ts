/**
 * From a stored origin to a live credential.
 *
 * This is the seam between "a row in SQLite" and "a provider that can make a
 * request". It exists as its own module because the providers must stay pure
 * adapters — no database, no key file, no refresh logic — and because the
 * one interesting behaviour here belongs to neither side: an OAuth access
 * token expires, and something has to notice before the request rather than
 * after the 401.
 *
 * Refresh is serialised per origin. Two syncs racing to refresh the same
 * credential would each spend the refresh token; with rotation, the loser's
 * new token is one the winner already invalidated, and the origin is dead
 * until a human reconnects. One in-flight refresh per origin, and the new
 * pair is written before it is used.
 */

import type { App } from "../app.ts";
import {
  cacheOriginRepos,
  clearCursor,
  getCursor,
  getOriginById,
  listAllOrigins,
  markNeedsReauth,
  sealedSecrets,
  setCursor,
  storeRefreshed,
  type Origin,
} from "../core/origins.ts";
import { createLog } from "../kernel/log.ts";
import { open } from "../kernel/secret.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { VIA_PARENT, refreshViaParent } from "./broker.ts";
import { appFor, refresh, type AppRegistration } from "./oauth.ts";
import { checkCredential, guarded, hostnameOf } from "./operator.ts";
import { forgetProvider, providerFor } from "./providers/index.ts";
import {
  staticCredential,
  type Provider,
  type ProviderCredential,
  type ProviderResult,
} from "./types.ts";

const log = createLog("origins");

/** Refresh a token this long before it actually expires. */
const EARLY_REFRESH_MS = 60_000;

/** One in-flight refresh per origin; everyone else awaits the same promise. */
const refreshing = new Map<string, Promise<void>>();

export type CredentialError = "no_token" | "needs_reauth";

/**
 * The credential for an origin. Nothing is resolved here: the returned
 * object reads (and if necessary refreshes) the secret at the moment a
 * request needs it, so a long sync cannot carry a token past its expiry.
 */
export function credentialFor(
  app: App,
  origin: Origin,
): Result<ProviderCredential, CredentialError> {
  // A row whose secret was blanked is as unconnected as a missing row.
  const sealed = sealedSecrets(app.db, origin.id);
  if (sealed === undefined || sealed.token === "") return err("no_token");
  return ok({
    kind: origin.kind,
    apiUrl: origin.apiUrl,
    webUrl: origin.webUrl,
    login: origin.login,
    authKind: origin.authKind,
    software: origin.software,
    token: () => resolveToken(app, origin.id),
    writable: () => {
      if (origin.readOnly)
        return { ok: false, error: { error: "forbidden", message: READ_ONLY } };
      const paused = writesPaused(app, origin.id);
      return paused === undefined
        ? { ok: true, value: true }
        : { ok: false, error: { error: "forbidden", message: paused } };
    },
  });
}

/** The provider for an origin, adapter cached per forge instance. */
export function providerForOrigin(
  app: App,
  origin: Origin,
): Result<Provider, CredentialError> {
  const credential = credentialFor(app, origin);
  if (!credential.ok) return credential;
  return ok(
    providerFor(credential.value, {
      dataDir: app.config.dataDir,
      originId: origin.id,
    }),
  );
}

/**
 * The current access token, refreshed if it is about to stop working. Every
 * outcome that is not a usable token is `unauthorized` to the provider —
 * which is the truth from its point of view, and keeps the adapter free of
 * any notion of expiry.
 */
async function resolveToken(
  app: App,
  originId: string,
): Promise<ProviderResult<string>> {
  const current = getOriginById(app.db, originId);
  if (!current) return authFailure("this origin is no longer connected");
  if (current.needsReauth)
    return authFailure("this origin needs to be reconnected");

  if (current.authKind === "oauth" && expiringSoon(current)) {
    const pending = refreshing.get(originId);
    if (pending) await pending;
    else await runRefresh(app, originId);
    const after = getOriginById(app.db, originId);
    if (!after || after.needsReauth)
      return authFailure("this origin needs to be reconnected");
  }

  const sealed = sealedSecrets(app.db, originId);
  if (!sealed) return authFailure("this origin is no longer connected");
  const token = open(app.config.dataDir, sealed.token, originId);
  if (!token.ok)
    return authFailure("this origin's stored credential cannot be read");
  return { ok: true, value: token.value };
}

const authFailure = (message: string): ProviderResult<never> => ({
  ok: false,
  error: { error: "unauthorized", message },
});

function expiringSoon(origin: Origin, now = Date.now()): boolean {
  if (origin.expiresAt === null) return false;
  const at = Date.parse(origin.expiresAt);
  return Number.isFinite(at) && at - EARLY_REFRESH_MS <= now;
}

function runRefresh(app: App, originId: string): Promise<void> {
  const inflight = refreshOnce(app, originId).finally(() => {
    refreshing.delete(originId);
  });
  refreshing.set(originId, inflight);
  return inflight;
}

async function refreshOnce(app: App, originId: string): Promise<void> {
  const origin = getOriginById(app.db, originId);
  if (!origin) return;

  // A token the parent's sign-in issued refreshes through the parent: the client secret is its.
  const viaParent = getCursor(app.db, originId, VIA_PARENT) === "1";
  const registration = viaParent
    ? undefined
    : appFor(app.db, app.config.dataDir, origin.userId, {
        kind: origin.kind,
        apiUrl: origin.apiUrl,
        webUrl: origin.webUrl,
        software: origin.software,
      });
  if (registration !== undefined && !registration.ok) {
    markNeedsReauth(
      app.db,
      originId,
      "no OAuth app is registered for this host",
    );
    announceReauth(app, origin, "no OAuth app is registered for this host");
    return;
  }

  const sealed = sealedSecrets(app.db, originId);
  const refreshToken =
    sealed && sealed.refresh !== ""
      ? open(app.config.dataDir, sealed.refresh, originId)
      : undefined;
  if (!refreshToken?.ok) {
    markNeedsReauth(app.db, originId, "no refresh token is stored");
    announceReauth(app, origin, "no refresh token is stored");
    return;
  }

  const next =
    registration === undefined
      ? await refreshViaParent(app, { host: hostnameOf(origin.webUrl), refreshToken: refreshToken.value })
      : await refresh(registration.value, refreshToken.value);
  if (!next.ok) {
    // `invalid_grant` is terminal: the refresh token is spent or revoked and
    // no amount of retrying brings it back. Anything else is worth another
    // tick, so the origin is left alone.
    if (next.error.error === "invalid_grant") {
      markNeedsReauth(app.db, originId, next.error.message);
      announceReauth(app, origin, next.error.message);
    } else {
      log.warn("origin token refresh failed", {
        origin: originId,
        reason: next.error.error,
      });
    }
    return;
  }

  // Persist BEFORE anything uses the new access token: a rotated refresh
  // token we did not store is an origin that can never refresh again.
  storeRefreshed(app.db, app.config.dataDir, originId, {
    token: next.value.accessToken,
    refresh: next.value.refreshToken,
    expiresAt: next.value.expiresAt,
  });
  app.bus.append({
    kind: "origin.refreshed",
    actorId: origin.userId,
    payload: { originId, host: origin.webUrl },
  });

  // A grant outlives the rights it was given with. The account behind the
  // new token is checked again before the token is used for anything: one
  // that has since become an administrator, or can now push to a protected
  // repository, is cut off here, and `resolveToken` sees it at once.
  const fresh = getOriginById(app.db, originId);
  if (fresh !== undefined && guarded(fresh))
    await recheckOrigin(
      app,
      fresh,
      providerFor(
        staticCredential({
          kind: fresh.kind,
          apiUrl: fresh.apiUrl,
          webUrl: fresh.webUrl,
          login: fresh.login,
          authKind: "oauth",
          token: next.value.accessToken,
        }),
      ),
    );
}

// ---- the operator guard, again, on what is already stored ----

/** When the account last passed the guard. A cache: lose it, check again. */
const CHECKED = "guard_checked_at";
/** When the guard first could not run, while it still cannot. */
const UNCHECKED_SINCE = "guard_unchecked_since";
/** When the sweep last tried this origin, passed or not. */
const TRIED = "guard_tried_at";

/** A stored origin is checked again this often. */
export const GUARD_EVERY_MS = 24 * 60 * 60_000;
/** A check that could not run is tried again after this long. */
const GUARD_RETRY_MS = 15 * 60_000;
/** A check that cannot run for this long refuses the origin: fail closed. */
const GUARD_GIVE_UP_MS = 24 * 60 * 60_000;
/** The sweep's pause between requests: one origin at a time, gently. */
const SWEEP_PAUSE_MS = 500;

/** What a write through a read-only origin is told (`origin_read_only`), everywhere. */
export const READ_ONLY =
  "This account was connected read-only, so nothing is written through it. Reading and syncing go on.";

/** What a write through a paused origin is told, everywhere. */
export const WRITES_PAUSED =
  "This forge could not verify this connection against the operator's rules, so writes through it are paused. Reads and sync go on. Check it again under Settings → Connected accounts.";

/**
 * Why writes through this origin are paused, or undefined when they are
 * not. On a guarded host an origin writes only once its account has passed
 * the guard, and not while a check is failing: until then it may read and
 * sync, and nothing it does reaches the origin — no write-through, no push,
 * no fork or pull made there. (A refused origin is `needs_reauth`, and does
 * nothing at all.) Fails closed: an origin never checked is paused too,
 * until the sweep or a person's "Check again" checks it.
 */
export function writesPaused(app: App, originId: string): string | undefined {
  const origin = getOriginById(app.db, originId);
  if (origin === undefined || origin.needsReauth || !guarded(origin))
    return undefined;
  const checked = getCursor(app.db, originId, CHECKED);
  const failing = getCursor(app.db, originId, UNCHECKED_SINCE);
  return checked === undefined || failing !== undefined
    ? WRITES_PAUSED
    : undefined;
}

/** When the guard last tried this origin, if it ever did. */
export function lastGuardTry(app: App, originId: string): string | undefined {
  return getCursor(app.db, originId, TRIED);
}

/** Record that this origin's account passed the guard now (a connect did). */
export function noteGuardPassed(app: App, originId: string): void {
  setCursor(app.db, originId, CHECKED, new Date().toISOString());
  clearCursor(app.db, originId, UNCHECKED_SINCE);
}

export type Recheck = "passed" | "refused" | "unchecked" | "unguarded";

/**
 * The guard (`origins/operator.ts`) on an origin already stored: after an
 * OAuth refresh, and on the sweep. A refusal marks it `needs_reauth` with
 * the guard's sentence as the reason, so nothing — sync, write-through,
 * push-through, the crew's pulls — uses the credential again until a person
 * reconnects with an account the operator allows. A check that cannot run
 * is retried; one that has not run for a day refuses the origin as well.
 */
export async function recheckOrigin(
  app: App,
  origin: Origin,
  provider: Provider,
  options: { pauseMs?: number } = {},
): Promise<Recheck> {
  if (!guarded(origin)) return "unguarded";
  if (getOriginById(app.db, origin.id)?.needsReauth !== false) return "refused";
  setCursor(app.db, origin.id, TRIED, new Date().toISOString());
  const identity = await provider.whoami();
  const verdict = identity.ok
    ? await checkCredential(provider, identity.value, process.env, options)
    : undefined;
  if (verdict?.ok === true) {
    noteGuardPassed(app, origin.id);
    if (verdict.value.listed !== null)
      cacheOriginRepos(app.db, origin.id, verdict.value.listed);
    return "passed";
  }
  if (verdict !== undefined && verdict.error.error !== "guard_unchecked") {
    refuse(app, origin, verdict.error.message);
    return "refused";
  }
  // A credential the origin no longer takes (a grant revoked there) is a
  // reconnect, said now, not a day of quiet failures.
  if (!identity.ok && identity.error.error === "unauthorized") {
    refuse(app, origin, "The origin no longer accepts this credential. Reconnect it.");
    return "refused";
  }
  const since = getCursor(app.db, origin.id, UNCHECKED_SINCE);
  if (since === undefined) {
    setCursor(app.db, origin.id, UNCHECKED_SINCE, new Date().toISOString());
  } else if (Date.now() - Date.parse(since) >= GUARD_GIVE_UP_MS) {
    refuse(
      app,
      origin,
      "This forge could not check this account against the operator's rules for a day. Reconnect it.",
    );
    return "refused";
  }
  return "unchecked";
}

function refuse(app: App, origin: Origin, reason: string): void {
  // Already refused (a refresh's check inside this one): its reason stands.
  if (getOriginById(app.db, origin.id)?.needsReauth !== false) return;
  markNeedsReauth(app.db, origin.id, reason);
  forgetProvider({ dataDir: app.config.dataDir, originId: origin.id });
  announceReauth(app, origin, reason);
  log.warn("origin refused by the operator guard", {
    origin: origin.id,
    host: origin.webUrl,
  });
}

/** Whether the sweep owes this origin a check now. */
function due(app: App, origin: Origin, now: number): boolean {
  if (origin.needsReauth || !guarded(origin)) return false;
  const tried = getCursor(app.db, origin.id, TRIED);
  if (tried !== undefined && now - Date.parse(tried) < GUARD_RETRY_MS)
    return false;
  const checked = getCursor(app.db, origin.id, CHECKED);
  return checked === undefined || now - Date.parse(checked) >= GUARD_EVERY_MS;
}

const sweeping = new WeakSet<App>();

/**
 * The guard over every stored origin on a guarded host: one never checked
 * (connected before the guard existed, or before the operator named its
 * host) at once, every other once a day. One origin per call — the sync
 * tick calls it each minute — with its requests spaced out, so the sweep
 * never adds more than a trickle to the origin it protects. Single-flight
 * per forge; never throws.
 */
export function runGuardSweep(app: App): Promise<void> {
  if (sweeping.has(app)) return Promise.resolve();
  const now = Date.now();
  // Paused origins first: their writes wait on this check.
  const owed = listAllOrigins(app.db).filter((o) => due(app, o, now));
  const origin =
    owed.find((o) => writesPaused(app, o.id) !== undefined) ?? owed[0];
  if (origin === undefined) return Promise.resolve();
  sweeping.add(app);
  return (async () => {
    const provider = providerForOrigin(app, origin);
    if (!provider.ok) return;
    await recheckOrigin(app, origin, provider.value, {
      pauseMs: SWEEP_PAUSE_MS,
    });
  })()
    .catch((error: unknown) => {
      log.warn("origin guard sweep failed", {
        origin: origin.id,
        error: String(error),
      });
    })
    .finally(() => sweeping.delete(app));
}

function announceReauth(app: App, origin: Origin, reason: string): void {
  app.bus.append({
    kind: "origin.needs_reauth",
    actorId: origin.userId,
    payload: { originId: origin.id, host: origin.webUrl, reason },
  });
}

export type { AppRegistration };
