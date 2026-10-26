/**
 * The server half of a form that makes an account with a passkey — the
 * claim link (`pages/claim.ts`), the everyday account (`pages/everyday.ts`)
 * and the first admin (`pages/first-admin.ts`). The page's button asks its
 * options route for a challenge (`makeOptions`), the browser makes the key,
 * `passkey-client.ts` writes the answer into the form's hidden fields
 * (`passkeyFields`) and submits it; the page's POST reads it back
 * (`readPasskey`). A form with no key in it — a password, or a browser
 * without script — makes nothing.
 */

import type { Credential } from "../auth/webauthn.ts";
import { newChallenge, verifyRegistration } from "../auth/webauthn.ts";
import { findPasskey } from "../core/passkeys.ts";
import type { Ctx } from "../http/context.ts";
import { field, type Form } from "./form.ts";
import { html, type Html } from "./html.ts";
import { clientBucket } from "../http/peer.ts";
import { relying, store } from "./pages/passkeys.ts";
import { PASSKEY_EXPIRED, PASSKEY_REJECTED, PASSKEY_TAKEN } from "./passkey-words.ts";

/**
 * Which form is making the account. Each has its own challenge store, so a
 * challenge one options route issued is spent only at that form's POST.
 */
export type Ceremony = "claim" | "everyday" | "firstAdmin";

/** What the browser needs for `navigator.credentials.create`, for `username`. */
export function makeOptions(ctx: Ctx, ceremony: Ceremony, username: string) {
  return {
    challenge: store(ctx.app)[ceremony].issue(clientBucket(ctx.request)),
    rpId: relying(ctx).rpId,
    rpName: "forge",
    user: { id: newChallenge(), name: username, displayName: username },
    exclude: [],
  };
}

/** The hidden fields the client script fills before the form posts. */
export const passkeyFields = (): Html =>
  html`<input type="hidden" name="challenge" value="" />
    <input type="hidden" name="clientDataJSON" value="" />
    <input type="hidden" name="attestationObject" value="" />`;

export type PasskeyRefusal = "missing" | "expired" | "rejected" | "taken";

/** The words for each way a posted key is refused, written for anyone. */
export const PASSKEY_WORDS: Record<PasskeyRefusal, string> = {
  missing: "This needs a passkey, and a browser with JavaScript on to make one. Passwords are not taken here.",
  expired: PASSKEY_EXPIRED,
  rejected: PASSKEY_REJECTED,
  taken: PASSKEY_TAKEN,
};

/**
 * The verified key a form carries, or why not. The challenge answers once,
 * whatever else is wrong; a key another account holds is refused here, so
 * the caller never makes an account it then cannot give a key.
 */
export async function readPasskey(
  ctx: Ctx,
  ceremony: Ceremony,
  form: Form,
): Promise<{ ok: true; value: Credential } | { ok: false; error: PasskeyRefusal }> {
  const clientDataJSON = field(form, "clientDataJSON");
  const attestationObject = field(form, "attestationObject");
  const challenge = field(form, "challenge");
  if (clientDataJSON === "" || attestationObject === "" || challenge === "")
    return { ok: false, error: "missing" };
  if (!store(ctx.app)[ceremony].consume(challenge)) return { ok: false, error: "expired" };
  const made = await verifyRegistration(
    { clientDataJSON, attestationObject },
    { challenge, ...relying(ctx) },
  );
  if (!made.ok) return { ok: false, error: "rejected" };
  if (findPasskey(ctx.app.db, made.id)) return { ok: false, error: "taken" };
  return { ok: true, value: made };
}
