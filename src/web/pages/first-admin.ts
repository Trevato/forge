/**
 * `/first-admin`: where a person redeems the code the operator's
 * `--first-admin` printed (`core/first_admin.ts`), making the forge's first
 * admin with a passkey. The link is `/first-admin#<code>`, so the code
 * never leaves the browser in a request line. The GET only shows the form;
 * the options route and the POST (same-origin; each an attempt on the
 * action's throttle) check the code, and the POST spends it. Every refusal of the code reads
 * the same. A headless agent redeems the same code at
 * `POST /api/v1/first-admin` for a token instead.
 */

import { crossOrigin, type Ctx } from "../../http/context.ts";
import { STRANGER_MAX } from "../../http/limits.ts";
import { clientAddress } from "../../http/peer.ts";
import { boundedBody, json, str } from "../../http/respond.ts";
import { FIRST_ADMIN_WORDS, firstAdminProblem, redeemFirstAdmin } from "../../actions/first_admin.ts";
import { addPasskey } from "../../core/passkeys.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { createSession } from "../../core/sessions.ts";
import { pageHead, CAME_FROM_ELSEWHERE } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { page, redirect } from "../layout.ts";
import { makeOptions, PASSKEY_WORDS, passkeyFields, readPasskey } from "../passkey-ceremony.ts";
import { passkeyJs } from "../passkey-client.ts";
import { passkeyNote, passkeyState } from "../passkey-state.ts";
import { card, field as formField } from "../ui.ts";
import { sessionCookie } from "./site.ts";

interface Values {
  readonly username?: string;
  readonly email?: string;
  readonly token?: string;
}
type Errors = Partial<Record<"token" | "username" | "email" | "passkey", string>>;

const TITLE = "Make this forge's first admin";

function form(values: Values, errors: Errors): Html {
  return html`<div class="narrow">
    ${pageHead(TITLE)}
    ${card(
      html`<p class="mb">
          The operator of this forge gave you a one-time code. The account you
          make here is the forge's admin, so it can change everything here.
        </p>
        <form method="post" action="/first-admin">
          <div id="first-admin-code-field">
            ${formField({
              label: "First-admin code",
              name: "token",
              value: values.token ?? "",
              required: true,
              hint: "The part of your link after the #. Opening the link fills it in.",
              ...(errors.token ? { error: errors.token } : {}),
            })}
          </div>
          ${formField({
            label: "Username",
            name: "username",
            value: values.username ?? "",
            autocomplete: "username",
            required: true,
            autofocus: true,
            hint: "Letters, digits, dots and dashes.",
            ...(errors.username ? { error: errors.username } : {}),
          })}
          ${formField({
            label: "Email",
            name: "email",
            type: "email",
            value: values.email ?? "",
            autocomplete: "email",
            required: true,
            ...(errors.email ? { error: errors.email } : {}),
          })}
          ${passkeyFields()}
          <div class="stack stack-tight mb">${passkeyState()}</div>
          <p class="muted small mb">
            You sign in with a passkey: a fingerprint, face or device PIN.
            There is no password to remember.
          </p>
          ${passkeyNote("passkey-make-note", errors.passkey)}
          <noscript><p class="muted small">Making the passkey needs JavaScript.</p></noscript>
          <div class="form-actions">
            <button type="submit" id="passkey-make" class="btn" data-variant="primary" data-options="/first-admin/options">Make the admin with a passkey</button>
          </div>
        </form>`,
    )}
  </div>`;
}

/** The code from `#…` into the form, and out of the address bar and history. */
const fragmentJs = /* js */ `
(function () {
  var field = document.querySelector('input[name="token"]');
  var code = location.hash.slice(1);
  if (!field || !code) return;
  field.value = code;
  var box = document.getElementById('first-admin-code-field');
  if (box) box.hidden = true;
  history.replaceState(null, '', location.pathname + location.search);
})();
`;

/** Which field a refusal belongs on. */
function errorsOf(error: keyof typeof FIRST_ADMIN_WORDS): Errors {
  const words = FIRST_ADMIN_WORDS[error];
  if (error === "refused" || error === "rate_limited") return { token: words };
  if (error === "invalid_email" || error === "email_taken") return { email: words };
  if (error === "unfinished") return { passkey: words };
  return { username: words };
}

// GET /first-admin — the form; the code is in the fragment, so nothing is known or spent here.
// It reads no data, so its Server-Timing names the session and the render only.
export function firstAdminPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  return timePhase(ctx.request, "render", () =>
    page({ ctx, title: TITLE, body: form({}, {}), scriptJs: fragmentJs + passkeyJs }),
  );
}

/** The status a refusal answers with: the throttle, a code, or the form. */
const statusOf = (error: string): number =>
  error === "rate_limited" ? 429 : error === "refused" ? 403 : 422;

// POST /first-admin/options — a passkey challenge for a live code and a fit name. Nothing is spent.
export async function firstAdminOptions(ctx: Ctx): Promise<Response> {
  if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return json({ error: "refused", message: CAME_FROM_ELSEWHERE }, 403);
  const data = await boundedBody(ctx.request, STRANGER_MAX);
  if (data === "too_large") return json({ error: "refused", message: "payload too large" }, 413);
  const username = str(data.username).trim();
  const problem = firstAdminProblem(ctx.app, {
    code: str(data.token).trim(),
    username,
    email: str(data.email).trim(),
    address: clientAddress(ctx.request),
  });
  if (problem !== undefined)
    return json(
      { error: problem === "rate_limited" ? problem : "refused", message: FIRST_ADMIN_WORDS[problem] },
      statusOf(problem),
      problem === "rate_limited" ? { "retry-after": "60" } : {},
    );
  return json(makeOptions(ctx, "firstAdmin", username));
}

// POST /first-admin — spend the code, make the admin with their passkey, sign them in.
export async function firstAdminSubmit(ctx: Ctx): Promise<Response> {
  const posted = await readForm(ctx);
  if (posted instanceof Response) return posted;
  const values = {
    // From the body only — never a path or query string, which logs keep.
    token: field(posted, "token").trim(),
    username: field(posted, "username").trim(),
    email: field(posted, "email").trim(),
  };
  const again = (errors: Errors, status = 422) =>
    page({ ctx, title: TITLE, body: form(values, errors), scriptJs: passkeyJs }, status);
  // The key, or nothing: a password in the form is not read at all.
  const key = await readPasskey(ctx, "firstAdmin", posted);
  if (!key.ok) return again({ passkey: PASSKEY_WORDS[key.error] });
  const made = await redeemFirstAdmin(
    ctx.app,
    { code: values.token, username: values.username, email: values.email, via: "passkey", address: clientAddress(ctx.request) },
    (user) => (addPasskey(ctx.app.db, user.id, "Passkey", key.value).ok ? true : undefined),
  );
  if (!made.ok) return again(errorsOf(made.error), statusOf(made.error));
  const session = createSession(ctx.app.db, made.value.user.id);
  return redirect("/", sessionCookie(session.token, session.expiresAt, ctx.url, ctx.app.config.url));
}
