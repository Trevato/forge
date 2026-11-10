/**
 * `/claim/start/:token` (#10912): the one-time link the start call returned. A
 * person opens it, signs in or makes an account on the spot, and takes the
 * agent's account and repositories (`actions/claim.ts`). The link is the
 * proof of the claim, not of the right to join: the form that makes an
 * account is offered, and works, only where `/signup` would let a stranger in
 * (`signupClosed`, and not a passkey-only forge); otherwise the person signs in.
 */
import { claimStart, CLAIM_WORDS, viewClaim } from "../../actions/claim.ts";
import { noEmail, plausibleEmail, signupClosed } from "../../actions/users.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { createSession } from "../../core/sessions.ts";
import { createUser } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, pageHead } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html } from "../html.ts";
import { flashTo, page, redirect } from "../layout.ts";
import { btn, field as formField, icon, row } from "../ui.ts";
import { sessionCookie } from "./site.ts";

/** Whether a stranger may make an account here: what `/signup` allows, with no invite. */
const mayMakeAccount = (ctx: Ctx): boolean => !signupClosed(ctx.app) && ctx.app.config.passkeyOnlySignup !== true;

const tokenOf = (ctx: Ctx): string => ctx.params["token"] ?? "";

function withNoStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
}

// GET /claim/start/:token
export function startClaimPage(ctx: Ctx, errors: { username?: string; password?: string; email?: string } = {}, status = 200): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const token = tokenOf(ctx);
  const seen = viewClaim(ctx.app, token);
  if (seen === undefined) return notFoundPage(ctx);
  const person = ctx.auth.user?.kind === "user" ? ctx.auth.user : undefined;
  const here = `/claim/start/${encodeURIComponent(token)}`;
  const body = html`<div class="narrow stack">
    ${pageHead("Take this agent's work")}
    ${seen.claimed
      ? html`<p>${CLAIM_WORDS.claimed}</p>`
      : html`<p>
            An agent named <strong>${seen.agent}</strong> started building here without an account. Taking it moves
            ${seen.repos.length === 1 ? "its repository" : `its ${seen.repos.length} repositories`} to an organisation
            you own, with the agent as a member who can still push. Nothing else changes.
          </p>
          <ul class="list">${seen.repos.map((r) => row({ lead: icon("repo"), title: html`<span class="mono">${r}</span>` }))}</ul>
          ${person !== undefined
            ? html`<form method="post" action="${here}">
                                ${btn("Take it", { variant: "primary", label: "Take this agent's work" })}
              </form>`
            : html`<p><a href="/signin?next=${encodeURIComponent(here)}">Sign in</a> to take it${mayMakeAccount(ctx) ? ", or make an account:" : "."}</p>
              ${!mayMakeAccount(ctx) ? null : html`<form method="post" action="${here}/account" class="stack">
                ${formField({ label: "Username", name: "username", autocomplete: "username", required: true, pattern: "[A-Za-z0-9][A-Za-z0-9._-]*", ...(errors.username ? { error: errors.username } : {}) })}
                ${formField({ label: "Email", name: "email", type: "email", autocomplete: "email", hint: "Optional.", ...(errors.email ? { error: errors.email } : {}) })}
                ${formField({ label: "Password", name: "password", type: "password", autocomplete: "new-password", required: true, minlength: 12, hint: "At least 12 characters.", ...(errors.password ? { error: errors.password } : {}) })}
                ${btn("Make an account and take it", { variant: "primary", label: "Make an account and take it" })}
              </form>`}`}`}
  </div>`;
  return withNoStore(page({ ctx, title: "Claim", body }, status));
}

/** The words a refused claim says. */
const refused = (ctx: Ctx, error: keyof typeof CLAIM_WORDS): Response =>
  error === "not_found" ? notFoundPage(ctx) : flashTo(ctx, `/claim/start/${encodeURIComponent(tokenOf(ctx))}`, { tone: "danger", message: CLAIM_WORDS[error] });

// POST /claim/start/:token — a signed-in person takes it
export async function startClaimSubmit(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx);
  if (form instanceof Response) return form;
  const done = await claimStart(ctx.app, ctx.auth.user, tokenOf(ctx));
  if (!done.ok) return refused(ctx, done.error);
  return flashTo(ctx, `/${done.value.org}`, { message: `Taken: ${done.value.repos.join(", ")} now belong to ${done.value.org}.${done.value.stayed.length === 0 ? "" : ` Not moved, still the agent's: ${done.value.stayed.join(", ")}.`}` });
}

// POST /claim/start/:token/account — a stranger makes an account and takes it
export async function startClaimAccountSubmit(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx);
  if (form instanceof Response) return form;
  const token = tokenOf(ctx);
  const seen = viewClaim(ctx.app, token);
  if (seen === undefined) return notFoundPage(ctx);
  if (seen.claimed) return refused(ctx, "claimed");
  if (!mayMakeAccount(ctx)) return flashTo(ctx, `/claim/start/${encodeURIComponent(token)}`, { tone: "danger", message: "New accounts are not open here: sign in to take it." });
  const username = field(form, "username").trim();
  const given = field(form, "email").trim();
  if (given !== "" && !plausibleEmail(given)) return startClaimPage(ctx, { email: "That does not look like an email address." }, 422);
  const made = await createUser(ctx.app.db, {
    origin: "claimer",
    username,
    email: given === "" ? noEmail(username) : given,
    password: field(form, "password"),
    ...(given === "" ? { trusted: true } : {}),
  });
  if (!made.ok) {
    const said = {
      invalid_username: { username: "Usernames are letters, digits, dots, dashes." },
      username_taken: { username: "That username is taken." },
      username_reserved: { username: "That username is reserved." },
      email_taken: { email: "That email already has an account: sign in instead." },
      weak_password: { password: "Passwords need at least 12 characters." },
      password_too_long: { password: "That password is too long." },
      signup_closed: { username: "Accounts cannot be made here." },
    }[made.error];
    return startClaimPage(ctx, said, 422);
  }
  const done = await claimStart(ctx.app, made.value, token);
  if (!done.ok) return refused(ctx, done.error);
  const session = createSession(ctx.app.db, made.value.id);
  return redirect(`/${done.value.org}`, sessionCookie(session.token, session.expiresAt, ctx.url, ctx.app.config.url));
}
