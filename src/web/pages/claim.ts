/**
 * `/claim`: the page a spawned child's link opens (`spawn/claim.ts`).
 * The link is `/claim#<token>`, so the secret never leaves the browser in a
 * request line. The person a forge was made for opens it, reads who will be
 * able to see the forge, and makes their account with a username and a
 * password (email optional, the checks signup's own) or with a passkey
 * (`passkey-ceremony.ts`; that one needs an email). They land in their
 * forge as its admin.
 *
 * The GET only shows the form — a link unfurled in a chat app must not
 * spend itself — and the POST, same-origin, makes the account and burns the
 * link in one step. A link that is used, expired or made up says which,
 * plainly; a forge that was not spawned has no claim page at all.
 *
 * Who keeps access is never silent. By default the spawner's account leaves
 * the organisation's Owners when the forge is claimed (the new owner can
 * invite them back); when the spawner asked to keep access, the page says
 * so before anyone submits, and where to remove it.
 */

import { crewCanRun, hasCrew } from "../studio/crew_key.ts";
import { PASSWORD_TOO_LONG, withinPasswordCap } from "../../core/hash-gate.ts";
import { givenEmail, MIN_SIGNUP_PASSWORD, noEmail } from "../../actions/users.ts";
import type { Credential } from "../../auth/webauthn.ts";
import { crossOrigin, type Ctx } from "../../http/context.ts";
import { STRANGER_MAX } from "../../http/limits.ts";
import { clientAddress } from "../../http/peer.ts";
import { boundedBody, json, str } from "../../http/respond.ts";
import { addPasskey } from "../../core/passkeys.ts";
import {
  listTeamMembers,
  listTeams,
  OWNERS_TEAM,
  type Team,
} from "../../core/orgs.ts";
import {
  notePhase,
  takeSessionTime,
  timePhase,
  timePhaseAsync,
} from "../../core/route_timing.ts";
import { createSession } from "../../core/sessions.ts";
import { createUser, discardFreshUser, getUserByName, type User } from "../../core/users.ts";
import {
  burnClaim,
  becomeOrg,
  founderToTake,
  isForgeName,
  linkOf,
  handOver,
  isPlaceholderFounder,
  readClaim,
  spawnedOrg,
  takeFounder,
  unburnClaim,
  type ClaimState,
  type Spawned,
} from "../../spawn/claim.ts";
import { pageHead, CAME_FROM_ELSEWHERE } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { page, redirect } from "../layout.ts";
import { makeOptions, PASSKEY_WORDS, passkeyFields, readPasskey } from "../passkey-ceremony.ts";
import { passkeyJs } from "../passkey-client.ts";
import { passkeyNote, passkeyState } from "../passkey-state.ts";
import { btn, field as formField } from "../ui.ts";
import { sessionCookie, signinAllowed } from "./site.ts";
import { EMAIL_TAKEN_MESSAGE, NAME_RESERVED, USERNAME_TAKEN } from "../../actions/signup_words.ts";

const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}$/;

interface Values {
  readonly username?: string;
  readonly email?: string;
  /** The claim code, from the form's body. */
  readonly token?: string;
}
type Errors = Partial<Record<"username" | "email" | "password" | "passkey", string>>;

/** `Nov 12, 14:30 UTC`, from an ISO time. */
function whenWords(iso: string): string {
  const d = new Date(iso);
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return `${month} ${d.getUTCDate()}, ${iso.slice(11, 16)} UTC`;
}

/** "in 5 hours", "in 12 minutes", or "a minute ago", from a span in ms. */
export function relativeWords(ms: number): string {
  const mins = Math.max(1, Math.round(Math.abs(ms) / 60_000));
  const [n, unit] =
    mins < 60 ? [mins, "minute"] : mins < 2880 ? [Math.round(mins / 60), "hour"] : [Math.round(mins / 1440), "day"];
  const span = `${n} ${unit}${n === 1 ? "" : "s"}`;
  return ms >= 0 ? `in ${span}` : `${span} ago`;
}

function dead(
  ctx: Ctx,
  state: Exclude<ClaimState["state"], "ok">,
  sender?: string,
  endedAt?: string,
  own = false,
): Response {
  const ask = sender === undefined ? "whoever sent it" : sender;
  const says = {
    unknown: {
      status: 404,
      title: "This is not a forge link",
      text: "The link may have been cut short, or replaced by a newer one. Ask whoever sent it for the latest.",
    },
    used: {
      status: 410,
      title: "This link has already been used",
      text: `Each link works once. If it was you, sign in with the account you made; if not, ask ${ask} to send you a new one.`,
    },
    expired: {
      status: 410,
      title: "This link has expired",
      text: `It stopped working${endedAt === undefined ? "" : ` on ${whenWords(endedAt)}`}. Ask ${ask} to send you a new one.`,
    },
    revoked: {
      status: 410,
      title: "This link has ended",
      text: `Whoever sent it took it back. Ask ${ask} to send you a new one.`,
    },
    owned: {
      status: 410,
      title: "This forge already has an owner",
      text: "Someone has already made this forge theirs. If it was you, sign in.",
    },
  }[state];
  // The person who started this forge themselves has no sender to ask.
  const mine: Partial<Record<typeof state, string>> = {
    unknown: "The link may have been cut short or replaced. Start the forge again from the home page.",
    used: "Each link works once. If it was you, sign in with the account you made. Otherwise start a forge of your own from the home page.",
    expired: "Your link stopped working. Start the forge again from the home page.",
    revoked: "This link has ended. Start the forge again from the home page.",
  };
  if (own) says.text = mine[state] ?? says.text;
  return page(
    {
      ctx,
      title: says.title,
      body: html`<div class="narrow">
        ${pageHead(says.title)}
        <section class="settings-block">
          <p>${says.text}</p>
          ${state === "used" || state === "owned"
            ? html`<div class="form-actions">
                ${btn("Sign in", { href: "/signin", variant: "primary" })}
              </div>`
            : null}
        </section>
      </div>`,
    },
    says.status,
  );
}

/** The organisation's Owners team and the spawner on it, before the claim. */
function owners(
  ctx: Ctx,
  spawned: Spawned,
): { team: Team | undefined; spawner: User | undefined } {
  const team = listTeams(ctx.app.db, spawned.org.id).find(
    (t) => t.name === OWNERS_TEAM,
  );
  const first = team === undefined ? undefined : listTeamMembers(ctx.app.db, team.id)[0];
  // The placeholder an anonymous start made is no person to name (#11785):
  // told by the start's record, never by the account's name.
  return { team, spawner: isPlaceholderFounder(spawned, first) ? undefined : first };
}

/** One plain sentence: who can see this forge once it is claimed. */
function accessSentence(spawned: Spawned, spawner: User | undefined): string {
  const who = spawner?.username ?? "Whoever made it";
  // An anonymous start has no one to name: never the placeholder account (#11785).
  if (spawner === undefined && !spawned.keepAccess) {
    return "Once you open it as yours, only you can see its private work.";
  }
  return spawned.keepAccess
    ? `${who} keeps owner access to this forge; you can remove it in your organisation's Owners team.`
    : `Once you open it as yours, only you can see its private work: ${who}, who made it, no longer has access unless you invite them back.`;
}

/**
 * Where the claim would take over the spawn-made founder (`founderToTake`),
 * the page says so: claiming under the spawner's name becomes their account
 * here, with what the spawn made under it. Deliberate, and never silent.
 */
function takeover(ctx: Ctx, spawned: Spawned, spawner: User | undefined): Html | null {
  if (spawner === undefined || founderToTake(ctx.app, spawned, spawner.username) === undefined)
    return null;
  return html`<p class="mb" id="claim-takeover">Open it as ${spawner.username} and you will take over ${spawner.username}'s account on this forge, with everything already made under it.</p>`;
}

function claimForm(
  ctx: Ctx,
  spawned: Spawned,
  spawner: User | undefined,
  values: Values,
  errors: Errors,
  expiresAt?: string,
  own = false,
): Html {
  if (own) return welcomeForm(values, errors);
  return html`<div class="narrow">
    ${pageHead("This forge is yours")}
    <section class="settings-block">
      <p class="mb">
          ${spawned.org.username} was made for you, with its apps and
          ${crewCanRun(ctx.app) && hasCrew(ctx.app)
            ? "a crew ready to build them"
            : "a crew that builds them once you add a model key"}. Make your account to take it: this first account
          is the forge's admin, so it can change everything here.
        </p>
        ${expiresAt === undefined
          ? null
          : html`<p class="mb" id="claim-expiry">This link works until
              <time datetime="${expiresAt}">${whenWords(expiresAt)}</time>
              (${relativeWords(Date.parse(expiresAt) - Date.now())}). After that, ask
              ${spawner?.username ?? "whoever sent it"} to send you a new one.</p>`}
        <p class="mb" id="claim-access">${accessSentence(spawned, spawner)}</p>
        ${takeover(ctx, spawned, spawner)}
        <form method="post" action="/claim">
          <div id="claim-token-field">
            ${formField({
              label: "Link code",
              name: "token",
              value: values.token ?? "",
              required: true,
              hint: "The part of your link after the #. Opening the link fills it in.",
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
            pattern: "[A-Za-z0-9][A-Za-z0-9._-]*",
            ...(errors.username ? { error: errors.username } : {}),
          })}
          ${formField({
            label: "Email",
            name: "email",
            type: "email",
            value: values.email ?? "",
            autocomplete: "email",
            hint: "Optional. A passkey needs one.",
            ...(errors.email ? { error: errors.email } : {}),
          })}
          ${formField({
            label: "Password",
            name: "password",
            type: "password",
            autocomplete: "new-password",
            minlength: MIN_SIGNUP_PASSWORD,
            hint: `At least ${MIN_SIGNUP_PASSWORD} characters.`,
            ...(errors.password ? { error: errors.password } : {}),
          })}
          ${passkeyFields()}
          <div class="form-actions">
            <button type="submit" class="btn" data-variant="primary">Make this forge mine</button>
          </div>
          <div class="stack stack-tight">
            ${passkeyState()}
            <div data-passkey="on" hidden>
            <p class="muted small mb">
              Or skip the password: a passkey signs you in with a fingerprint,
              face or device PIN. It needs an email address above.
            </p>
            ${passkeyNote("passkey-make-note", errors.passkey)}
            <button type="button" id="passkey-make" class="btn" data-variant="outline" data-options="/claim/options" data-needs-email>Use a passkey instead</button>
            </div>
          </div>
        </form>
    </section>
  </div>`;
}

/** The screen for the person who started this forge themselves: a username and a password, nothing about anyone else. */
function welcomeForm(values: Values, errors: Errors): Html {
  return html`<div class="narrow">
    ${pageHead("Make your account")}
    <section class="settings-block">
      <p class="mb">Choose a username and a password. This account is yours alone, and you are the admin of this forge.</p>
      <form method="post" action="/welcome">
        <div id="claim-token-field">
          ${formField({
            label: "Link code",
            name: "token",
            value: values.token ?? "",
            required: true,
            hint: "The part of your link after the #. Opening the link fills it in.",
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
          pattern: "[A-Za-z0-9][A-Za-z0-9._-]*",
          ...(errors.username ? { error: errors.username } : {}),
        })}
        ${formField({
          label: "Password",
          name: "password",
          type: "password",
          autocomplete: "new-password",
          minlength: MIN_SIGNUP_PASSWORD,
          hint: `At least ${MIN_SIGNUP_PASSWORD} characters.`,
          ...(errors.password ? { error: errors.password } : {}),
        })}
        <div class="form-actions">
          <button type="submit" class="btn" data-variant="primary">Done</button>
        </div>
      </form>
    </section>
  </div>`;
}

/**
 * The fragment link's page script: take the claim code from `#…` into the
 * form and drop it from the address bar, so it is never in a request line,
 * a Referer, the history or a screenshot of the URL. Without JavaScript the
 * code field stays visible and takes a paste.
 */
const fragmentJs = /* js */ `
(function () {
  var field = document.querySelector('input[name="token"]');
  if (!field) return;
  var code = location.hash.slice(1);
  if (!code) return;
  field.value = code;
  var box = document.getElementById('claim-token-field');
  if (box) box.hidden = true;
  history.replaceState(null, '', location.pathname + location.search);
})();
`;

// GET /claim — the form for a fragment link: the code arrives in the
// browser only, so nothing is known or spent here until the form posts it.
export const claimFragmentPage = (ctx: Ctx): Promise<Response> => fragmentPage(ctx, false);
/** GET /welcome — the same, for the person who started the forge. */
export const welcomePage = (ctx: Ctx): Promise<Response> => fragmentPage(ctx, true);

async function fragmentPage(ctx: Ctx, own: boolean): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const spawned = await timePhaseAsync(ctx.request, "spawned", () => spawnedOrg(ctx.app));
  if (spawned === undefined) return timePhase(ctx.request, "render", () => dead(ctx, "unknown", undefined, undefined, own));
  const { spawner } = timePhase(ctx.request, "owners", () => owners(ctx, spawned));
  // The forge has one link at a time, so its state says nothing about any
  // particular code: a stale or made-up code only ever meets "unknown" on the POST.
  const link = linkOf(ctx.app.db);
  if (link !== null && link.state !== "open")
    return dead(
      ctx,
      link.state === "used" ? "used" : link.revokedAt !== null ? "revoked" : "expired",
      own ? undefined : spawner?.username,
      link.expiresAt,
      own,
    );
  const rendering = performance.now();
  const response = page({
    ctx,
    title: own ? "Make your account" : "This forge is yours",
    body: claimForm(ctx, spawned, spawner, {}, {}, link?.expiresAt, own),
    scriptJs: own ? fragmentJs : fragmentJs + passkeyJs,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

/**
 * Whether a name and address are fit for the first admin; else the words.
 * The address is optional unless a passkey is being made.
 */
function problems(
  ctx: Ctx,
  spawned: Spawned,
  username: string,
  email: string,
  needEmail: boolean,
): Errors {
  const errors: Errors = {};
  if (!USERNAME.test(username))
    errors.username = "Usernames are letters, digits, dots, dashes.";
  // The spawn-made founder holds the spawner's own name; the claim may take
  // it over (`founderToTake`), so it is not "taken" to the claimant.
  else if (
    getUserByName(ctx.app.db, username) &&
    founderToTake(ctx.app, spawned, username) === undefined &&
    !isForgeName(spawned, username)
  )
    errors.username = USERNAME_TAKEN;
  if (email !== "" ? !givenEmail(email) : needEmail)
    errors.email = "That does not look like an email address.";
  return errors;
}

/** Why a passkey challenge was refused, in the passkey note's plain words. */
const LINK_REFUSED: Record<Exclude<ClaimState["state"], "ok">, string> = {
  unknown: "This is not a forge link.",
  used: "This link has already been used.",
  expired: "This link has expired.",
  revoked: "This link has ended.",
  owned: "This forge already has an owner.",
};

// POST /claim/options — a passkey challenge, for a live link and a fit name.
// Nothing is spent: the link burns only when the key comes back.
export async function claimOptions(ctx: Ctx): Promise<Response> {
  const refuse = (status: number, message: string) =>
    json({ error: "refused", message }, status);
  if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return refuse(403, CAME_FROM_ELSEWHERE);
  const wait = signinAllowed(ctx, `claim:${clientAddress(ctx.request)}`);
  if (wait !== undefined)
    return json({ error: "rate_limited", message: `Too many attempts. Try again in ${wait}s.` }, 429, { "retry-after": String(wait) });
  const data = await boundedBody(ctx.request, STRANGER_MAX);
  if (data === "too_large") return refuse(413, "payload too large");
  const spawned = await spawnedOrg(ctx.app);
  if (spawned === undefined) return refuse(404, LINK_REFUSED.unknown);
  const state = readClaim(ctx.app.db, spawned.org.id, str(data.token)).state;
  if (state !== "ok") return refuse(state === "unknown" ? 404 : 410, LINK_REFUSED[state]);
  const username = str(data.username).trim();
  const bad = problems(ctx, spawned, username, str(data.email).trim(), true);
  const first = bad.username ?? bad.email;
  if (first !== undefined) return refuse(422, first);
  return json(makeOptions(ctx, "claim", username));
}

// POST /claim — make the account, burn the link, sign the person in.
export const claimSubmit = (ctx: Ctx): Promise<Response> => submit(ctx, false);
/** POST /welcome — the same, for the person who started the forge. */
export const welcomeSubmit = (ctx: Ctx): Promise<Response> => submit(ctx, true);

async function submit(ctx: Ctx, own: boolean): Promise<Response> {
  const form = await readForm(ctx);
  if (form instanceof Response) return form;
  const spawned = await spawnedOrg(ctx.app);
  if (spawned === undefined) return dead(ctx, "unknown", undefined, undefined, own);
  const orgId = spawned.org.id;
  // From the form's body — never from the path or a query string, which
  // proxies and logs would keep.
  const token = field(form, "token");
  const before = readClaim(ctx.app.db, orgId, token);
  const { spawner } = owners(ctx, spawned);
  if (before.state !== "ok")
    return dead(ctx, before.state, own ? undefined : spawner?.username, linkOf(ctx.app.db)?.expiresAt, own);

  const values = {
    username: field(form, "username"),
    email: field(form, "email"),
    token,
  };
  const again = (e: Errors) =>
    page(
      {
        ctx,
        title: own ? "Make your account" : "This forge is yours",
        body: claimForm(ctx, spawned, spawner, values, e, linkOf(ctx.app.db)?.expiresAt, own),
        scriptJs: own ? fragmentJs : passkeyJs,
      },
      422,
    );
  const password = typeof form.get("password") === "string" ? (form.get("password") as string) : "";
  const withKey = field(form, "attestationObject") !== "";
  const errors = problems(ctx, spawned, values.username, values.email.trim(), withKey);
  if (!withKey && password.length < MIN_SIGNUP_PASSWORD)
    errors.password = `Passwords need at least ${MIN_SIGNUP_PASSWORD} characters.`;
  else if (!withinPasswordCap(password)) errors.password = PASSWORD_TOO_LONG;
  if (Object.keys(errors).length > 0) return again(errors);
  // A key in the form is the passkey door; none is the password door.
  let credential: Credential | undefined;
  if (withKey) {
    const key = await readPasskey(ctx, "claim", form);
    if (!key.ok) return again({ passkey: PASSKEY_WORDS[key.error] });
    credential = key.value;
  }

  const email = values.email.trim() === "" ? noEmail(values.username) : values.email.trim();
  // Hashed before the link is spent: nothing is awaited between the burn
  // and the takeover.
  const founder = founderToTake(ctx.app, spawned, values.username);
  const takesName = founder === undefined && isForgeName(spawned, values.username);
  const founderHash =
    (founder === undefined && !takesName) || credential !== undefined ? "" : await Bun.password.hash(password, "argon2id");
  // Spent first, in one statement: of two people on one link, one wins.
  const spent = burnClaim(ctx.app.db, orgId, token);
  if (spent.state !== "ok") return dead(ctx, spent.state, undefined, undefined, own);
  if (founder !== undefined) {
    const taken = takeFounder(ctx.app.db, founder.id, {
      hash: founderHash,
      email,
      ...(credential === undefined ? {} : { credential }),
    });
    if (taken !== "ok") {
      unburnClaim(ctx.app.db, orgId, token);
      return again(
        taken === "email_taken"
          ? { email: EMAIL_TAKEN_MESSAGE }
          : { username: USERNAME_TAKEN },
      );
    }
    return claimed(ctx, spawned, founder);
  }
  if (takesName) {
    // The forge's own name: its organisation row becomes the account, so the
    // apps under it stay put (#11948).
    const taken = becomeOrg(ctx.app.db, spawned.org.id, { hash: founderHash, email, ...(credential === undefined ? {} : { credential }) });
    if (taken !== "ok") {
      unburnClaim(ctx.app.db, orgId, token);
      return again(taken === "email_taken" ? { email: EMAIL_TAKEN_MESSAGE } : { username: USERNAME_TAKEN });
    }
    const person = getUserByName(ctx.app.db, values.username);
    if (person === undefined) return again({ username: USERNAME_TAKEN });
    return claimed(ctx, spawned, person);
  }
  const made = await createUser(ctx.app.db, {
    username: values.username,
    email,
    ...(credential === undefined ? { password } : {}),
    isAdmin: true,
    // The one-time claim link the owner handed out is the proof.
    trusted: true,
    origin: "claim",
  });
  if (!made.ok) {
    unburnClaim(ctx.app.db, orgId, token);
    return again(
      made.error === "email_taken"
        ? { email: EMAIL_TAKEN_MESSAGE }
        : made.error === "username_reserved"
          ? { username: NAME_RESERVED }
          : { username: USERNAME_TAKEN },
    );
  }
  if (credential !== undefined && !addPasskey(ctx.app.db, made.value.id, "Passkey", credential).ok) {
    discardFreshUser(ctx.app.db, made.value.id);
    unburnClaim(ctx.app.db, orgId, token);
    return again({ passkey: PASSKEY_WORDS.taken });
  }
  return claimed(ctx, spawned, made.value);
}

/** The claimant is in: an owner, signed in, sent home. */
function claimed(ctx: Ctx, spawned: Spawned, user: User): Response {
  // As the page said: unless the spawner kept access, they leave now.
  handOver(ctx.app.db, spawned, user.id);
  ctx.app.log.info("forge claimed", {
    org: spawned.org.username,
    user: user.username,
    spawnerKeeps: spawned.keepAccess,
  });
  const session = createSession(ctx.app.db, user.id);
  // Home: where the crew's work shows (its first-login screen is #600).
  return redirect(
    "/",
    sessionCookie(session.token, session.expiresAt, ctx.url, ctx.app.config.url),
  );
}
