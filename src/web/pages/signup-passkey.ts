/**
 * Sign-up with a passkey: the browser asks for a challenge (after the name
 * and address are checked), makes the key, and posts it back; the account,
 * its email and its key are made together and the session cookie is the one
 * a password gives. Both steps are JSON, same-origin checked, rate-limited
 * per address; a challenge answers once.
 */

import { newChallenge, verifyRegistration } from "../../auth/webauthn.ts";
import { plausibleEmail, signUpWithPasskey, signupClosed, HUMAN_CHECK_MESSAGE, SIGNUP_CLOSED_MESSAGE } from "../../actions/users.ts";
import { createSession } from "../../core/sessions.ts";
import { getUserByName } from "../../core/users.ts";
import { isSafeName } from "../../git/guard.ts";
import { edgeStrangerLogin } from "../../http/edge.ts";
import { crossOrigin, type Ctx } from "../../http/context.ts";
import { STRANGER_MAX } from "../../http/limits.ts";
import { clientAddress } from "../../http/peer.ts";
import { boundedBody, json, str } from "../../http/respond.ts";
import { relying, store } from "./passkeys.ts";
import { EDGE_NAME_MESSAGE, inviteOf, pinnedTo, safeNext, sessionCookie, signinAllowed, signupSlot } from "./site.ts";

const refuse = (status: number, message: string) =>
  json({ error: "refused", message }, status);

/** The words for each way a sign-up can fail, written for anyone. */
const WORDS: Record<string, string> = {
  invalid_username: "Usernames are letters, digits, dots and dashes.",
  username_taken: "That username is taken.",
  username_reserved: "That name is reserved.",
  email_taken: "That email already has an account.",
  invalid_email: "That does not look like an email address.",
  edge_name: EDGE_NAME_MESSAGE,
  human_check: HUMAN_CHECK_MESSAGE,
  passkey_taken: "That passkey is already registered.",
  signup_closed: SIGNUP_CLOSED_MESSAGE,
};

/** Whether the name and address are fit to sign up with; else the words. */
function problem(ctx: Ctx, username: string, email: string): string | undefined {
  if (!isSafeName(username)) return WORDS.invalid_username;
  if (!pinnedTo(ctx, username, inviteOf(ctx))) return WORDS.edge_name;
  if (!plausibleEmail(email)) return WORDS.invalid_email;
  if (getUserByName(ctx.app.db, username)) return WORDS.username_taken;
  return undefined;
}

function tooMany(wait: number): Response {
  return json({ error: "rate_limited", message: `Too many attempts. Try again in ${wait}s.` }, 429, { "retry-after": String(wait) });
}

function guard(ctx: Ctx): Response | undefined {
  if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return refuse(403, "forbidden");
  const wait = signinAllowed(ctx, `signup:${clientAddress(ctx.request)}`);
  return wait === undefined ? undefined : tooMany(wait);
}

// POST /signup/passkey/options — a challenge, once the name and address pass.
export async function signupOptions(ctx: Ctx): Promise<Response> {
  const denied = guard(ctx);
  if (denied) return denied;
  if (signupClosed(ctx.app, inviteOf(ctx))) return refuse(403, SIGNUP_CLOSED_MESSAGE);
  const data = await boundedBody(ctx.request, STRANGER_MAX);
  if (data === "too_large") return refuse(413, "payload too large");
  const username = str(data.username).trim();
  const email = str(data.email).trim();
  const bad = problem(ctx, username, email);
  if (bad) return refuse(422, bad);
  return json({
    challenge: store(ctx.app).signup.issue(),
    rpId: relying(ctx).rpId,
    rpName: "forge",
    user: { id: newChallenge(), name: username, displayName: username },
    exclude: [],
  });
}

// POST /signup/passkey — verify the key, make the account, start the session.
export async function signupPasskey(ctx: Ctx): Promise<Response> {
  const denied = guard(ctx);
  if (denied) return denied;
  if (signupClosed(ctx.app, inviteOf(ctx))) return refuse(403, SIGNUP_CLOSED_MESSAGE);
  const data = await boundedBody(ctx.request, STRANGER_MAX);
  if (data === "too_large") return refuse(413, "payload too large");
  const username = str(data.username).trim();
  const email = str(data.email).trim();
  const bad = problem(ctx, username, email);
  if (bad) return refuse(422, bad);
  const challenge = str(data.challenge);
  if (!store(ctx.app).signup.consume(challenge))
    return refuse(400, "That request expired. Try again.");
  const made = await verifyRegistration(
    { clientDataJSON: str(data.clientDataJSON), attestationObject: str(data.attestationObject) },
    { challenge, ...relying(ctx) },
  );
  if (!made.ok) return refuse(400, "That passkey was not accepted.");
  // The slot is taken once the key is proven, before the account is tried:
  // a taken name or a closed door found there still spends it. Cheap
  // validation above has already refused what it can.
  const slot = signupSlot(ctx);
  if (typeof slot === "number") return tooMany(slot);
  const created = await signUpWithPasskey(
    ctx.app,
    { username, email, passkey: made, passkeyName: "Passkey", humanToken: str(data.humanToken) },
    { slot, invite: inviteOf(ctx), address: clientAddress(ctx.request) },
  );
  if (!created.ok)
    return refuse(created.error === "human_check" ? 422 : created.error === "signup_closed" ? 403 : 409, WORDS[created.error] ?? "Sign-up did not work. Try again.");
  const session = createSession(ctx.app.db, created.value.id);
  return json(
    { ok: true, next: safeNext(ctx.url.searchParams.get("next")) ?? "/" },
    201,
    { "set-cookie": sessionCookie(session.token, session.expiresAt, ctx.url, ctx.app.config.url) },
  );
}
