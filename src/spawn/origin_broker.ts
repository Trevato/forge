/**
 * The one-click connect, brokered for the forges this forge hosts.
 *
 * A hosted child holds no OAuth application, and cannot borrow this forge's:
 * a client id is registered for this forge's address, and the provider sends
 * the browser back only there. So this forge is the OAuth client and the child
 * receives the one thing that is its person's, their token.
 *
 * Two shapes, because the providers differ (`origins/oauth.ts`):
 *
 * - GitHub runs the device grant: no redirect, no secret, only the public
 *   client id. This forge starts the grant and hands the child the device
 *   code; the child polls GitHub itself. The token never reaches this forge.
 * - Forgejo and Gitea run the code flow with PKCE, and the redirect is this
 *   forge's own callback. The browser goes to `GET /broker/origins/start`
 *   with a start the child signed; this forge runs the authorize and the
 *   callback, and does not keep what comes back: the tokens are sealed for at
 *   most `CODE_TTL_MS` against a one-time code, the browser is sent to the
 *   child's address with that code and the child's own state, and the child
 *   redeems it here, server to server, with the verifier whose challenge it
 *   gave and its signature. The row is spent and blanked in the same step.
 *
 * What the child proves, and with what: the key spawn gave both sides, the
 * heartbeat key (`beatKeyOf`), as HMAC-SHA256 over the exact bytes of a call
 * or over the canonical text of a start. A name this forge did not make, a
 * bad signature and a stale time are all the same answer. The return address
 * is never taken from a request: it is the child's public address, derived
 * from its name, plus the one callback path (`BROKER_CALLBACK`).
 *
 * Refresh needs the client secret where the provider issues expiring tokens,
 * so the child asks here (`op: "refresh"`) and gets the new pair back; this
 * forge stores nothing. It does not ask whether the token came through this
 * door: a refresh token is the proof of the grant, the provider binds it to
 * this client id, and a token issued to another client is refused by the
 * provider. All a child could do with the call is refresh what it already holds.
 */

import { timingSafeEqual } from "node:crypto";
import type { App } from "../app.ts";
import { childNamed, beatKeyOf, liveChildUrl } from "../actions/spawn.ts";
import { childOriginHosts } from "../core/capacity.ts";
import { isChildName } from "../core/proposal_token.ts";
import { hostAllowed } from "../apps/egress.ts";
import { cookieValue, type Ctx } from "../http/context.ts";
import { secureFor } from "../http/cookie_secure.ts";
import { sha256 } from "../kernel/hash.ts";
import { id as newId, secret as randomSecret } from "../kernel/id.ts";
import { open, seal } from "../kernel/secret.ts";
import { discover } from "../origins/discover.ts";
import type { Discovered } from "../origins/types.ts";
import {
  authorizeUrl,
  exchangeCode,
  flowFor,
  newState,
  operatorClientId,
  refresh,
  s256,
  scopesFor,
  startDevice,
  type AppRegistration,
  type TokenSet,
} from "../origins/oauth.ts";
import {
  checkCredential,
  hostnameOf,
  operatorHosts,
} from "../origins/operator.ts";
import { providerFor } from "../origins/providers/index.ts";
import { staticCredential, type OriginKind } from "../origins/types.ts";
import { during } from "../perf/jobs.ts";
import { enter, noteBad } from "./door_guard.ts";
import {
  BROKER_CALLBACK,
  signWith,
  startText,
  type BrokerFailure,
  type BrokerOffer,
} from "./origin_broker_wire.ts";
import { parentOrigin } from "./placement.ts";

/** A token waits for its child this long, and not a second more. */
export const CODE_TTL_MS = 60_000;
/** The person's time to say yes at the provider. */
export const CONSENT_TTL_MS = 10 * 60_000;
/** A start the child signed is good this long. */
export const START_SKEW_MS = 5 * 60_000;
/** A signed call is good this far either side of this forge's clock. */
export const CALL_SKEW_MS = 2 * 60_000;
export const CALL_BODY_MAX = 16 * 1024;
/** Unfinished sign-ins one child may have waiting here. */
const PENDING_MAX = 20;
/** Calls one child may make a minute. */
const CALLS_PER_MINUTE = 60;

export const BROKER_COOKIE = "forge_broker";

type Env = Record<string, string | undefined>;

/**
 * The origins this forge holds an OAuth application for: GitHub when it has a
 * client id, and each host the operator registered one for. Brokering is on
 * exactly when these exist; nothing is configured for it.
 */
export function brokerOffers(env: Env = process.env): BrokerOffer[] {
  const out: BrokerOffer[] = [];
  if ((env.FORGE_GITHUB_CLIENT_ID ?? "").trim() !== "")
    out.push({ host: "github.com", kind: "github", name: "GitHub" });
  // Which grant a host runs is found when it is asked for, as the forge's own sign-in finds it (`flowFor`).
  for (const host of operatorHosts(env))
    if (host !== "github.com") out.push({ host, kind: "forgejo", name: host });
  return out;
}

/** What a test may stand in for: the clock, and the look at a host. */
export interface BrokerDeps {
  readonly now?: number;
  readonly discover?: typeof discover;
  /** The environment the applications are read from; the process's own by default. */
  readonly env?: Env;
}

/**
 * The application this forge signs people in with at a host: the operator's
 * for that host, else GitHub's for github.com: the same two the forge's own
 * sign-in uses (`appFor`), and none a person registered, which are theirs.
 */
function registrationFor(
  found: Discovered,
  host: string,
  env: Env = process.env,
): AppRegistration | undefined {
  const software = found.software === "forge" ? "forge" : "";
  const base = { kind: found.kind, apiUrl: found.apiUrl, webUrl: found.webUrl, software };
  const own = operatorClientId(env, found.apiUrl);
  if (own !== undefined) return { ...base, clientId: own, clientSecret: "" };
  const github = (env.FORGE_GITHUB_CLIENT_ID ?? "").trim();
  if (found.kind === "github" && host === "github.com" && github !== "")
    return { ...base, clientId: github, clientSecret: (env.FORGE_GITHUB_CLIENT_SECRET ?? "").trim() };
  return undefined;
}

/**
 * What one child is offered: a child in a cell is offered only the hosts its
 * cell can reach (`childOriginHosts`), since a button that ends at the gate is
 * worse than none.
 */
export async function offersFor(
  app: App,
  name: string,
  env: Env = process.env,
): Promise<BrokerOffer[]> {
  const offers = brokerOffers(env);
  if (offers.length === 0) return [];
  const child = await childNamed(app, name);
  if (child === undefined) return [];
  if (child.placement !== "cell") return offers;
  const reach = childOriginHosts(app.db, parentOrigin(app.config));
  return offers.filter((o) => hostAllowed(reach, o.host, 443));
}

// ---- what a child signs ----

function sameHex(shown: string | null, want: string): boolean {
  if (shown === null || !/^[0-9a-f]{64}$/.test(shown)) return false;
  return timingSafeEqual(Buffer.from(shown), Buffer.from(want));
}

// ---- pruning ----

/** Delete what is spent, expired, or abandoned; the token goes with the row. */
export function pruneBroker(app: App, now: number = Date.now()): void {
  app.db
    .query(
      "DELETE FROM origin_broker WHERE expires_at < ?1 OR status = 'spent'",
    )
    .run(new Date(now).toISOString());
}

/** The sweep after a code's minute; a forge that closed meanwhile has nothing to sweep. */
function sweepBroker(app: App): void {
  try {
    pruneBroker(app);
  } catch {
    // closed: its database went with it
  }
}

// ---- the browser's start ----

const NOT_VALID = (): Response =>
  new Response(
    "This sign-in link is not valid. Go back to your forge and start again.",
    {
      status: 400,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    },
  );

const STATE = /^[A-Za-z0-9_-]{16,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

/**
 * `GET /broker/origins/start`: the person's browser, sent by their child. `redirectUri` is
 * this forge's own callback, which the provider has registered. The
 * start must be one the named child signed; the return address is derived from
 * the name; the provider is one this forge holds an application for. Anything
 * else is the same refusal, and nothing was stored.
 */
export async function brokerStart(
  ctx: Ctx,
  redirectUri: string,
  deps: BrokerDeps = {},
): Promise<Response> {
  const now = deps.now ?? Date.now();
  const q = ctx.url.searchParams;
  const child = q.get("child") ?? "";
  const host = (q.get("target") ?? "").toLowerCase();
  const state = q.get("state") ?? "";
  const challenge = q.get("challenge") ?? "";
  const path = q.get("path") ?? "";
  const at = Number(q.get("at"));
  const sig = q.get("sig");
  if (
    !isChildName(child) ||
    !HOST.test(host) ||
    !STATE.test(state) ||
    !CHALLENGE.test(challenge)
  )
    return NOT_VALID();
  if (
    path !== BROKER_CALLBACK ||
    !Number.isSafeInteger(at) ||
    Math.abs(now - at) > START_SKEW_MS
  )
    return NOT_VALID();
  const app = ctx.app;
  const key = await beatKeyOf(app, child);
  if (
    key === undefined ||
    !sameHex(
      sig,
      signWith(key, startText({ child, host, state, challenge, path, at })),
    )
  ) {
    noteBad(app);
    return NOT_VALID();
  }
  const offer = (await offersFor(app, child, deps.env)).find((o) => o.host === host);
  if (offer === undefined) return NOT_VALID();
  if (redirectUri === "") return NOT_VALID();

  const found = await (deps.discover ?? discover)({ host });
  if (
    !found.ok ||
    flowFor(found.value.kind) !== "code" ||
    hostnameOf(found.value.webUrl) !== host
  )
    return NOT_VALID();
  const registration = registrationFor(found.value, host, deps.env);
  if (registration === undefined) return NOT_VALID();
  const { clientId } = registration;
  const software = registration.software ?? "";

  pruneBroker(app, now);
  const waiting =
    app.db
      .query<
        { n: number },
        [string]
      >("SELECT COUNT(*) AS n FROM origin_broker WHERE child = ?1 AND status = 'pending'")
      .get(child)?.n ?? 0;
  if (waiting >= PENDING_MAX) return NOT_VALID();

  const rowId = newId();
  const own = newState();
  const cookie = randomSecret();
  const verifier = `${randomSecret()}${randomSecret()}`.slice(0, 96);
  const dataDir = app.config.dataDir;
  try {
    app.db
      .query(
        `INSERT INTO origin_broker (id, child, host, kind, api_url, web_url, software, client_id, state_hash, cookie_hash,
           child_state_enc, child_state_hash, challenge, verifier_enc, redirect_uri, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
      )
      .run(
        rowId,
        child,
        host,
        found.value.kind,
        found.value.apiUrl,
        found.value.webUrl,
        software,
        clientId,
        sha256(own),
        sha256(cookie),
        seal(dataDir, state, rowId),
        sha256(state),
        challenge,
        seal(dataDir, verifier, rowId),
        redirectUri,
        new Date(now + CONSENT_TTL_MS).toISOString(),
      );
  } catch {
    // The same child state twice: a replayed start, which gets nothing.
    return NOT_VALID();
  }
  const url = authorizeUrl(registration, {
    state: own,
    challenge: s256(verifier),
    redirectUri,
    scope: scopesFor(found.value.kind, "oauth", software),
  });
  const secure = secureFor(ctx.url, app.config.url) ? "; Secure" : "";
  return new Response(null, {
    status: 303,
    headers: {
      location: url,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "set-cookie": `${BROKER_COOKIE}=${cookie}; Path=/settings/origins; HttpOnly; SameSite=Lax; Max-Age=${CONSENT_TTL_MS / 1000}${secure}`,
    },
  });
}

// ---- the provider's callback ----

interface Row {
  id: string;
  child: string;
  host: string;
  kind: OriginKind;
  api_url: string;
  web_url: string;
  software: string;
  client_id: string;
  cookie_hash: string;
  child_state_enc: string;
  child_state_hash: string;
  challenge: string;
  verifier_enc: string;
  redirect_uri: string;
  status: "pending" | "ready" | "spent";
  code_hash: string | null;
  token_enc: string;
  expires_at: string;
}

/**
 * The provider's callback, when its state is one of this forge's brokered
 * sign-ins; undefined otherwise, and the ordinary callback goes on. Claimed
 * once: the state is cleared in the statement that finds it. The tokens are
 * checked as the person's own parent flow would check them (`whoami`, the
 * operator's guard), sealed against a fresh code, and the browser goes to the
 * child's address with the code and the child's state, nothing else.
 */
export async function brokerCallback(
  ctx: Ctx,
  deps: BrokerDeps = {},
): Promise<Response | undefined> {
  const now = deps.now ?? Date.now();
  const app = ctx.app;
  const state = ctx.url.searchParams.get("state") ?? "";
  if (state === "") return undefined;
  const row = app.db
    .query<
      Row,
      [string]
    >(`UPDATE origin_broker SET state_hash = NULL WHERE state_hash = ?1 AND status = 'pending' RETURNING *`)
    .get(sha256(state));
  if (row === null) return undefined;

  const dataDir = app.config.dataDir;
  const childState = open(dataDir, row.child_state_enc, row.id);
  const back = (
    outcome: { code: string } | { failure: BrokerFailure },
  ): Response => {
    app.db
      .query("DELETE FROM origin_broker WHERE id = ?1 AND status != 'ready'")
      .run(row.id);
    const to = new URL(`${liveChildUrl(app, row.child)}${BROKER_CALLBACK}`);
    if (childState.ok) to.searchParams.set("state", childState.value);
    if ("code" in outcome) to.searchParams.set("code", outcome.code);
    else to.searchParams.set("error", outcome.failure);
    return new Response(null, {
      status: 303,
      headers: {
        location: to.toString(),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "set-cookie": clearCookie(ctx),
      },
    });
  };

  if (Date.parse(row.expires_at) <= now) return back({ failure: "expired" });
  // The browser that finishes is the browser that began: a callback carried to another one is refused.
  const cookie = cookieValue(ctx.request, BROKER_COOKIE) ?? "";
  if (cookie === "" || !sameHex(sha256(cookie), row.cookie_hash))
    return back({ failure: "browser" });
  const code = ctx.url.searchParams.get("code") ?? "";
  if (code === "")
    return back({
      failure:
        ctx.url.searchParams.get("error") === "access_denied"
          ? "denied"
          : "failed",
    });
  const verifier = open(dataDir, row.verifier_enc, row.id);
  if (!verifier.ok || !childState.ok) return back({ failure: "failed" });

  const registration: AppRegistration = {
    kind: row.kind,
    apiUrl: row.api_url,
    webUrl: row.web_url,
    clientId: row.client_id,
    clientSecret: "",
    software: row.software,
  };
  const exchanged = await exchangeCode(registration, {
    code,
    verifier: verifier.value,
    redirectUri: row.redirect_uri,
  });
  if (!exchanged.ok) return back({ failure: "exchange" });

  const provider = providerFor(
    staticCredential({
      kind: row.kind,
      apiUrl: row.api_url,
      webUrl: row.web_url,
      authKind: "oauth",
      software: row.software,
      token: exchanged.value.accessToken,
    }),
  );
  const identity = await provider.whoami();
  if (!identity.ok) return back({ failure: "exchange" });
  const guard = await checkCredential(provider, identity.value, deps.env);
  if (!guard.ok) {
    app.bus.append({
      kind: "origin.brokered.refused",
      payload: {
        child: row.child,
        host: row.host,
        login: identity.value.login,
      },
    });
    return back({ failure: "refused" });
  }

  const oneTime = randomSecret();
  const ready = app.db
    .query(
      `UPDATE origin_broker SET status = 'ready', code_hash = ?1, token_enc = ?2, expires_at = ?3, verifier_enc = ''
       WHERE id = ?4 AND status = 'pending'`,
    )
    .run(
      sha256(oneTime),
      seal(dataDir, JSON.stringify(exchanged.value), row.id),
      new Date(now + CODE_TTL_MS).toISOString(),
      row.id,
    );
  if (ready.changes !== 1) return back({ failure: "failed" });
  // A token waits a minute, not until somebody next asks: its row is swept when its time is up.
  setTimeout(
    () => void during("origin-broker-sweep", () => sweepBroker(app)),
    CODE_TTL_MS + 1_000,
  ).unref();
  // The audit names who and where. Never a token, never the code.
  app.bus.append({
    kind: "origin.brokered",
    payload: {
      child: row.child,
      host: row.host,
      kind: row.kind,
      login: identity.value.login,
    },
  });
  return back({ code: oneTime });
}

const clearCookie = (ctx: Ctx): string =>
  `${BROKER_COOKIE}=; Path=/settings/origins; HttpOnly; SameSite=Lax; Max-Age=0${secureFor(ctx.url, ctx.app.config.url) ? "; Secure" : ""}`;

// ---- the child's signed calls ----

type Reply = Record<string, unknown>;

const refused = (): Response => new Response("no such door", { status: 404 });
const reply = (body: Reply): Response =>
  Response.json(body, { headers: { "cache-control": "no-store" } });
const calls = new WeakMap<App, Map<string, number[]>>();

function tooMany(app: App, child: string, now: number): boolean {
  const byChild = calls.get(app) ?? new Map<string, number[]>();
  calls.set(app, byChild);
  const recent = (byChild.get(child) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  byChild.set(child, recent);
  return recent.length > CALLS_PER_MINUTE;
}

/**
 * One signed call from a child: `POST /api/v1/broker/origins` on the public
 * API or on the beat door. A bad name, signature or time is the same 404 and
 * counts against the guard; a good one answers 200 with `{ ok }`, and the
 * reason in `error` when it is false.
 */
export async function answerBrokerCall(
  app: App,
  raw: string,
  signature: string | null,
  deps: BrokerDeps = {},
): Promise<Response> {
  const now = deps.now ?? Date.now();
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return refused();
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc))
    return refused();
  const d = doc as Record<string, unknown>;
  const name = d["name"];
  const at = d["at"];
  if (
    typeof name !== "string" ||
    !isChildName(name) ||
    typeof at !== "number" ||
    !Number.isSafeInteger(at)
  )
    return refused();
  const key = await beatKeyOf(app, name);
  if (
    key === undefined ||
    !sameHex(signature, signWith(key, raw)) ||
    Math.abs(now - at) > CALL_SKEW_MS
  ) {
    noteBad(app);
    return refused();
  }
  if (tooMany(app, name, now)) return reply({ ok: false, error: "slow_down" });
  pruneBroker(app, now);

  const op = d["op"];
  if (op === "offers")
    return reply({ ok: true, offers: await offersFor(app, name, deps.env) });
  const host = typeof d["host"] === "string" ? d["host"].toLowerCase() : "";
  const offer = (await offersFor(app, name, deps.env)).find((o) => o.host === host);
  if (op === "device")
    return reply(await deviceStart(offer, d["kind"] === "github", deps));
  if (op === "redeem")
    return reply(redeem(app, name, str(d["code"]), str(d["verifier"]), now));
  if (op === "refresh")
    return reply(await refreshFor(app, name, offer, str(d["refreshToken"]), deps));
  return reply({ ok: false, error: "unknown_op" });
}

const str = (v: unknown): string =>
  typeof v === "string" && v.length <= 4096 ? v : "";

async function deviceStart(
  offer: BrokerOffer | undefined,
  github: boolean,
  deps: BrokerDeps,
): Promise<Reply> {
  if (offer === undefined) return { ok: false, error: "not_offered" };
  // A GitHub Enterprise host looks like no other forge from outside: the child, which was told, says so.
  const found = await (deps.discover ?? discover)({
    host: offer.host,
    ...(offer.kind === "github" || github ? { kind: "github" as const } : {}),
  });
  if (!found.ok) return { ok: false, error: "unreachable" };
  if (flowFor(found.value.kind) !== "device") return { ok: false, error: "not_offered" };
  const registration = registrationFor(found.value, offer.host, deps.env);
  if (registration === undefined) return { ok: false, error: "not_offered" };
  const started = await startDevice(
    // Polling a device grant takes no secret, so none is sent out of this forge.
    { ...registration, clientSecret: "" },
    scopesFor(found.value.kind),
  );
  if (!started.ok) return { ok: false, error: "provider_refused" };
  // The device code is the child's to poll with: this forge keeps nothing of the grant.
  return {
    ok: true,
    clientId: registration.clientId,
    ...started.value,
    kind: found.value.kind,
    apiUrl: found.value.apiUrl,
    webUrl: found.value.webUrl,
  };
}

/**
 * Hand the tokens over, once. The code, the child's name and the child's
 * verifier must all agree. A code another child presents finds nothing and is
 * not spent; a right child's wrong verifier or late call spends it. The row is
 * deleted by the next prune, and its token is blank from this statement on.
 */
function redeem(
  app: App,
  child: string,
  code: string,
  verifier: string,
  now: number,
): Reply {
  if (code === "" || verifier === "")
    return { ok: false, error: "invalid_code" };
  const row = app.db.transaction((): Row | undefined => {
    const found = app.db
      .query<
        Row,
        [string, string]
      >("SELECT * FROM origin_broker WHERE code_hash = ?1 AND child = ?2 AND status = 'ready'")
      .get(sha256(code), child);
    if (found === null) return undefined;
    const spent = app.db
      .query(
        "UPDATE origin_broker SET status = 'spent', token_enc = '', code_hash = NULL WHERE id = ?1 AND status = 'ready'",
      )
      .run(found.id);
    return spent.changes === 1 ? found : undefined;
  })();
  if (row === undefined || Date.parse(row.expires_at) <= now)
    return { ok: false, error: "invalid_code" };
  const shown = Buffer.from(s256(verifier));
  const want = Buffer.from(row.challenge);
  if (shown.length !== want.length || !timingSafeEqual(shown, want))
    return { ok: false, error: "invalid_code" };
  const opened = open(app.config.dataDir, row.token_enc, row.id);
  if (!opened.ok) return { ok: false, error: "invalid_code" };
  const tokens = JSON.parse(opened.value) as TokenSet;
  return { ok: true, host: row.host, webUrl: row.web_url, ...tokens };
}

async function refreshFor(
  app: App,
  child: string,
  offer: BrokerOffer | undefined,
  token: string,
  deps: BrokerDeps,
): Promise<Reply> {
  if (offer === undefined || token === "" || /[\x00-\x20\x7f]/.test(token))
    return { ok: false, error: "not_offered" };
  const found = await (deps.discover ?? discover)({
    host: offer.host,
    ...(offer.kind === "github" ? { kind: "github" as const } : {}),
  });
  if (!found.ok) return { ok: false, error: "unreachable" };
  const registration = registrationFor(found.value, offer.host, deps.env);
  if (registration === undefined) return { ok: false, error: "not_offered" };
  const release = enter(app, `broker:${child}`);
  if (release === undefined) return { ok: false, error: "slow_down" };
  try {
    const next = await refresh(registration, token);
    if (!next.ok)
      return { ok: false, error: next.error.error === "invalid_grant" ? "invalid_grant" : next.error.error };
    app.bus.append({ kind: "origin.brokered.refreshed", payload: { child, host: offer.host } });
    return { ok: true, ...next.value };
  } finally {
    release();
  }
}
