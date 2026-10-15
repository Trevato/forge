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
  removePasskey,
  PASSKEY_NAME_MAX,
} from "../../core/passkeys.ts";
import { createSession } from "../../core/sessions.ts";
import { getUserById, isActive } from "../../core/users.ts";
import { crossOrigin, type Ctx } from "../../http/context.ts";
import { clientAddress } from "../../http/peer.ts";
import { STRANGER_MAX } from "../../http/limits.ts";
import { boundedBody, json, str } from "../../http/respond.ts";
import { signInFirst } from "../chrome.ts";
import { readForm } from "../form.ts";
import { html } from "../html.ts";
import { flashTo } from "../layout.ts";
import { passkeyJs } from "../passkey-client.ts";
import { card, empty, confirmAction, time } from "../ui.ts";
import { accountShell } from "./account.ts";
import { safeNext, sessionCookie, signinAllowed } from "./site.ts";

/** One-time challenges, one store per ceremony per forge. */
const stores = new WeakMap<App, { add: ReturnType<typeof challenges>; signin: ReturnType<typeof challenges> }>();
function store(app: App) {
  let s = stores.get(app);
  if (!s) stores.set(app, (s = { add: challenges(), signin: challenges() }));
  return s;
}

/** What the browser must see as the relying party: the forge's public address. */
function relying(ctx: Ctx) {
  return { origin: ctx.url.origin, rpId: ctx.url.hostname };
}

const refuse = (status: number, message: string) =>
  json({ error: "refused", message }, status);

/** A signed-in browser, on a same-origin request; else the refusal to send. */
function sessionOnly(ctx: Ctx): Response | undefined {
  if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return refuse(403, "forbidden");
  if (!ctx.auth.user) return refuse(401, "Sign in first.");
  if (ctx.auth.via !== "session") return refuse(403, "Passkeys are changed from a signed-in browser.");
  return undefined;
}

// GET /settings/passkeys
export function passkeysPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  const keys = listPasskeys(ctx.app.db, ctx.auth.user.id);
  const body = html`<p class="muted small mb">
      A passkey signs you in with a fingerprint, face or device PIN instead of
      a password. Add one per device; each can be removed on its own.
    </p>
    ${keys.length === 0
      ? empty({ icon: "key", title: "No passkeys yet", note: "Add one to sign in without typing a password." })
      : card(
          html`<div class="table-scroll">
            <table class="table" id="passkeys">
              <thead><tr><th>Name</th><th>Added</th><th>Last used</th><th></th></tr></thead>
              <tbody>
                ${keys.map(
                  (k) => html`<tr>
                    <td><strong>${k.name}</strong></td>
                    <td class="muted">${time(k.createdAt)}</td>
                    <td class="muted">${k.lastUsedAt ? time(k.lastUsedAt) : "never"}</td>
                    <td>${confirmAction({ action: `/settings/passkeys/${k.id}/delete`, verb: "Remove", size: "sm" })}</td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </div>`,
          { pad: false },
        )}
    ${card(
      html`<div class="field">
          <label for="passkey-name">Name</label>
          <input id="passkey-name" name="name" maxlength="${PASSKEY_NAME_MAX}" autocomplete="off" placeholder="Laptop, phone, security key" />
        </div>
        <p class="error-note" id="passkey-add-note" role="status"></p>
        <noscript><p class="muted small">Adding a passkey needs JavaScript.</p></noscript>
        <div class="form-actions">
          <button type="button" id="passkey-add" class="btn" data-variant="primary">Add a passkey</button>
        </div>`,
      { head: html`<h3>New passkey</h3>` },
    )}`;
  return accountShell(ctx, "passkeys", "Passkeys", body, 200, passkeyJs);
}

// POST /settings/passkeys/options — a challenge for a new passkey.
export function passkeyOptions(ctx: Ctx): Response {
  const denied = sessionOnly(ctx);
  if (denied) return denied;
  const user = ctx.auth.user!;
  return json({
    challenge: store(ctx.app).add.issue(),
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
    return refuse(400, "That request expired. Try again.");
  const made = await verifyRegistration(
    { clientDataJSON: str(data.clientDataJSON), attestationObject: str(data.attestationObject) },
    { challenge, ...relying(ctx) },
  );
  if (!made.ok) return refuse(400, "That passkey was not accepted.");
  const name = str(data.name).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, PASSKEY_NAME_MAX) || "Passkey";
  const added = addPasskey(ctx.app.db, ctx.auth.user!.id, name, made);
  if (!added.ok)
    return refuse(
      409,
      added.error === "too_many" ? "That is as many passkeys as an account keeps." : "That passkey is already registered.",
    );
  return json({ ok: true });
}

// POST /settings/passkeys/:id/delete
export async function passkeyDelete(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const gone = removePasskey(ctx.app.db, ctx.auth.user.id, ctx.params.id ?? "");
  return flashTo(
    ctx,
    "/settings/passkeys",
    gone ? { message: "Passkey removed." } : { tone: "danger", message: "No such passkey." },
  );
}

// POST /signin/passkey/options — a challenge for someone with no session yet.
export function signinOptions(ctx: Ctx): Response {
  if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return refuse(403, "forbidden");
  const wait = signinAllowed(ctx, `passkey:${clientAddress(ctx.request)}`);
  if (wait !== undefined)
    return json({ error: "rate_limited", message: `Too many attempts. Try again in ${wait}s.` }, 429, { "retry-after": String(wait) });
  return json({ challenge: store(ctx.app).signin.issue(), rpId: relying(ctx).rpId });
}

// POST /signin/passkey — a good assertion gets the session a password gets.
export async function signinPasskey(ctx: Ctx): Promise<Response> {
  if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return refuse(403, "forbidden");
  const wait = signinAllowed(ctx, `passkey:${clientAddress(ctx.request)}`);
  if (wait !== undefined)
    return json({ error: "rate_limited", message: `Too many attempts. Try again in ${wait}s.` }, 429, { "retry-after": String(wait) });
  const data = await boundedBody(ctx.request, STRANGER_MAX);
  if (data === "too_large") return refuse(413, "payload too large");
  const challenge = str(data.challenge);
  const no = () => refuse(401, "That passkey was not accepted.");
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
