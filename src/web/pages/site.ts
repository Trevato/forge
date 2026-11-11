/**
 * The site pages: the home's dispatch and the cards its rail borrows, sign in
 * and sign up, creating a repository, search, and the confirmation step every
 * destructive action passes through. Plain forms, zero JavaScript required,
 * fast everywhere — a phone in the redwoods is the reference device.
 *
 * Every failure re-renders the form the person was filling in, with what they
 * typed still in it. A dead end that loses input is a bug, not a message.
 */

import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { keepGift } from "../gift_cookie.ts";
import { PASSWORD_TOO_LONG } from "../../core/hash-gate.ts";
import { NOT_A_MEMBER } from "../../core/roles.ts";
import { storageLimitMessage } from "../../core/storage.ts";
import { signOutHere } from "../../actions/signins.ts";
import { clientAddress } from "../../http/peer.ts";
import { verifyEmail } from "../../actions/verify.ts";
import { STRANGER_MAX } from "../../http/limits.ts";
import { createRepo, repositoryLimitMessage, resolveOwner } from "../../actions/repos.ts";
import { REPO_INIT_FAILED, REPO_NAME_RULES } from "../../actions/repo_words.ts";
import { NOTE_MAX, requestOf } from "../../core/requests.ts";
import { DECLINED_MESSAGE, REQUEST_IN_MESSAGE, STILL_WAITING_MESSAGE } from "../../actions/users.ts";
import { HUMAN_CHECK_MESSAGE, INVITE_SPENT_MESSAGE, PASSKEY_REQUIRED_MESSAGE, SIGNUP_CLOSED_MESSAGE, signUp, signupClosed } from "../../actions/users.ts";
import { accessAllows, listOrgsForUser, orgAccess } from "../../core/orgs.ts";
import { listPins } from "../../core/pins.ts";
import { getReposByIds } from "../../core/repos.ts";
import { createSession } from "../../core/sessions.ts";
import { getUserByName, hasAnyUser, verifyPasswordThrottled, type User } from "../../core/users.ts";
import { isThemeName } from "../../design/themes.ts";
import { cookieValue, crossOrigin, type Ctx } from "../../http/context.ts";
import { API_CATALOG_LINK } from "../../core/mcp_card.ts";
import { studioDoor, studioHome } from "../studio/home.ts";
import { parentIssuerOf } from "../../core/federation.ts";
import { activeEdgeToken, edgeIdentity, edgeLoginUrl, edgeStrangerLogin } from "../../http/edge.ts";
import { sshCommand } from "../../ssh/command.ts";
import {
  CAME_FROM_ELSEWHERE,
  forbiddenPage,
  hostOf,
  NOT_YOURS_TO_DO,
  pageHead,
  SENT_FROM_ELSEWHERE,
  signInFirst,
} from "../chrome.ts";
import { SignupSlot, signupWindow } from "../../actions/signup-window.ts";
import { signinWindow } from "../../core/signin-window.ts";
import { field, readForm } from "../form.ts";
import { passkeyJs } from "../passkey-client.ts";
import { passkeyNote } from "../passkey-state.ts";
import { html, when, type Html } from "../html.ts";
import { icon } from "../icons.ts";
import { flashTo, page, redirect } from "../layout.ts";
import {
  btn,
  field as formField,
  iconBtn,
  listCard,
  row,
  selectField,
  terminalCommand,
  copyField,
} from "../ui.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { secureFor } from "../../http/cookie_secure.ts";
import { SIGNUP_OWN_FORGE, SIGNUP_YOU_GET } from "../../core/contribute.ts";
import { hasAdmin } from "../../spawn/claim.ts";
import { getSignup, type SignupMode } from "../../settings/signup.ts";
import { EMAIL_TAKEN_MESSAGE, NAME_RESERVED, USERNAME_TAKEN } from "../../actions/signup_words.ts";

export function sessionCookie(
  value: string,
  expires: Date,
  url: URL,
  forgeUrl?: string,
): string {
  // Secure when the request or the forge's own address is https: behind a
  // proxy that ends TLS the request itself arrives as http.
  const secure = secureFor(url, forgeUrl) ? "; Secure" : "";
  return `forge_session=${value}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure}`;
}

/**
 * A `?next=` destination is a path on this forge or nothing at all. A
 * protocol-relative `//evil.example` is a redirect off-site wearing a path's
 * clothes, so it is refused with everything else that isn't a plain path.
 */
export function safeNext(raw: string | null): string | undefined {
  if (raw === null || raw === "") return undefined;
  if (!raw.startsWith("/") || raw.startsWith("//")) return undefined;
  if (raw.includes("\\") || /[\n\r]/.test(raw)) return undefined;
  return raw;
}

// ---- home ----

/**
 * What you keep on your machine. The server stores the *choice* and nothing
 * about the laptop, so this card is a list of decisions plus the one command
 * that acts on them — never a status the server would only ever hold a stale
 * copy of.
 */
export function downloadsCard(ctx: Ctx, user: User): Html {
  const pins = listPins(ctx.app.db, user.id);
  const head = html`${icon("download")}
    <h2>On your machine</h2>`;
  // Nothing pinned is nothing to show: the pin on a repository's header
  // says what it does where it is pressed.
  if (pins.length === 0) return html``;
  const repos = getReposByIds(
    ctx.app.db,
    pins.map((pin) => pin.repoId),
  );
  return listCard(
    [
      ...pins.map((pin) => {
        const repo = repos.get(pin.repoId);
        const at = repo?.origin ?? null;
        return row({
          nav: true,
          lead: icon("pin"),
          // The row carries an unpin form, and a form inside an <a> is markup
          // the parser pulls apart — so the title is the link.
          title: html`<a href="/${pin.ownerName}/${pin.name}"
            >${pin.ownerName}/${pin.name}</a
          >`,
          titleAttr: `${pin.ownerName}/${pin.name}`,
          // The same three places the repo header states, in the same words.
          meta: html`<span class="where">
            ${when(
              at,
              (o) =>
                html`<span class="where-place" data-state="present"
                    ><span aria-hidden="true">●</span
                    >${hostOf(o.htmlUrl) || o.fullName}</span
                  ><span class="sep" aria-hidden="true">·</span>`,
            )}
            <span class="where-place" data-state="present"
              ><span aria-hidden="true">●</span
              >workbench</span
            ><span class="sep" aria-hidden="true">·</span
            ><span class="where-place" data-state="present"
              ><span aria-hidden="true">◆</span>this
              machine</span
            >
          </span>`,
          // No timestamp: when you pinned something is the least useful fact
          // about it, and this rail is narrow enough that the strip needs the
          // room more than the clock does.
          trail: html`<form
            class="row-actions"
            method="post"
            action="/${pin.ownerName}/${pin.name}/pin"
          >
            <input type="hidden" name="pinned" value="0" />
            ${iconBtn("pinOff", "Unpin", {
              size: "sm",
              title: `Unpin — stop keeping ${pin.ownerName}/${pin.name} on my machine`,
            })}
          </form>`,
        });
      }),
      html`<li>
        <div class="row">
          <span class="row-main">
            ${copyField("forge-sync", "forge sync", "Sync command", "Copy the sync command")}
            <span class="row-meta"
              >Clones what is missing, fetches the rest, and reports
              ahead/behind/dirty. See docs/ON-YOUR-MACHINE.md.</span
            >
          </span>
        </div>
      </li>`,
    ],
    { head },
  );
}

export function orgsCard(ctx: Ctx, user: User): Html {
  const orgs = listOrgsForUser(ctx.app.db, user.id);
  // A new one is the "+" menu's; with none, there is nothing to show.
  if (orgs.length === 0) return html``;
  const head = html`${icon("users")}
    <h2>Your organizations</h2>`;
  return listCard(
    orgs.map((org) =>
      row({
        href: `/${org.username}`,
        nav: true,
        lead: icon("users"),
        title: org.username,
      }),
    ),
    { head },
  );
}

/** The terminal is a front door, not a footnote: the command, on the home. */
export function terminalCard(ctx: Ctx): Html {
  const ssh = sshCommand(ctx.app);
  if (ssh === undefined) return html``;
  return html`<section class="settings-block" id="terminal">
    <h2>Terminal</h2>
    ${terminalCommand(
      ssh,
      ctx.app.config.sshHostKey,
      html`<a class="small" href="/settings/keys">Computer keys</a>`,
    )}
  </section>`;
}

// GET / — the one home: a stranger gets the door, and a signed-in person
// the feed (`studioHome`, #599), whatever the mode (#625).
export async function home(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  // A gift link (`/?code=`) keeps the code in a cookie and opens the new-forge form, so the next address has no code in it (#11157).
  const gift = ctx.url.searchParams.get("code");
  if (gift !== null && gift !== "") return keepGift(gift.slice(0, 64), "/forges/new", ctx.url, ctx.app.config.url);
  const res = user === undefined ? await studioDoor(ctx) : await studioHome(ctx, user);
  // RFC 9727 §3: where an agent that knows only the origin finds the API catalog.
  res.headers.append("link", API_CATALOG_LINK);
  return res;
}

// ---- authentication ----

interface AuthValues {
  username?: string;
  email?: string;
}

interface AuthErrors {
  username?: string;
  email?: string;
  password?: string;
  human?: string;
}

/** What `/signin` says about new accounts in each signup mode; open says nothing. */
const SIGNUP_SENTENCES: Record<SignupMode, string | undefined> = {
  open: undefined,
  request: "New accounts here start after someone who runs the forge allows them.",
  invite: undefined,
  closed: undefined,
};

/**
 * The linked sign-in methods (the platform edge, the parent forge) are doors
 * for an account that already exists and never make one (#2883).
 */
function linkedMethods(edge: string | undefined, next: string | undefined, parent: string | undefined): Html | null {
  if (edge === undefined && parent === undefined) return null;
  return html`<section class="stack mt" id="linked-methods">
    <h2>Link an account you have</h2>
    <p class="muted small">These sign in an account that already exists and never make one.</p>
    ${when(edge, (name) => html`<p class="muted small">Accounts made through ${name} sign in there and have no password here. The form above is for an account that was given one.</p>`)}
    <div class="stack">
      ${when(edge, (name) => btn(`Sign in through ${name}`, { href: edgeLoginUrl(next ?? "/"), variant: "outline" }))}
      ${when(parent, (url) => btn(`Sign in through ${new URL(url).host}`, { href: "/signin/parent", variant: "outline" }))}
    </div>
  </section>`;
}

function authForm(
  ctx: Ctx,
  kind: "signin" | "signup",
  o: { values?: AuthValues; errors?: AuthErrors } = {},
): Html {
  const values = o.values ?? {};
  const errors = o.errors ?? {};
  const next = safeNext(ctx.url.searchParams.get("next"));
  // The invite link's token rides on the form's own address, as it does on
  // the passkey door's (`passkey-client.ts` posts to its page's query).
  const query = new URLSearchParams();
  if (next) query.set("next", next);
  const invite = kind === "signup" ? inviteOf(ctx) : undefined;
  if (invite !== undefined) query.set("invite", invite);
  const action = query.size === 0 ? `/${kind}` : `/${kind}?${query.toString()}`;
  // "Is this the first account?" is a `LIMIT 1` existence check, not a count
  // of the whole user table — and the sign-in screen paints on every session.
  const firstAccount = kind === "signup" && !timePhase(ctx.request, "users", () => hasAnyUser(ctx.app.db));

  // A newcomer the edge vouched for is already through it: no door to go
  // round again, and the name is theirs alone.
  const vouched = edgeStrangerLogin(ctx.request, activeEdgeToken(ctx.app), ctx.auth.user);
  const edge =
    activeEdgeToken(ctx.app) === undefined || vouched !== undefined
      ? undefined
      : (ctx.app.config.edgeName ?? "the platform");
  const unknownLink =
    kind === "signup" && ctx.url.searchParams.get("linked") === "unknown"
      ? html`<p class="muted small mb" id="linked-unknown" role="status">
          No account here is linked to that sign-in, and a linked sign-in never makes one.
          To get an account, make one with the form below.
        </p>`
      : null;

  // Only an operator who set `passkeyOnlySignup` gets a form with no
  // password: a name, an address and a passkey (`signup-passkey.ts`).
  const byPasskey = kind === "signup" && ctx.app.config.passkeyOnlySignup === true;

  // Sign-in leads with the passkey: one press, nothing typed; the password
  // form below stays for accounts that were given one. The button needs a
  // script and a browser with passkeys, so the block is `data-passkey="on"`: shown
  // only once `passkey-client.ts` marks `:root.passkey`. No "Passkey off"
  // badge here: a visitor signing in did not ask about passkeys, and with no
  // script the page is the password form alone, its margin included (#7921).
  // The form's Sign in comes in both variants, outline beside the lead and
  // primary everywhere else, so the page always has one primary action. The
  // sentence tells a newcomer before they look for a door that is not there.
  const mode = kind === "signin" ? timePhase(ctx.request, "settings", () => getSignup(ctx.app.db)) : undefined;
  const passkeyFirst = when(
    kind === "signin",
    () => html`<div class="stack stack-tight mb" data-passkey="on" hidden>
      <button type="button" id="passkey-signin" class="btn" data-variant="primary" data-size="lg">Sign in with a passkey</button>
      ${passkeyNote("passkey-signin-note")}
    </div>
    ${when(mode === undefined ? undefined : SIGNUP_SENTENCES[mode], (said) => html`<p class="muted small mb" id="signup-mode">${said}</p>`)}
    ${when(mode === "invite" || mode === "closed" ? mode : undefined, () => byInvitationLine())}`,
  );

  const body = html`${unknownLink}
    ${passkeyFirst}
    <form method="post" action="${action}">
      ${formField({
        label: "Username",
        name: "username",
        value: (kind === "signup" ? vouched : undefined) ?? values.username ?? "",
        autocomplete: "username",
        required: true,
        ...(vouched === undefined || kind !== "signup" ? { autofocus: true } : {}),
        ...(kind === "signup" && vouched !== undefined
          ? { readonly: true }
          : {}),
        ...(kind === "signup"
          ? {
              hint: "Letters, digits, dots and dashes.",
              pattern: "[A-Za-z0-9][A-Za-z0-9._-]*",
            }
          : {}),
        ...(errors.username ? { error: errors.username } : {}),
      })}
      ${when(kind === "signup", () =>
        formField({
          label: "Email",
          name: "email",
          type: "email",
          value: values.email ?? "",
          autocomplete: "email",
          hint: "Optional. If you add one, we send a link to confirm it. You need a confirmed email to send changes.",
          // A pinned name is not editable, so the keyboard goes to the email.
          ...(vouched !== undefined ? { autofocus: true } : {}),
          ...(errors.email ? { error: errors.email } : {}),
        }),
      )}
      ${when(!byPasskey, () =>
        formField({
          label: "Password",
          name: "password",
          type: "password",
          autocomplete: kind === "signin" ? "current-password" : "new-password",
          required: true,
          ...(kind === "signup"
            ? { minlength: 12, hint: "At least 12 characters." }
            : {}),
          ...(errors.password ? { error: errors.password } : {}),
        }),
      )}
      ${when(
        kind === "signup" ? siteKey(ctx) : undefined,
        (key) =>
          html`<div class="cf-turnstile mb" data-sitekey="${key}"></div>`,
      )}
      ${when(
        byPasskey,
        () => html`<p class="muted small mb">
          A passkey signs you in with a fingerprint, face or device PIN; there
          is no password to remember.
        </p>
        ${passkeyNote("passkey-signup-note")}
        <noscript><p class="muted small">Signing up needs JavaScript for the passkey.</p></noscript>`,
      )}
      ${when(
        kind === "signup" && !byPasskey,
        () => html`<div data-passkey="on" hidden>
          <p class="muted small mb">
            Or skip the password and use a passkey: your fingerprint, face or
            device PIN.
          </p>
          ${passkeyNote("passkey-signup-note")}
          <button type="button" id="passkey-signup" class="btn" data-variant="outline">Create account with a passkey</button>
        </div>`,
      )}
      ${when(
        kind === "signup" && getSignup(ctx.app.db) === "request",
        () => formField({
          label: "What do you want to build?",
          name: "note",
          type: "textarea",
          rows: 3,
          maxlength: NOTE_MAX,
          hint: "Optional. A line or two helps whoever looks at your request.",
        }),
      )}
      ${when(
        errors.human,
        (message) => html`<p class="error mb" role="alert">${message}</p>`,
      )}
      ${when(
        firstAccount,
        () =>
          html`<p class="muted small mb">
            This forge has no accounts yet. Accounts made here are not admins:
            the operator makes the site admin.
          </p>`,
      )}
      <div class="form-actions">
        ${byPasskey
          ? html`<button type="button" id="passkey-signup" class="btn" data-variant="primary">Create account with a passkey</button>`
          : kind === "signin"
            ? html`<button type="submit" class="btn" data-variant="outline" data-passkey="on" hidden>Sign in</button><button type="submit" class="btn" data-variant="primary" data-passkey="off">Sign in</button>`
            : btn(kind === "signup" && getSignup(ctx.app.db) === "request" ? "Ask for an account" : "Create account", { variant: "primary" })}
        <span class="spacer"></span>
        ${kind === "signin"
          ? // A closed forge has no door to point at: the sentence above says so.
            mode === "closed"
            ? null
            : btn("Need an account? Sign up", {
              href: "/signup",
              variant: "link",
              size: "sm",
            })
          : btn("Have an account? Sign in", {
              href: "/signin",
              variant: "link",
              size: "sm",
            })}
      </div>
    </form>`;

  // A spawned forge nobody has claimed yet: its person may arrive here with
  // the code from their link but not the link itself (#730).
  const unowned = !timePhase(ctx.request, "claim", () => hasAdmin(ctx.app.db));
  const claimable =
    existsSync(join(ctx.app.config.dataDir, "parent.json")) && unowned;
  return html`<div class="narrow">
    ${pageHead(kind === "signin" ? "Sign in" : getSignup(ctx.app.db) === "request" ? "Ask for an account" : "Create your account")}
    ${when(
      kind === "signup",
      () => html`<p class="mb" id="signup-you-get">${SIGNUP_YOU_GET} <a href="/forges/new">${SIGNUP_OWN_FORGE}</a></p>`,
    )}
    ${body}
    ${when(
      kind === "signin",
      () => html`<p class="mt"><a class="small" href="/recover">Lost your device?</a></p>`,
    )}
    ${kind === "signin" ? linkedMethods(edge, next, parentIssuerOf(ctx.app.config)) : null}
    ${claimable
      ? html`<p class="muted small mt" id="claim-door">
          Was this forge made for you? <a href="/claim">Claim it with your code</a>.
        </p>`
      : null}
    ${kind === "signin" && unowned
      ? html`<p class="muted small mt" id="first-admin-door">
          Have a first-admin code from this forge's operator? <a href="/first-admin">Use it</a>.
        </p>`
      : null}
  </div>`;
}

export function signinPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const body = authForm(ctx, "signin");
  return timePhase(ctx.request, "render", () =>
    page({ ctx, title: "Sign in", body, scriptJs: passkeyJs }),
  );
}

/** The widget's public site key, when signup is gated on Turnstile. */
function siteKey(ctx: Ctx): string | undefined {
  const { turnstileSecret, turnstileSiteKey } = ctx.app.config;
  return turnstileSecret === undefined ? undefined : turnstileSiteKey;
}

/** The token of the invite link this request came by, if any (`?invite=`). */
export function inviteOf(ctx: Ctx): string | undefined {
  const token = ctx.url.searchParams.get("invite") ?? "";
  return token === "" ? undefined : token;
}

/** The one place the forge says its accounts are closed: `/signin` (and `/signup` through its own message), never the home page (#11325). */
function byInvitationLine(): Html {
  return html`<p class="small mb" id="by-invitation">Accounts on this forge are by invitation. <a href="/#yours">Start your own forge instead.</a></p>`;
}

/** The whole of `/signup` while the forge makes no new accounts: a sentence, no form. */
function signupClosedPage(ctx: Ctx): Response {
  const said = inviteOf(ctx) === undefined ? SIGNUP_CLOSED_MESSAGE : INVITE_SPENT_MESSAGE;
  return page(
    {
      ctx,
      title: "Sign up",
      body: html`<div class="narrow stack">
        ${pageHead("Sign up")}
        <p>${said}</p>
        <p class="muted">You can still run a forge of your own, with no account here, and suggest a change to any public app here without one.</p>
        <div class="form-actions">
          ${btn("Get your own forge", { href: "/#yours", variant: "primary" })}
          ${btn("Sign in", { href: "/signin", variant: "outline" })}
        </div>
      </div>`,
    },
    403,
  );
}

export function signupPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  if (timePhase(ctx.request, "signup", () => signupClosed(ctx.app, inviteOf(ctx))))
    return timePhase(ctx.request, "render", () => signupClosedPage(ctx));
  const first = throughEdgeFirst(ctx);
  if (first) return first;
  const body = authForm(ctx, "signup");
  return timePhase(ctx.request, "render", () =>
    page({ ctx, title: "Sign up", body, turnstile: siteKey(ctx) !== undefined, scriptJs: passkeyJs }),
  );
}

/**
 * A sign-in attempt at `key` from this request's peer, counted in the
 * forge's sign-in windows (`core/signin-window.ts`). Seconds to wait when
 * refused, or undefined when the attempt may go on.
 */
export function signinAllowed(
  ctx: Ctx,
  key: string,
  options: { readonly forgeWide?: boolean } = {},
): number | undefined {
  return signinWindow(ctx.app.db, key, clientAddress(ctx.request), options);
}

/**
 * Sign-ups by the socket's peer (`actions/signup-window.ts`), asked by the
 * signup form, the API signup, the terminal's create screen and
 * the passkey door, which share one window.
 */
export function signupAllowed(ctx: Ctx): number | undefined {
  return signupWindow(ctx.app, clientAddress(ctx.request));
}

/** The same window, as the slot a stranger's account is made with, or the seconds to wait. */
export function signupSlot(ctx: Ctx): SignupSlot | number {
  return SignupSlot.take(ctx.app, clientAddress(ctx.request));
}

export async function signinSubmit(ctx: Ctx): Promise<Response> {
  // Posted by people with no account yet: a stranger's form.
  const form = await readForm(ctx, undefined, STRANGER_MAX);
  if (form instanceof Response) return form;
  const username = field(form, "username");
  const verified = await verifyPasswordThrottled(ctx.app.db, {
    username,
    password: field(form, "password"),
    source: clientAddress(ctx.request),
  });
  if (!verified.ok && verified.error.reason === "throttled") {
    const wait = verified.error.retryAfter;
    const response = page(
      {
        ctx,
        title: "Sign in",
        body: authForm(ctx, "signin", {
          values: { username },
          errors: {
            password: `Too many attempts. Try again in ${wait === 1 ? "a second" : `${wait} seconds`}.`,
          },
        }),
      },
      429,
    );
    response.headers.set("retry-after", String(wait));
    return response;
  }
  if (!verified.ok && verified.error.reason === "waiting") {
    const mine = getUserByName(ctx.app.db, verified.error.username);
    const declined = mine !== undefined && requestOf(ctx.app.db, mine.id)?.state === "declined";
    return requestPage(ctx, declined ? DECLINED_MESSAGE : STILL_WAITING_MESSAGE, declined ? "Not this time" : "Your request is waiting");
  }
  if (!verified.ok) {
    return page(
      {
        ctx,
        title: "Sign in",
        body: authForm(ctx, "signin", {
          values: { username },
          errors: {
            password:
              activeEdgeToken(ctx.app) === undefined
                ? "That username and password don't match."
                : `That username and password don't match. An account made through ${ctx.app.config.edgeName ?? "the platform"} has no password here — use the button above.`,
          },
        }),
      },
      422,
    );
  }
  const session = createSession(ctx.app.db, verified.value.id);
  return redirect(
    safeNext(ctx.url.searchParams.get("next")) ?? "/",
    sessionCookie(session.token, session.expiresAt, ctx.url, ctx.app.config.url),
  );
}

/** What a person whose request is in, waiting or declined is shown: a sentence, no owner's name. */
export function requestPage(ctx: Ctx, said: string, title = "Your request is in", status = 200): Response {
  return page(
    {
      ctx,
      title,
      body: html`<div class="narrow stack" id="request-state">
        ${pageHead(title)}
        <p>${said}</p>
        <div class="form-actions">
          ${btn("Sign in", { href: "/signin", variant: "outline" })}
          ${btn("Get your own forge", { href: "/#yours", variant: "ghost" })}
        </div>
      </div>`,
    },
    status,
  );
}

// GET /signup/requested — where a request lands: no session, nothing to act on yet.
export function requestedPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  return timePhase(ctx.request, "render", () =>
    ctx.url.searchParams.get("answer") === "declined"
      ? requestPage(ctx, DECLINED_MESSAGE, "Not this time")
      : requestPage(ctx, REQUEST_IN_MESSAGE));
}

// GET /verify?token= — the link in a verification email.
export function verifyPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const done = timePhase(ctx.request, "verify", () => verifyEmail(ctx.app, ctx.url.searchParams.get("token") ?? ""));
  return timePhase(ctx.request, "render", () => page(
    {
      ctx,
      title: done.ok ? "Email verified" : "Link not valid",
      body: done.ok
        ? html`<div class="page-head"><h1>Email verified</h1></div>
            <p>Thank you, ${done.value.username}. Your email is verified: you can make repositories, apps and runs now.</p>
            <p><a href="/">Go to the forge</a></p>`
        : html`<div class="page-head"><h1>This link is not valid</h1></div>
            <p>It has been used, or it has expired. Sign in and ask for another under Settings.</p>
            <p><a href="/settings">Settings</a></p>`,
    },
    done.ok ? 200 : 400,
  ));
}

export const EDGE_NAME_MESSAGE = "Sign up under the name your platform sign-in gave you.";

/**
 * Whether `username` is free to sign up. `invite` is the one the caller hands
 * to `signUp`, so closed-ness is decided from the same token on every door.
 * Behind an edge the edge's login is
 * the only name a newcomer may take, and one it has not vouched for takes
 * none: a name made here first would sign the platform's user of that name
 * into someone else's account.
 */
export function pinnedTo(ctx: Ctx, username: string, invite: string | undefined): boolean {
  const token = activeEdgeToken(ctx.app);
  // A closed door refuses on its own, and says so in its own words.
  if (token === undefined || signupClosed(ctx.app, invite)) return true;
  const vouched = edgeIdentity(ctx.request, token);
  return vouched !== undefined && vouched.toLowerCase() === username.toLowerCase();
}

/** Behind an edge, a visitor it has not vouched for goes through it first. */
function throughEdgeFirst(ctx: Ctx): Response | undefined {
  const token = activeEdgeToken(ctx.app);
  if (token === undefined || edgeIdentity(ctx.request, token) !== undefined) return undefined;
  const invite = inviteOf(ctx);
  if (signupClosed(ctx.app, invite)) return undefined;
  const query = invite === undefined ? "" : `?invite=${encodeURIComponent(invite)}`;
  return redirect(edgeLoginUrl(`/signup${query}`));
}

export async function signupSubmit(ctx: Ctx): Promise<Response> {
  // Posted by people with no account yet: a stranger's form.
  const form = await readForm(ctx, undefined, STRANGER_MAX);
  if (form instanceof Response) return form;
  const username = field(form, "username");
  const email = field(form, "email");
  const first = throughEdgeFirst(ctx);
  if (first) return first;
  if (!pinnedTo(ctx, username, inviteOf(ctx)))
    return page(
      {
        ctx,
        title: "Sign up",
        body: authForm(ctx, "signup", { values: { email }, errors: { username: EDGE_NAME_MESSAGE } }),
      },
      422,
    );
  const slot = signupSlot(ctx);
  if (typeof slot === "number") {
    const wait = slot;
    const response = page(
      {
        ctx,
        title: "Sign up",
        body: authForm(ctx, "signup", {
          values: { username, email },
          errors: {
            username: `Too many sign-ups from here; try again in ${wait === 1 ? "a second" : `${wait} seconds`}.`,
          },
        }),
        turnstile: siteKey(ctx) !== undefined,
        scriptJs: passkeyJs,
      },
      429,
    );
    response.headers.set("retry-after", String(wait));
    return response;
  }
  const created = await signUp(
    ctx.app,
    {
      username,
      email,
      password: field(form, "password"),
      humanToken: field(form, "cf-turnstile-response"),
      note: field(form, "note"),
    },
    { slot, invite: inviteOf(ctx), address: clientAddress(ctx.request) },
  );
  if (!created.ok) {
    if (created.error === "signup_closed") return signupClosedPage(ctx);
    const errors: AuthErrors = {
      invalid_username: {
        username: "Usernames are letters, digits, dots, dashes.",
      },
      username_taken: { username: USERNAME_TAKEN },
      username_reserved: { username: NAME_RESERVED },
      email_taken: { email: EMAIL_TAKEN_MESSAGE },
      password_too_long: { password: PASSWORD_TOO_LONG },
      weak_password: { password: "Passwords need at least 12 characters." },
      invalid_email: { email: "That does not look like an email address." },
      human_check: { human: HUMAN_CHECK_MESSAGE },
      passkey_required: { human: PASSKEY_REQUIRED_MESSAGE },
    }[created.error] ?? { username: "Something went wrong." };
    return page(
      {
        ctx,
        title: "Sign up",
        body: authForm(ctx, "signup", { values: { username, email }, errors }),
        turnstile: siteKey(ctx) !== undefined,
        scriptJs: passkeyJs,
      },
      422,
    );
  }
  // A request that waits has no session to start: it lands on the page that says so.
  if (created.value.waitingAt !== null) return redirect("/signup/requested");
  const session = createSession(ctx.app.db, created.value.id);
  return redirect(
    safeNext(ctx.url.searchParams.get("next")) ?? "/",
    sessionCookie(session.token, session.expiresAt, ctx.url, ctx.app.config.url),
  );
}

// POST /theme — persist the theme choice in a cookie. Works as a plain form
// submit (redirect back to the referring page) and as a background fetch from
// the switcher script; "system" clears the cookie so the OS decides again.
export async function themeSubmit(ctx: Ctx): Promise<Response> {
  // Posted by people with no account yet: a stranger's form.
  const form = await readForm(ctx, undefined, STRANGER_MAX);
  if (form instanceof Response) return form;
  const choice = field(form, "theme");
  const secure = secureFor(ctx.url, ctx.app.config.url) ? "; Secure" : "";
  const cookie = isThemeName(choice)
    ? `forge_theme=${choice}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${secure}`
    : `forge_theme=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${secure}`;

  // Return to the page the form was submitted from — same-origin paths only,
  // so the redirect can never be steered off this forge.
  const referer = ctx.request.headers.get("referer");
  let back = "/";
  if (referer !== null) {
    const parsed = URL.parse(referer);
    if (parsed && parsed.origin === ctx.url.origin)
      back = parsed.pathname + parsed.search;
  }
  return redirect(back, cookie);
}

export function logoutSubmit(ctx: Ctx): Response {
  if (crossOrigin(ctx.request, ctx.url, ctx.app.log))
    return forbiddenPage(ctx, SENT_FROM_ELSEWHERE, CAME_FROM_ELSEWHERE);
  signOutHere(ctx.app, cookieValue(ctx.request, "forge_session"));
  return redirect("/", sessionCookie("", new Date(0), ctx.url, ctx.app.config.url));
}

// ---- new repository ----

interface RepoValues {
  owner: string;
  name: string;
  description: string;
  visibility: string;
}

/** Owners the user may create under: themselves, plus orgs they can write to. */
function ownersFor(ctx: Ctx, user: User): string[] {
  const orgs = timePhase(ctx.request, "orgs", () => listOrgsForUser(ctx.app.db, user.id));
  const writeOrgs = timePhase(ctx.request, "access", () =>
    orgs.filter((org) => accessAllows(orgAccess(ctx.app.db, org.id, user), "write")),
  );
  return [user.username, ...writeOrgs.map((o) => o.username)];
}

function newRepoForm(ctx: Ctx, values: RepoValues, owners: string[], error?: string): Html {
  return html`<div class="narrow-wide" data-new-repo>
    ${pageHead("New repository", {
      sub: "A repository is a bare git repo plus its issues, pulls and settings.",
    })}
    <form method="post" action="/new">
      ${error ? html`<p class="error" role="alert">${error}</p>` : null}
        ${selectField({
          label: "Owner",
          name: "owner",
          options: owners.map((o) => ({
            value: o,
            label: o,
            selected: o === values.owner,
          })),
        })}
        ${formField({
          label: "Name",
          name: "name",
          value: values.name,
          required: true,
          autofocus: true,
          pattern: "[A-Za-z0-9][A-Za-z0-9._-]*",
          hint: "Letters, digits, dots, dashes and underscores.",
        })}
        ${formField({
          label: "Description",
          name: "description",
          value: values.description,
          hint: "Optional. One line, shown wherever the repo is listed.",
        })}
        ${selectField({
          label: "Visibility",
          name: "visibility",
          hint: "Private repositories are invisible to everyone but you and your teams.",
          options: [
            {
              value: "private",
              label: "Private",
              selected: values.visibility !== "public",
            },
            {
              value: "public",
              label: "Public",
              selected: values.visibility === "public",
            },
          ],
        })}
        <div class="form-actions">
          ${btn("Create repository", { variant: "primary" })}
          ${btn("Cancel", { href: "/", variant: "ghost" })}
        </div>
    </form>
  </div>`;
}

export function newRepoPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const owners = ownersFor(ctx, ctx.auth.user);
  const rendering = performance.now();
  const response = page({
    ctx,
    title: "New repository",
    body: newRepoForm(
      ctx,
      {
        owner: ctx.url.searchParams.get("owner") ?? ctx.auth.user.username,
        name: "",
        description: "",
        visibility: "private",
      },
      owners,
    ),
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

export async function newRepoSubmit(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const values: RepoValues = {
    owner: field(form, "owner"),
    name: field(form, "name"),
    description: field(form, "description"),
    visibility: form.get("visibility") === "public" ? "public" : "private",
  };
  const created = await createRepo(ctx.app, ctx.auth.user, {
    owner: values.owner,
    name: values.name,
    visibility: values.visibility === "public" ? "public" : "private",
    description: values.description,
  });
  if (!created.ok) {
    if (created.error === "forbidden_owner" || created.error === "unauthorized")
      return forbiddenPage(ctx, NOT_YOURS_TO_DO);
    const messages: Record<string, string> = {
      not_member: `Not made: ${NOT_A_MEMBER}.`,
      repository_limit: `Not made: ${repositoryLimitMessage(ctx.app, ctx.auth.user)}.`,
      storage_limit: `Not made: ${storageLimitMessage(ctx.app, resolveOwner(ctx.app, ctx.auth.user, values.owner) ?? ctx.auth.user.id)}.`,
      name_taken: "That owner already has a repository by that name.",
      invalid_name: REPO_NAME_RULES,
      git_init_failed: REPO_INIT_FAILED,
    };
    return page(
      {
        ctx,
        title: "New repository",
        body: newRepoForm(
          ctx,
          values,
          ownersFor(ctx, ctx.auth.user),
          messages[created.error] ?? "That name won't work.",
        ),
      },
      422,
    );
  }
  return flashTo(ctx, `/${created.value.ownerName}/${created.value.name}`, {
    message: "Repository created.",
  });
}
