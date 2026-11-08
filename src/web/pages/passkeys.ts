/**
 * Passkeys: Settings → Passkeys lists, adds and removes them, and the
 * sign-in page's passkey button gives the same session a password does.
 * The ceremonies are JSON (a browser's `navigator.credentials` cannot post a
 * form); the verification is `auth/webauthn.ts`. Every mutation is
 * same-origin checked, and a challenge answers once.
 */

import { challenges, verifyAssertion, verifyRegistration } from "../../auth/webauthn.ts";
import type { App } from "../../app.ts";
import {
  addPasskey,
  findPasskey,
  listPasskeys,
  notePasskeyUsed,
  passkeyIds,
  passkeyRoom,
  PASSKEY_NAME_MAX,
} from "../../core/passkeys.ts";
import { linkEdgeLogin } from "../../core/edge_links.ts";
import { activeEdgeToken, edgeIdentity } from "../../http/edge.ts";
import { RateLimiter } from "../../core/ratelimit.ts";
import { createSession } from "../../core/sessions.ts";
import { LAST_WAY_IN, removeOwnPasskey } from "../../actions/passkeys.ts";
import { recoveryAccount, requestRecovery, spendRecoveryLink } from "../../actions/verify.ts";
import { getUserById, isActive } from "../../core/users.ts";
import { crossOrigin, type Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { clientAddress, clientBucket } from "../../http/peer.ts";
import { STRANGER_MAX } from "../../http/limits.ts";
import { boundedBody, json, str } from "../../http/respond.ts";
import { CAME_FROM_ELSEWHERE, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { passkeyJs } from "../passkey-client.ts";
import { passkeyNote } from "../passkey-state.ts";
import { confirmAction, row, time } from "../ui.ts";
import { accountShell } from "./account.ts";
import { safeNext, sessionCookie, signinAllowed } from "./site.ts";
import { PASSKEY_EXPIRED, PASSKEY_REJECTED, PASSKEY_TAKEN } from "../passkey-words.ts";

/** One-time challenges, one store per ceremony per forge. */
const stores = new WeakMap<App, { add: ReturnType<typeof challenges>; signin: ReturnType<typeof challenges>; recover: ReturnType<typeof challenges>; signup: ReturnType<typeof challenges>; claim: ReturnType<typeof challenges>; everyday: ReturnType<typeof challenges>; firstAdmin: ReturnType<typeof challenges> }>();
export function store(app: App) {
  let s = stores.get(app);
  if (!s) stores.set(app, (s = { add: challenges(), signin: challenges(), recover: challenges(), signup: challenges(), claim: challenges(), everyday: challenges(), firstAdmin: challenges() }));
  return s;
}

/** What the browser must see as the relying party: the forge's public address. */
export function relying(ctx: Ctx) {
  return { origin: ctx.url.origin, rpId: ctx.url.hostname };
}

const refuse = (status: number, message: string) =>
  json({ error: "refused", message }, status);

/** A signed-in browser, on a same-origin request; else the refusal to send. */
function sessionOnly(ctx: Ctx): Response | undefined {
  if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return refuse(403, CAME_FROM_ELSEWHERE);
  if (!ctx.auth.user) return refuse(401, "Sign in first.");
  // A browser the platform edge signed in is a signed-in browser too: adding a
  // passkey there is how an account comes to sign in without the edge (#9432).
  if (ctx.auth.via !== "session" && ctx.auth.via !== "edge")
    return refuse(403, "Passkeys are changed from a signed-in browser.");
  return undefined;
}

// GET /settings/passkeys
export function passkeysPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  if (!ctx.auth.user) return signInFirst(ctx);
  const user = ctx.auth.user;
  const keys = timePhase(ctx.request, "passkeys", () => listPasskeys(ctx.app.db, user.id));
  const rendering = performance.now();
  const body = html`<section class="settings-block">
      <h2>Your passkeys</h2>
      <p class="muted small" id="passkey-why">
        A passkey signs you in with a fingerprint, face or device PIN, so your
        account never waits on another service; add one per device.
      </p>
      ${keys.length === 0
        ? html`<p class="small mt">No passkeys yet. Your password still works; add a passkey now, as every new account starts with one.</p>`
        : html`<ul class="list setting-list" id="passkeys">
            ${keys.map((k) =>
              row({
                title: k.name,
                meta: html`added ${time(k.createdAt)} · ${k.lastUsedAt ? html`last used ${time(k.lastUsedAt)}` : "never used"}`,
                trail: confirmAction({ action: `/settings/passkeys/${k.id}/delete`, verb: "Remove", size: "sm", label: `Remove ${k.name}` }),
              }),
            )}
          </ul>`}
    </section>
    <section class="settings-block">
      <h2>New passkey</h2>
      <div class="field">
        <label for="passkey-name">Name</label>
        <input id="passkey-name" name="name" maxlength="${PASSKEY_NAME_MAX}" autocomplete="off" placeholder="Laptop, phone, security key" />
      </div>
      ${passkeyNote("passkey-add-note")}
      <noscript><p class="muted small">Adding a passkey needs JavaScript.</p></noscript>
      <div class="form-actions">
        <button type="button" id="passkey-add" class="btn" data-variant="primary">Add a passkey</button>
      </div>
    </section>`;
  const response = accountShell(ctx, "passkeys", "Passkeys", body, 200, passkeyJs);
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// POST /settings/passkeys/options — a challenge for a new passkey.
export function passkeyOptions(ctx: Ctx): Response {
  const denied = sessionOnly(ctx);
  if (denied) return denied;
  const user = ctx.auth.user!;
  return json({
    challenge: store(ctx.app).add.issue(user.id),
    rpId: relying(ctx).rpId,
    rpName: "forge",
    user: {
      id: Buffer.from(user.id).toString("base64url"),
      name: user.username,
      displayName: user.displayName || user.username,
    },
    exclude: passkeyIds(ctx.app.db, user.id),
  });
}

// POST /settings/passkeys — verify the browser's answer and keep the key.
export async function passkeyAdd(ctx: Ctx): Promise<Response> {
  const denied = sessionOnly(ctx);
  if (denied) return denied;
  const data = await boundedBody(ctx.request, STRANGER_MAX);
  if (data === "too_large") return refuse(413, "payload too large");
  const challenge = str(data.challenge);
  if (!store(ctx.app).add.consume(challenge))
    return refuse(400, PASSKEY_EXPIRED);
  const made = await verifyRegistration(
    { clientDataJSON: str(data.clientDataJSON), attestationObject: str(data.attestationObject) },
    { challenge, ...relying(ctx) },
  );
  if (!made.ok) return refuse(400, PASSKEY_REJECTED);
  const name = str(data.name).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, PASSKEY_NAME_MAX) || "Passkey";
  const added = addPasskey(ctx.app.db, ctx.auth.user!.id, name, made);
  if (!added.ok)
    return refuse(
      409,
      added.error === "too_many" ? "That is as many passkeys as an account keeps." : PASSKEY_TAKEN,
    );
  // A browser the edge signed in carries the login it vouched for: link it to
  // this account, so the edge still reaches it by that login and no second
  // account is made. A refused link (taken, malformed) leaves the passkey added.
  if (ctx.auth.via === "edge") {
    const login = edgeIdentity(ctx.request, activeEdgeToken(ctx.app));
    if (login !== undefined)
      linkEdgeLogin(ctx.app.db, ctx.auth.user!, login);
  }
  return json({ ok: true });
}

// POST /settings/passkeys/:id/delete
export async function passkeyDelete(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const gone = removeOwnPasskey(ctx.app, ctx.auth.user, ctx.params.id ?? "");
  return flashTo(
    ctx,
    "/settings/passkeys",
    gone.ok
      ? { message: "Passkey removed." }
      : { tone: "danger", message: gone.error === "last_way_in" ? LAST_WAY_IN : "No such passkey." },
  );
}

// POST /signin/passkey/options — a challenge for someone with no session yet.
export function signinOptions(ctx: Ctx): Response {
  if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return refuse(403, CAME_FROM_ELSEWHERE);
  const wait = signinAllowed(ctx, `passkey:${clientAddress(ctx.request)}`, { forgeWide: false });
  if (wait !== undefined)
    return json({ error: "rate_limited", message: `Too many attempts. Try again in ${wait}s.` }, 429, { "retry-after": String(wait) });
  return json({ challenge: store(ctx.app).signin.issue(clientBucket(ctx.request)), rpId: relying(ctx).rpId });
}

// POST /signin/passkey — a good assertion gets the session a password gets.
export async function signinPasskey(ctx: Ctx): Promise<Response> {
  if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return refuse(403, CAME_FROM_ELSEWHERE);
  const wait = signinAllowed(ctx, `passkey:${clientAddress(ctx.request)}`, { forgeWide: false });
  if (wait !== undefined)
    return json({ error: "rate_limited", message: `Too many attempts. Try again in ${wait}s.` }, 429, { "retry-after": String(wait) });
  const data = await boundedBody(ctx.request, STRANGER_MAX);
  if (data === "too_large") return refuse(413, "payload too large");
  const challenge = str(data.challenge);
  const no = () => refuse(401, PASSKEY_REJECTED);
  if (!store(ctx.app).signin.consume(challenge)) return no();
  const found = findPasskey(ctx.app.db, str(data.id));
  if (!found) return no();
  const user = getUserById(ctx.app.db, found.userId);
  if (!user || !isActive(user)) return no();
  const verified = await verifyAssertion(
    {
      clientDataJSON: str(data.clientDataJSON),
      authenticatorData: str(data.authenticatorData),
      signature: str(data.signature),
    },
    { challenge, ...relying(ctx) },
    found.credential,
  );
  if (!verified.ok) return no();
  notePasskeyUsed(ctx.app.db, found.id, verified.signCount);
  const session = createSession(ctx.app.db, user.id);
  return json(
    { ok: true, next: safeNext(ctx.url.searchParams.get("next")) ?? "/" },
    200,
    { "set-cookie": sessionCookie(session.token, session.expiresAt, ctx.url, ctx.app.config.url) },
  );
}

/**
 * Recovery by email: a proven address gets a 30-minute, single-use link
 * (`actions/verify.ts`); opening it registers a new passkey and signs the
 * person in. Asking is limited per address and per source, an hour at a
 * time, and answers the same for an address with no account.
 */
export const RECOVER_PER_ADDRESS = 3;
export const RECOVER_PER_SOURCE = 10;
const RECOVER_WINDOW_MS = 3_600_000;
const recoverLimits = new WeakMap<App, RateLimiter>();

function recoverWait(ctx: Ctx, email: string): number | undefined {
  let limiter = recoverLimits.get(ctx.app);
  if (limiter === undefined) {
    limiter = new RateLimiter({ perMinute: 0, adminPerMinute: 0, enabled: true, windowMs: RECOVER_WINDOW_MS });
    recoverLimits.set(ctx.app, limiter);
  }
  limiter.setLimits({ perMinute: RECOVER_PER_ADDRESS, adminPerMinute: RECOVER_PER_SOURCE, enabled: true, windowMs: RECOVER_WINDOW_MS });
  const source = limiter.take(`from:${clientBucket(ctx.request)}`, "admin");
  if (!source.allowed) return source.retryAfter;
  const address = limiter.take(`to:${email.toLowerCase()}`, "ro");
  return address.allowed ? undefined : address.retryAfter;
}

const NOT_VALID = "This link has expired, been used, or is not valid. Ask for a new one.";

// GET /recover — the request form, or (with ?token=) the new-passkey step.
export function recoverPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const render = (draw: () => Response): Response => timePhase(ctx.request, "render", draw);
  const token = ctx.url.searchParams.get("token");
  if (token === null) {
    return render(() => page({
      ctx,
      title: "Recover your account",
      body: html`<div class="page-head"><h1>Recover your account</h1></div>
        <p class="muted small mb">Give the email on your account. If it is verified, we send a link that lasts 30 minutes and works once; it lets you register a new passkey.</p>
        <form method="post" action="/recover">
          <div class="field"><label for="recover-email">Email</label>
            <input id="recover-email" name="email" type="email" maxlength="254" autocomplete="email" required /></div>
          <div class="form-actions"><button class="btn" data-variant="primary">Send the link</button></div>
        </form>`,
    }));
  }
  const user = timePhase(ctx.request, "link", () => recoveryAccount(ctx.app, token));
  if (user === undefined)
    return render(() => page({ ctx, title: "Link not valid", body: html`<div class="page-head"><h1>Link not valid</h1></div><p>${NOT_VALID}</p><p><a href="/recover">Ask for a new link</a></p>` }, 400));
  return render(() => page({
    ctx,
    title: "Register a new passkey",
    scriptJs: passkeyJs,
    body: html`<div class="page-head"><h1>Register a new passkey</h1></div>
      <p class="muted small mb">This signs you in as ${user.username}. Name the device, then follow your browser's prompt.</p>
      <div class="field"><label for="passkey-name">Name</label>
        <input id="passkey-name" name="name" maxlength="${PASSKEY_NAME_MAX}" autocomplete="off" placeholder="Laptop, phone, security key" /></div>
      ${passkeyNote("passkey-recover-note")}
      <noscript><p class="muted small">Registering a passkey needs JavaScript.</p></noscript>
      <div class="form-actions"><button type="button" id="passkey-recover" class="btn" data-variant="primary">Register and sign in</button></div>`,
  }));
}

// POST /recover — ask for a link. The same page for every address.
export async function recoverRequest(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx, undefined, STRANGER_MAX);
  if (form instanceof Response) return form;
  const email = field(form, "email").trim().slice(0, 254);
  const wait = email === "" ? undefined : recoverWait(ctx, email);
  if (wait !== undefined) {
    const res = page({ ctx, title: "Recover your account", body: html`<div class="page-head"><h1>Too many requests</h1></div><p>Try again in ${wait} seconds.</p>` }, 429);
    res.headers.set("retry-after", String(wait));
    return res;
  }
  if (email !== "") requestRecovery(ctx.app, email);
  return page({
    ctx,
    title: "Check your email",
    body: html`<div class="page-head"><h1>Check your email</h1></div>
      <p>If that address belongs to an account with a verified email, a link is on its way. It lasts 30 minutes and works once.</p>`,
  });
}

// POST /recover/options — a challenge, for a link that still works.
export async function recoverOptions(ctx: Ctx): Promise<Response> {
  if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return refuse(403, CAME_FROM_ELSEWHERE);
  const data = await boundedBody(ctx.request, STRANGER_MAX);
  if (data === "too_large") return refuse(413, "payload too large");
  const user = recoveryAccount(ctx.app, str(data.token));
  if (user === undefined) return refuse(400, NOT_VALID);
  return json({
    challenge: store(ctx.app).recover.issue(clientBucket(ctx.request)),
    rpId: relying(ctx).rpId,
    rpName: "forge",
    user: {
      id: Buffer.from(user.id).toString("base64url"),
      name: user.username,
      displayName: user.displayName || user.username,
    },
    exclude: passkeyIds(ctx.app.db, user.id),
  });
}

// POST /recover/passkey — a good registration spends the link and signs in.
export async function recoverFinish(ctx: Ctx): Promise<Response> {
  if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return refuse(403, CAME_FROM_ELSEWHERE);
  const data = await boundedBody(ctx.request, STRANGER_MAX);
  if (data === "too_large") return refuse(413, "payload too large");
  const token = str(data.token);
  const challenge = str(data.challenge);
  if (!store(ctx.app).recover.consume(challenge)) return refuse(400, PASSKEY_EXPIRED);
  const who = recoveryAccount(ctx.app, token);
  if (who === undefined) return refuse(400, NOT_VALID);
  const made = await verifyRegistration(
    { clientDataJSON: str(data.clientDataJSON), attestationObject: str(data.attestationObject) },
    { challenge, ...relying(ctx) },
  );
  if (!made.ok) return refuse(400, PASSKEY_REJECTED);
  // Refuse before spending: a link that cannot add its passkey stays usable.
  const room = passkeyRoom(ctx.app.db, who.id, made.id);
  if (!room.ok && room.error === "too_many")
    return refuse(409, "That is as many passkeys as an account keeps. Ask for a new link after removing one, or sign in another way.");
  if (!room.ok) return refuse(409, PASSKEY_TAKEN);
  const spent = spendRecoveryLink(ctx.app, token);
  if (!spent.ok) return refuse(400, NOT_VALID);
  const name = str(data.name).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, PASSKEY_NAME_MAX) || "Passkey";
  const added = addPasskey(ctx.app.db, spent.value.id, name, made);
  if (!added.ok) return refuse(409, "That passkey could not be added.");
  const session = createSession(ctx.app.db, spent.value.id);
  return json({ ok: true, next: "/settings/passkeys" }, 200, {
    "set-cookie": sessionCookie(session.token, session.expiresAt, ctx.url, ctx.app.config.url),
  });
}
