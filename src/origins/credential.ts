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
  getOriginById,
  markNeedsReauth,
  sealedSecrets,
  storeRefreshed,
  type Origin,
} from "../core/origins.ts";
import { createLog } from "../kernel/log.ts";
import { open } from "../kernel/secret.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { appFor, refresh, type AppRegistration } from "./oauth.ts";
import { providerFor } from "./providers/index.ts";
import type { Provider, ProviderCredential, ProviderResult } from "./types.ts";

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
    token: () => resolveToken(app, origin.id),
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

  const registration = appFor(app.db, app.config.dataDir, origin.userId, {
    kind: origin.kind,
    apiUrl: origin.apiUrl,
    webUrl: origin.webUrl,
  });
  if (!registration.ok) {
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

  const next = await refresh(registration.value, refreshToken.value);
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
}

function announceReauth(app: App, origin: Origin, reason: string): void {
  app.bus.append({
    kind: "origin.needs_reauth",
    actorId: origin.userId,
    payload: { originId: origin.id, host: origin.webUrl, reason },
  });
}

export type { AppRegistration };
