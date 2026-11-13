/**
 * A hosted forge's side of the brokered one-click connect (`spawn/origin_broker.ts`
 * is the parent's). A child holds no OAuth application: it asks its parent
 * which origins the parent can sign people in to, sends the browser there with
 * a state of its own and a PKCE challenge, and redeems what comes back
 * server to server.
 *
 * What the child keeps: a flow row bound to the person who clicked (the state
 * only as a digest, the verifier sealed), and in the end the token, sealed
 * exactly as a pasted one is, through the same `completeConnect`. What it
 * never holds: a client secret, or the parent's key to anything but this one
 * call. A refresh asks the parent again (`refreshViaParent`).
 *
 * Every call is signed with the key spawn gave both sides (the heartbeat key,
 * `parent.json`) over the exact bytes sent, and rides the parent's door
 * when this forge is in a cell, its public address otherwise (`beatBase`).
 */

import type { App } from "../app.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { createLog } from "../kernel/log.ts";
import {
  BROKER_CALL,
  BROKER_CALLBACK,
  BROKER_START,
  signWith,
  startText,
  type BrokerFailure,
  type BrokerOffer,
} from "../spawn/origin_broker_wire.ts";
import { beatBase, parentLink, SIGNATURE_HEADER } from "../spawn/heartbeat.ts";
import { hostnameOf } from "./operator.ts";
import type { OriginKind } from "./types.ts";
import { type OAuthFailure, type TokenSet } from "./oauth.ts";

const log = createLog("origins");

/** What a brokered flow carries in `redirect_uri`, so no other path mistakes it for an ordinary one. */
export const BROKERED = "via-parent";

/** The key an origin's cursor holds when its token came through the parent, so a refresh goes there too. */
export const VIA_PARENT = "via_parent";

const OFFERS_TTL_MS = 5 * 60_000;
const OFFERS_MISS_MS = 30_000;
const CALL_TIMEOUT_MS = 10_000;
const OFFERS_WAIT_MS = 3_000;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The parent said no, or could not be asked. `error` is a short code; nothing in it is a secret. */
export interface BrokerRefusal {
  readonly error: string;
}

/**
 * One signed call to the parent. A parent that does not answer, or answers
 * anything but a well-formed `{ ok: true }`, is a refusal with a code.
 */
export async function callParent(
  app: App,
  op: string,
  fields: Record<string, unknown> = {},
  fetcher: FetchLike = fetch,
  timeoutMs: number = CALL_TIMEOUT_MS,
): Promise<Result<Record<string, unknown>, BrokerRefusal>> {
  const link = await parentLink(app);
  if (link === undefined) return err({ error: "no_parent" });
  const body = JSON.stringify({
    ...fields,
    op,
    name: link.name,
    at: Date.now(),
  });
  let res: Response;
  try {
    res = await fetcher(`${beatBase(link.upstream)}${BROKER_CALL}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signWith(link.key, body),
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch {
    return err({ error: "unreachable" });
  }
  if (!res.ok)
    return err({ error: res.status === 404 ? "not_a_child" : "unreachable" });
  try {
    const doc = (await res.json()) as unknown;
    if (typeof doc !== "object" || doc === null || Array.isArray(doc))
      return err({ error: "invalid_response" });
    const d = doc as Record<string, unknown>;
    return d["ok"] === true
      ? ok(d)
      : err({
          error:
            typeof d["error"] === "string"
              ? (d["error"] as string).slice(0, 40)
              : "refused",
        });
  } catch {
    return err({ error: "invalid_response" });
  }
}

// ---- what the parent can broker ----

interface Held {
  readonly at: number;
  readonly offers: readonly BrokerOffer[];
  /** Cached from a failure: asked again sooner. */
  readonly miss: boolean;
}

const held = new WeakMap<App, Held>();

const KINDS = new Set(["github", "forgejo"]);

function readOffers(doc: unknown): BrokerOffer[] {
  if (!Array.isArray(doc)) return [];
  return doc.flatMap((o): BrokerOffer[] => {
    if (typeof o !== "object" || o === null) return [];
    const { host, kind, name } = o as Record<string, unknown>;
    if (typeof host !== "string" || !/^[a-z0-9.-]{1,253}$/.test(host))
      return [];
    if (typeof kind !== "string" || !KINDS.has(kind)) return [];
    if (typeof name !== "string" || name === "" || name.length > 80) return [];
    return [{ host, kind: kind as BrokerOffer["kind"], name }];
  });
}

/**
 * The origins the parent will broker for this forge, asked of it at most
 * every five minutes (thirty seconds after a failure). Empty for a forge with
 * no parent, a parent that brokers nothing, and a parent that cannot be
 * reached: the page then offers what it always did.
 */
export async function brokerOffers(
  app: App,
  fetcher?: FetchLike,
): Promise<readonly BrokerOffer[]> {
  const now = Date.now();
  const kept = held.get(app);
  if (
    kept !== undefined &&
    now - kept.at < (kept.miss ? OFFERS_MISS_MS : OFFERS_TTL_MS)
  )
    return kept.offers;
  if ((await parentLink(app)) === undefined) {
    held.set(app, { at: now, offers: [], miss: false });
    return [];
  }
  // The page waits on this: a parent that does not answer in a moment has no button, and is asked again soon.
  const asked = await callParent(app, "offers", {}, fetcher, OFFERS_WAIT_MS);
  const next: Held = asked.ok
    ? { at: now, offers: readOffers(asked.value["offers"]), miss: false }
    : { at: now, offers: [], miss: true };
  held.set(app, next);
  return next.offers;
}

/** What the last answer said, without asking: the page renders from this after `brokerOffers` has run. */
export const knownOffers = (app: App): readonly BrokerOffer[] =>
  held.get(app)?.offers ?? [];

/** Forget what was heard, so the next look asks again: the parent stopped offering what it had. */
export const forgetOffers = (app: App): void => void held.delete(app);

/** The offer for a host a person named (`github`, `git.example`, `https://git.example/`), if the parent made one. */
export function offerFor(
  offers: readonly BrokerOffer[],
  typed: string,
): BrokerOffer | undefined {
  const t = typed.trim().toLowerCase();
  const host = t === "github" ? "github.com" : hostnameOf(t);
  return host === "" ? undefined : offers.find((o) => o.host === host);
}

// ---- the start ----

export interface DeviceGrant {
  readonly clientId: string;
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly intervalSecs: number;
  readonly expiresInSecs: number;
  readonly webUrl: string;
}

/** Ask the parent to begin a device grant for this host; the child polls the provider itself. */
export async function deviceGrant(
  app: App,
  host: string,
  kind: OriginKind,
  fetcher?: FetchLike,
): Promise<Result<DeviceGrant, BrokerRefusal>> {
  const asked = await callParent(app, "device", { host, kind }, fetcher);
  if (!asked.ok) return asked;
  const d = asked.value;
  const s = (k: string): string =>
    typeof d[k] === "string" ? (d[k] as string) : "";
  const n = (k: string): number =>
    typeof d[k] === "number" && Number.isFinite(d[k]) ? (d[k] as number) : 0;
  const grant = {
    clientId: s("clientId"),
    deviceCode: s("deviceCode"),
    userCode: s("userCode"),
    verificationUri: s("verificationUri"),
    intervalSecs: Math.max(n("intervalSecs"), 1),
    expiresInSecs: n("expiresInSecs") || 900,
    webUrl: s("webUrl"),
  };
  // What the parent hands over is checked as what it says it is: for this host, and for a person to type a code into.
  if (
    grant.clientId === "" ||
    grant.deviceCode === "" ||
    grant.userCode === "" ||
    hostnameOf(grant.webUrl) !== host
  )
    return err({ error: "invalid_response" });
  if (!/^https:\/\//.test(grant.verificationUri))
    return err({ error: "invalid_response" });
  return ok(grant);
}

/**
 * Where this forge sends the browser to sign in through the parent: its start
 * URL, with the child's name, the host, the state, the challenge, the one
 * return path, the time, and the signature over all of it. Undefined when
 * there is no parent.
 */
export async function startUrl(
  app: App,
  input: { host: string; state: string; challenge: string },
  now: number = Date.now(),
): Promise<string | undefined> {
  const link = await parentLink(app);
  if (link === undefined) return undefined;
  const parts = {
    child: link.name,
    host: input.host,
    state: input.state,
    challenge: input.challenge,
    path: BROKER_CALLBACK,
    at: now,
  };
  const url = new URL(`${link.upstream}${BROKER_START}`);
  url.searchParams.set("child", parts.child);
  url.searchParams.set("target", parts.host);
  url.searchParams.set("state", parts.state);
  url.searchParams.set("challenge", parts.challenge);
  url.searchParams.set("path", parts.path);
  url.searchParams.set("at", String(parts.at));
  url.searchParams.set("sig", signWith(link.key, startText(parts)));
  return url.toString();
}

// ---- the end ----

/** What the parent hands back once the code is redeemed. */
export interface Redeemed {
  readonly tokens: TokenSet;
  readonly webUrl: string;
}

/** Trade the one-time code and the verifier for the person's tokens. */
export async function redeemCode(
  app: App,
  input: { code: string; verifier: string; host: string },
  fetcher?: FetchLike,
): Promise<Result<Redeemed, BrokerRefusal>> {
  const asked = await callParent(
    app,
    "redeem",
    { code: input.code, verifier: input.verifier },
    fetcher,
  );
  if (!asked.ok) return asked;
  const d = asked.value;
  const accessToken =
    typeof d["accessToken"] === "string" ? d["accessToken"] : "";
  const webUrl = typeof d["webUrl"] === "string" ? d["webUrl"] : "";
  if (accessToken === "" || hostnameOf(webUrl) !== input.host)
    return err({ error: "invalid_response" });
  return ok({ tokens: tokenSetOf(d), webUrl });
}

function tokenSetOf(d: Record<string, unknown>): TokenSet {
  const s = (k: string): string =>
    typeof d[k] === "string" ? (d[k] as string) : "";
  const exp = d["expiresAt"];
  return {
    accessToken: s("accessToken"),
    refreshToken: s("refreshToken"),
    expiresAt:
      typeof exp === "string" && !Number.isNaN(Date.parse(exp)) ? exp : null,
    scope: s("scope"),
  };
}

/**
 * A refresh the parent does, because the secret is its. The same signature,
 * the refresh token in the body and nothing stored on the other side.
 */
export async function refreshViaParent(
  app: App,
  input: { host: string; refreshToken: string },
  fetcher?: FetchLike,
): Promise<Result<TokenSet, OAuthFailure>> {
  const asked = await callParent(app, "refresh", input, fetcher);
  if (!asked.ok) {
    log.warn("origin refresh through the parent failed", {
      reason: asked.error.error,
    });
    return err({
      error:
        asked.error.error === "invalid_grant" ? "invalid_grant" : "unreachable",
      message: `the parent could not refresh this origin: ${asked.error.error}`,
    });
  }
  const tokens = tokenSetOf(asked.value);
  if (tokens.accessToken === "")
    return err({
      error: "invalid_response",
      message: "the parent sent no access token",
    });
  return ok(tokens);
}

/** The words a child shows for the ways a brokered sign-in ends without a code. */
export const FAILURE_WORDS: Readonly<Record<BrokerFailure, string>> = {
  denied: "You said no, so nothing was connected.",
  expired: "That sign-in took too long. Nothing was connected. Start again.",
  browser:
    "That sign-in finished in a different browser than it began in. Nothing was connected. Start again.",
  exchange: "The sign-in did not finish. Nothing was connected. Start again.",
  refused:
    "That account is not one this forge's host accepts. Sign in with your everyday, non-admin account and try again.",
  failed: "The sign-in did not finish. Nothing was connected. Start again.",
};
