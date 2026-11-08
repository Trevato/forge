/**
 * `/oauth/authorize`: the page an MCP client sends a person to. It names the
 * client and where it will return, asks which kind of token to mint and what
 * to call it, and on consent hands back a one-time code at the redirect the
 * client registered. A request that is not valid is shown, never followed:
 * nothing here redirects to an address that was not registered.
 */
import {
  isOAuthScope,
  issueCode,
  LIFETIMES,
  parseAuthRequest,
  redirectWith,
  tokenName,
  type AuthRequest,
} from "../../core/oauth.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { pageHead, SIGN_IN_TO_DO, forbiddenPage } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { page, redirect } from "../layout.ts";
import { btn, card, field as formField } from "../ui.ts";

const PARAMS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "nonce",
] as const;

/** Nothing here is cacheable, and nothing here may be sent on as a referrer. */
const guard = (response: Response): Response => {
  response.headers.set("cache-control", "no-store");
  // same-origin, not no-referrer: no-referrer makes the browser send `Origin: null` on the consent form's
  // own POST, and the CSRF gate refused every consent (2026-10-27). Other sites still get no referrer.
  response.headers.set("referrer-policy", "same-origin");
  return response;
};

/**
 * Chromium checks `form-action` against the redirect that follows a form
 * submit, using the policy of the page the form is on. The consent page lets
 * its form go to the one origin the client registered, and nowhere else.
 */
const allowReturnTo = (response: Response, redirectUri: string): Response => {
  const csp = response.headers.get("content-security-policy") ?? "";
  response.headers.set(
    "content-security-policy",
    csp.replace("form-action 'self'", `form-action 'self' ${new URL(redirectUri).origin}`),
  );
  return response;
};

const refused = (ctx: Ctx, message: string): Response =>
  guard(
    page(
      {
        ctx,
        title: "Can't connect",
        body: html`<div class="narrow">
          ${pageHead("This connection can't be made")}
          ${card(
            html`<p>${message}</p>
              <p class="muted small">
                Nothing was granted. Go back to the app and start again.
              </p>`,
          )}
        </div>`,
      },
      400,
    ),
  );

const hidden = (name: string, value: string): Html =>
  html`<input type="hidden" name="${name}" value="${value}" />`;

/** What an OpenID grant tells the app about the person, in plain words. */
const IDENTITY: Record<string, string> = {
  openid: "who you are on this forge (an identifier that stays the same)",
  profile: "your username and name",
  email: "your email address",
};

const identity = (request: AuthRequest): Html | "" =>
  request.oidcScopes.length === 0
    ? ""
    : html`<fieldset class="field">
        <legend>What it will learn about you</legend>
        <ul>
          ${request.oidcScopes.map((s) => html`<li>${IDENTITY[s] ?? s}</li>`)}
        </ul>
      </fieldset>`;

function signInConsent(request: AuthRequest, values: Params): Html {
  const host = new URL(request.redirectUri).host;
  return html`<div class="narrow">
    ${pageHead(`Sign in to ${host}`)}
    ${card(
      html`<p class="mb">
          Sign in to <strong>${host}</strong> as you. It learns only what is
          listed below, and gets no access to this forge.
        </p>
        <form method="post" action="/oauth/authorize">
          ${PARAMS.map((name) => hidden(name, values[name]))}
          ${identity(request)}
          <div class="form-actions">
            ${btn("Sign in", { variant: "primary", name: "decision", value: "allow" })}
            ${btn("Deny", { name: "decision", value: "deny" })}
          </div>
        </form>`,
    )}
  </div>`;
}

function consent(ctx: Ctx, request: AuthRequest, values: Params): Html {
  if (request.signInOnly) return signInConsent(request, values);
  const host = new URL(request.redirectUri).host;
  return html`<div class="narrow">
    ${pageHead(`Connect ${request.client.name}`)}
    ${card(
      html`<p class="mb">
          <strong>${request.client.name}</strong> wants to use the forge as you,
          through a token. When you allow it, you are sent back to
          <strong>${host}</strong>.
        </p>
        <form method="post" action="/oauth/authorize">
          ${PARAMS.map((name) => hidden(name, values[name]))}
          ${identity(request)}
          <fieldset class="field">
            <legend>What it may do</legend>
            <label
              ><input type="radio" name="grant" value="ro"
              ${request.scope === "ro" ? "checked" : ""} />
              Read: see your apps, issues and runs</label
            >
            <label
              ><input type="radio" name="grant" value="rw"
              ${request.scope === "rw" ? "checked" : ""} />
              Read and act: tell the crew, plan, and change things as you</label
            >
          </fieldset>
          ${formField({
            label: "Token name",
            name: "name",
            value: request.client.name,
            required: true,
            hint: "How it is listed under Settings, where you can revoke it.",
          })}
          <div class="field">
            <label for="f-lifetime">Lasts</label>
            <select class="input" id="f-lifetime" name="lifetime">
              <option value="never" selected>Until I revoke it</option>
              <option value="year">A year</option>
              <option value="month">30 days</option>
              <option value="day">A day</option>
            </select>
          </div>
          <div class="form-actions">
            ${btn("Allow", { variant: "primary", name: "decision", value: "allow" })}
            ${btn("Deny", { name: "decision", value: "deny" })}
          </div>
        </form>`,
    )}
  </div>`;
}

type Params = Record<(typeof PARAMS)[number], string>;

const fromQuery = (ctx: Ctx): Params =>
  Object.fromEntries(
    PARAMS.map((p) => [p, ctx.url.searchParams.get(p) ?? ""]),
  ) as Params;

export function authorizePage(ctx: Ctx): Response {
  if (ctx.auth.user === undefined || ctx.auth.via === "token")
    return guard(
      redirect(
        `/signin?next=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`,
      ),
    );
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const values = fromQuery(ctx);
  const request = timePhase(ctx.request, "request", () =>
    parseAuthRequest(ctx.app.db, (n) => values[n as keyof Params] ?? ""),
  );
  if (!request.ok) return refused(ctx, request.error);
  const rendering = performance.now();
  const response = allowReturnTo(
    guard(page({ ctx, title: "Connect", body: consent(ctx, request.value, values) })),
    request.value.redirectUri,
  );
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

export async function authorizeSubmit(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx);
  if (form instanceof Response) return form;
  if (ctx.auth.user === undefined || ctx.auth.via === "token")
    return forbiddenPage(ctx, SIGN_IN_TO_DO);
  const request = parseAuthRequest(ctx.app.db, (n) => field(form, n));
  if (!request.ok) return refused(ctx, request.error);
  const { redirectUri, state } = request.value;
  if (field(form, "decision") !== "allow")
    return guard(
      redirect(redirectWith(redirectUri, { error: "access_denied", state })),
    );
  if (request.value.signInOnly) {
    const code = issueCode(ctx.app.db, ctx.auth.user.id, request.value, {
      scope: "ro",
      name: request.value.client.name,
      lifetimeS: null,
    });
    return guard(redirect(redirectWith(redirectUri, { code, state })));
  }
  const grant = field(form, "grant");
  const lifetime = LIFETIMES[field(form, "lifetime")];
  if (!isOAuthScope(grant) || lifetime === undefined)
    return refused(ctx, "Choose what the token may do and how long it lasts.");
  const code = issueCode(ctx.app.db, ctx.auth.user.id, request.value, {
    scope: grant,
    name: tokenName(field(form, "name"), request.value.client.name),
    lifetimeS: lifetime,
  });
  return guard(redirect(redirectWith(redirectUri, { code, state })));
}
