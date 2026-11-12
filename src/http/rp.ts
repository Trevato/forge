/**
 * Sign in through the parent forge (#748): this forge as a relying party of
 * the OpenID provider its parent already is. `/signin/parent` registers
 * this forge at the parent once (the client id is kept), then sends the
 * person there with a state, a nonce and a PKCE challenge; the state also
 * rides in an HttpOnly cookie so only the browser that began can finish.
 * `/signin/parent/callback` trades the code, checks the id_token (state,
 * nonce, iss, aud, exp, signature against the parent's JWKS) and signs in
 * the local account the parent's `sub` is linked to; a `sub` nobody here
 * holds makes no account and ends on `/signup`.
 * Both are GETs that change nothing a stranger could use: a callback with
 * no matching cookie and state is refused before anything is fetched.
 */
import { secureFor } from "./cookie_secure.ts";
import { createHash, randomBytes } from "node:crypto";
import type { App } from "../app.ts";
import {
  linkedAccount,
  clientFor,
  keepClient,
  parentIssuerOf,
  SUB,
  startLogin,
  takeLogin,
  CALLBACK_PATH,
  linkParent,
} from "../core/federation.ts";
import { retryAfterOf } from "./respond.ts";
import { readCapped } from "../origins/providers/http.ts";
import { clientAddress } from "./peer.ts";
import { signinAllowed } from "../web/pages/site.ts";
import { createSession } from "../core/sessions.ts";
import { SIGNIN_EXPIRED, SIGNIN_NOT_THIS_BROWSER } from "../kernel/signin_words.ts";
import { verifyJwt } from "../kernel/jwt.ts";
import { html } from "../web/html.ts";
import { flashTo, page, redirect } from "../web/layout.ts";
import { readForm } from "../web/form.ts";
import { signInFirst } from "../web/chrome.ts";
import { sessionCookie } from "../web/pages/site.ts";
import { cookieValue, type Ctx } from "./context.ts";
import { KeySet } from "./jwks.ts";
import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../core/route_timing.ts";

export const STATE_COOKIE = "forge_rp";
const SCOPE = "openid profile";
const rand = (bytes: number): string => randomBytes(bytes).toString("base64url");

const parentIssuer = (app: App): string | undefined => parentIssuerOf(app.config);

const keySets = new WeakMap<App, Map<string, KeySet>>();
const keysOf = (app: App, issuer: string): KeySet => {
  let sets = keySets.get(app);
  if (sets === undefined) keySets.set(app, (sets = new Map()));
  let set = sets.get(issuer);
  if (set === undefined) sets.set(issuer, (set = new KeySet(`${issuer}/oauth/jwks`)));
  return set;
};

/** What the parent may say in one answer: a client id or a token is small. */
const ANSWER_MAX = 16 * 1024;

/** The parent's JSON answer, read by bytes and refused past the cap. */
async function answerOf(res: Response): Promise<Record<string, unknown>> {
  const text = await readCapped(res, ANSWER_MAX, AbortSignal.timeout(5000));
  if (text === undefined) throw new Error("the parent's answer was too large");
  const body: unknown = JSON.parse(text);
  if (typeof body !== "object" || body === null) throw new Error("the parent's answer was not an object");
  return body as Record<string, unknown>;
}

const redirectUriOf = (ctx: Ctx): string => `${ctx.url.origin}${CALLBACK_PATH}`;

/** The client id at the issuer for this address, registering once if there is none. */
const registering = new Map<string, Promise<string>>();
async function clientId(ctx: Ctx, issuer: string, redirectUri: string): Promise<string> {
  const known = clientFor(ctx.app.db, issuer, redirectUri);
  if (known !== undefined) return known;
  const key = `${issuer}\0${redirectUri}`;
  let pending = registering.get(key);
  if (pending === undefined) {
    pending = (async () => {
      const res = await fetch(`${issuer}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: ctx.url.host.slice(0, 100),
          redirect_uris: [redirectUri],
        }),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      const body = await answerOf(res);
      if (res.status !== 201 || typeof body.client_id !== "string" || body.client_id === "")
        throw new Error(`registration refused (${res.status})`);
      return keepClient(ctx.app.db, issuer, redirectUri, body.client_id);
    })();
    registering.set(key, pending);
    void pending.then(
      () => registering.delete(key),
      () => registering.delete(key),
    );
  }
  return pending;
}

function failure(ctx: Ctx, message: string, status: number): Response {
  const response = timePhase(ctx.request, "render", () =>
    page(
      {
        ctx,
        title: "Sign in",
        body: html`<div class="narrow">
          <div class="page-head"><h1>Could not sign you in</h1></div>
          <p role="alert">${message}</p>
          <p><a href="/signin">Back to sign in</a></p>
        </div>`,
      },
      status,
    ),
  );
  response.headers.set("cache-control", "no-store");
  return response;
}

export const cookieHeader = (value: string, maxAge: number, url: URL, forgeUrl?: string): string => {
  const secure = secureFor(url, forgeUrl) ? "; Secure" : "";
  return `${STATE_COOKIE}=${value}; Path=/signin/parent; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
};

export const parentStart = (ctx: Ctx): Promise<Response> => begin(ctx);

/** POST /settings/parent/link: the same round trip, begun by a signed-in person to link, not to sign in. */
export async function parentLinkStart(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  return begin(ctx, ctx.auth.user.id);
}

async function begin(ctx: Ctx, linkUser?: string): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const issuer = parentIssuer(ctx.app);
  if (issuer === undefined) return failure(ctx, "This forge has no parent to sign in through.", 404);
  // Each start writes a row and the table is bounded: a flood must not push
  // out the sign-ins of people in flight. By socket address, never a header.
  const wait = signinAllowed(ctx, `parent:${clientAddress(ctx.request)}`);
  if (wait !== undefined) {
    const slow = failure(ctx, `Too many attempts. Try again in ${retryAfterOf(wait)}s.`, 429);
    slow.headers.set("retry-after", String(retryAfterOf(wait)));
    return slow;
  }
  const redirectUri = redirectUriOf(ctx);
  let client: string;
  try {
    client = await clientId(ctx, issuer, redirectUri);
  } catch {
    return failure(ctx, "The parent forge could not be reached.", 502);
  }
  const state = rand(24);
  const verifier = rand(48);
  const nonce = rand(24);
  startLogin(ctx.app.db, state, { verifier, nonce, issuer, redirectUri, ...(linkUser === undefined ? {} : { linkUser }) });
  const query = new URLSearchParams({
    response_type: "code",
    client_id: client,
    redirect_uri: redirectUri,
    scope: SCOPE,
    state,
    nonce,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const headers = new Headers({
    location: `${issuer}/oauth/authorize?${query}`,
    "cache-control": "no-store",
  });
  headers.append("set-cookie", cookieHeader(state, 600, ctx.url, ctx.app.config.url));
  return new Response(null, { status: 303, headers });
}

export async function parentCallback(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const q = ctx.url.searchParams;
  const state = q.get("state") ?? "";
  const code = q.get("code") ?? "";
  // The cookie is the browser that began; without it nothing is fetched or spent.
  if (state === "" || state !== cookieValue(ctx.request, STATE_COOKIE))
    return failure(ctx, SIGNIN_NOT_THIS_BROWSER, 400);
  const login = takeLogin(ctx.app.db, state);
  const clear = cookieHeader("", 0, ctx.url, ctx.app.config.url);
  const refuse = (message: string, status = 400): Response => {
    const response = failure(ctx, message, status);
    response.headers.append("set-cookie", clear);
    return response;
  };
  if (login === undefined || login.issuer !== parentIssuer(ctx.app) || login.redirectUri !== redirectUriOf(ctx))
    return refuse(SIGNIN_EXPIRED);
  if (q.has("error") || code === "" || code.length > 512)
    return refuse("The parent forge did not sign you in.");
  try {
    const client = await clientId(ctx, login.issuer, login.redirectUri);
    const { res, body } = await timePhaseAsync(ctx.request, "parent", async () => {
      const res = await fetch(`${login.issuer}/oauth/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: client,
          redirect_uri: login.redirectUri,
          code_verifier: login.verifier,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      return { res, body: await answerOf(res) };
    });
    if (!res.ok || typeof body.id_token !== "string")
      return refuse("The parent forge did not accept the sign-in.", 502);
    const keys = keysOf(ctx.app, login.issuer);
    const verified = await verifyJwt(
      body.id_token,
      (kid) => keys.find(kid),
      { issuer: login.issuer, audience: client, nonce: login.nonce },
    );
    if (!verified.ok) return refuse("The parent forge's answer did not verify.", 502);
    const sub = verified.value["sub"];
    if (typeof sub !== "string" || !SUB.test(sub))
      return refuse("The parent forge's answer did not verify.", 502);
    if (login.linkUser !== undefined) {
      // A link is for the account that began it, still signed in in this browser: never a sign-in, never a new account.
      if (ctx.auth.user?.id !== login.linkUser) return refuse("Sign in again, then link from your settings.", 403);
      const linked = linkParent(ctx.app.db, login.linkUser, login.issuer, sub);
      const back = flashTo(ctx, "/settings", {
        message: linked.ok
          ? `Linked ${new URL(login.issuer).host}.`
          : linked.error === "identity_taken"
            ? `That ${new URL(login.issuer).host} identity belongs to another account here.`
            : `This account is linked to another ${new URL(login.issuer).host} identity. Unlink it first.`,
      });
      if (linked.ok) ctx.app.bus.append({ kind: "account.parent_linked", actorId: login.linkUser });
      back.headers.append("set-cookie", clear);
      back.headers.set("cache-control", "no-store");
      return back;
    }
    // A linked method signs in an account that exists; it never makes one.
    const user = linkedAccount(ctx.app.db, login.issuer, sub);
    if (user === undefined) {
      const done = redirect("/signup?linked=unknown");
      done.headers.append("set-cookie", clear);
      done.headers.set("cache-control", "no-store");
      return done;
    }
    const session = createSession(ctx.app.db, user.id);
    const done = redirect("/", sessionCookie(session.token, session.expiresAt, ctx.url, ctx.app.config.url));
    done.headers.append("set-cookie", clear);
    done.headers.set("cache-control", "no-store");
    return done;
  } catch {
    return refuse("The parent forge could not be reached.", 502);
  }
}
