/**
 * The everyday account card and its two answers (`core/everyday.ts`). The
 * path: a forge's admin lands on the home; one card asks them to make an
 * everyday account and says why in two sentences; **Make it** creates an
 * ordinary account, links it to the admin and signs them in as it, and
 * **Keep using admin** records the choice so the card goes. Either way they
 * land on the home. Admin only, same-origin.
 */

import {
  adminOf,
  askForEveryday,
  everydayOf,
  EVERYDAY_WHY,
  keepAdmin,
  joinAsWriter,
  linkEveryday,
} from "../../core/everyday.ts";
import { spawnedOrg } from "../../spawn/claim.ts";
import { requireVerified } from "../../actions/verify.ts";
import { createSession } from "../../core/sessions.ts";
import { createUser, discardFreshUser, getUserByName, type User } from "../../core/users.ts";
import { addPasskey } from "../../core/passkeys.ts";
import { cookieValue, crossOrigin, type Ctx } from "../../http/context.ts";
import { STRANGER_MAX } from "../../http/limits.ts";
import { boundedBody, json, str } from "../../http/respond.ts";
import { forbiddenPage, NOT_ADMIN_HERE, CAME_FROM_ELSEWHERE, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo, redirect } from "../layout.ts";
import { makeOptions, PASSKEY_WORDS, passkeyFields, readPasskey } from "../passkey-ceremony.ts";
import { passkeyNote } from "../passkey-state.ts";
import { btn, card, field as formField } from "../ui.ts";
import { signOutHere } from "../../actions/signins.ts";
import { sessionCookie } from "./site.ts";
import { EMAIL_TAKEN_MESSAGE, EMAIL_WANTED, USERNAME_TAKEN } from "../../actions/signup_words.ts";

const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}$/;

/** The everyday name offered first: the admin's, with `-me`, if it is free. */
function suggestedName(ctx: Ctx, admin: User): string {
  const name = `${admin.username}-me`;
  return getUserByName(ctx.app.db, name) === undefined ? name : "";
}

/** The card, for an admin with no everyday account and no recorded choice. */
export function everydayCard(ctx: Ctx, user: User): Html | null {
  if (!askForEveryday(ctx.app.db, user)) return null;
  return html`<div class="mb">${everydayForm(ctx, user, true)}</div>`;
}

/**
 * Who this account is paired with, for its account page: the everyday
 * account of an admin, the admin of an everyday account, or — for an admin
 * who chose to keep working as admin — the same form, without "keep".
 */
export function everydayLine(ctx: Ctx, user: User): Html | null {
  const db = ctx.app.db;
  const daily = everydayOf(db, user);
  if (daily)
    return html`<div class="mb" id="everyday-pair">
      <p class="muted">
        Your everyday account is <a href="/${daily.username}">${daily.username}</a>.
        Use it day to day; this one is for changing the forge.
      </p>
      <form method="post" action="/settings/everyday/switch" class="mt">
        ${btn(`Sign in as ${daily.username}`, { size: "sm" })}
      </form>
    </div>`;
  const admin = adminOf(db, user);
  if (admin)
    return html`<p class="muted mb" id="everyday-pair">
      This is the everyday account of <a href="/${admin.username}">${admin.username}</a>,
      who administers this forge.
    </p>`;
  if (user.isAdmin && user.kind === "user") return everydayForm(ctx, user, false);
  return null;
}

function everydayForm(ctx: Ctx, user: User, offerKeep: boolean): Html {
  return card(
    html`<p class="mb">${EVERYDAY_WHY}</p>${everydayFields(ctx, user, offerKeep)}`,
    { id: "everyday", head: html`<h2>Make your everyday account</h2>` },
  );
}

/** The form alone, for a card that says why itself (the first-login steps, #600). */
export const everydayAsk = (ctx: Ctx, user: User): Html =>
  everydayFields(ctx, user, true);

function everydayFields(ctx: Ctx, user: User, offerKeep: boolean): Html {
  return html`<form method="post" action="/settings/everyday" class="stack">
        ${formField({
          label: "Username",
          name: "username",
          value: suggestedName(ctx, user),
          autocomplete: "username",
          required: true,
          pattern: "[A-Za-z0-9][A-Za-z0-9._-]*",
        })}
        ${formField({
          label: "Email",
          name: "email",
          type: "email",
          autocomplete: "email",
          required: true,
        })}
        ${passkeyFields()}
        <p class="muted small">
          It signs in with a passkey of its own: a fingerprint, face or
          device PIN. There is no password.
        </p>
        ${passkeyNote("passkey-make-note")}
        <noscript><p class="muted small">Making the passkey needs JavaScript.</p></noscript>
        <div class="form-actions">
          <button type="submit" id="passkey-make" class="btn" data-variant="primary" data-options="/settings/everyday/options">Make it with a passkey</button>
          <span class="spacer"></span>
          ${offerKeep ? btn("Keep using admin", {
            form: "everyday-keep",
            variant: "link",
            size: "sm",
          }) : null}
        </div>
      </form>
      <form
        id="everyday-keep"
        method="post"
        action="/settings/everyday/keep"
        hidden
      ></form>`;
}

/** Why `username` cannot be the everyday account's name, or undefined. */
function nameProblem(ctx: Ctx, username: string): string | undefined {
  if (!USERNAME.test(username)) return "Usernames are letters, digits, dots, dashes.";
  if (getUserByName(ctx.app.db, username)) return USERNAME_TAKEN;
  return undefined;
}

// POST /settings/everyday/options — a passkey challenge for the everyday
// account, for a signed-in admin without one. Nothing is written.
export async function everydayOptions(ctx: Ctx): Promise<Response> {
  const refuse = (status: number, message: string) =>
    json({ error: "refused", message }, status);
  if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return refuse(403, CAME_FROM_ELSEWHERE);
  const admin = ctx.auth.user;
  if (!admin) return refuse(401, "Sign in first.");
  if (ctx.auth.via !== "session") return refuse(403, "Passkeys are made from a signed-in browser.");
  if (!admin.isAdmin) return refuse(403, NOT_ADMIN_HERE);
  if (everydayOf(ctx.app.db, admin) !== undefined)
    return refuse(409, "You already have an everyday account.");
  const data = await boundedBody(ctx.request, STRANGER_MAX);
  if (data === "too_large") return refuse(413, "payload too large");
  const username = str(data.username).trim();
  const bad = nameProblem(ctx, username) ?? (str(data.email).includes("@") ? undefined : EMAIL_WANTED);
  if (bad !== undefined) return refuse(422, bad);
  return json(makeOptions(ctx, "everyday", username));
}

// POST /settings/everyday — make the everyday account, link it, sign in as it.
export async function everydayCreate(ctx: Ctx): Promise<Response> {
  const admin = ctx.auth.user;
  if (!admin) return signInFirst(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  if (!admin.isAdmin) return forbiddenPage(ctx, NOT_ADMIN_HERE);
  const existing = everydayOf(ctx.app.db, admin);
  if (existing !== undefined)
    return flashTo(ctx, "/settings", {
      message: `You already have an everyday account, ${existing.username}: sign in as it below.`,
    });
  const username = field(form, "username");
  const email = field(form, "email");
  const say = (message: string) =>
    flashTo(ctx, "/", { tone: "danger", message });
  const bad = nameProblem(ctx, username);
  if (bad !== undefined) return say(bad);
  // The key, or nothing: a password in the form is not read at all.
  const key = await readPasskey(ctx, "everyday", form);
  if (!key.ok) return say(PASSKEY_WORDS[key.error]);
  // The same names a sign-up may not take (a crew member's, a page's,
  // another admin's), held where accounts are made; the admin's own handle
  // may appear in their everyday name ("ada-me"). A proven admin vouches for their own second account, as a claim
  // vouches for the first: held back, it could not tell the crew.
  const made = await createUser(ctx.app.db, {
    username,
    email,
    reservedSelf: admin.id,
    trusted: requireVerified(ctx.app, admin).ok,
    origin: "everyday",
  });
  if (!made.ok)
    return say(
      made.error === "username_taken"
        ? USERNAME_TAKEN
        : made.error === "email_taken"
          ? EMAIL_TAKEN_MESSAGE
          : made.error === "username_reserved"
            ? "That name is taken by the forge itself; pick another."
            : "That account could not be made.",
    );
  if (!addPasskey(ctx.app.db, made.value.id, "Passkey", key.value).ok) {
    discardFreshUser(ctx.app.db, made.value.id);
    return say(PASSKEY_WORDS.taken);
  }
  linkEveryday(ctx.app.db, admin, made.value);
  // On a spawned forge the apps are the client's org's: the everyday
  // account writes to it, or it could not open or tell the crew anything.
  const spawned = await spawnedOrg(ctx.app);
  if (spawned && !joinAsWriter(ctx.app.db, spawned.org, made.value))
    // Signed in as it, the account would see nothing: the admin stays, at
    // the org's teams, where the one fix is.
    return flashTo(ctx, `/${spawned.org.username}#teams`, {
      tone: "danger",
      message: `${made.value.username} was made but could not join ${spawned.org.username}: add it to a team that writes there, then sign in as it.`,
    });
  const session = createSession(ctx.app.db, made.value.id);
  return redirect("/", {
    cookie: sessionCookie(session.token, session.expiresAt, ctx.url, ctx.app.config.url),
    url: ctx.url,
    forgeUrl: ctx.app.config.url,
    flash: {
      message: `You are signed in as ${made.value.username}, your everyday account. Sign in as ${admin.username} when you mean to change the forge.`,
    },
  });
}

// POST /settings/everyday/keep — the admin keeps working as admin, on purpose.
export async function everydayKeep(ctx: Ctx): Promise<Response> {
  const admin = ctx.auth.user;
  if (!admin) return signInFirst(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  if (!admin.isAdmin) return forbiddenPage(ctx, NOT_ADMIN_HERE);
  keepAdmin(ctx.app.db, admin);
  return flashTo(ctx, "/", {
    message:
      "You keep working as admin. Your account page has the way to an everyday account whenever you want one.",
  });
}

// POST /settings/everyday/switch — leave the admin account for the everyday
// one: this session ends, and sign-in says as whom to come back.
export async function everydaySwitch(ctx: Ctx): Promise<Response> {
  const admin = ctx.auth.user;
  if (!admin) return signInFirst(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const daily = admin.isAdmin ? everydayOf(ctx.app.db, admin) : undefined;
  if (!daily) return new Response("not found", { status: 404 });
  signOutHere(ctx.app, cookieValue(ctx.request, "forge_session"));
  return redirect("/signin", {
    cookie: sessionCookie("", new Date(0), ctx.url, ctx.app.config.url),
    url: ctx.url,
    forgeUrl: ctx.app.config.url,
    flash: { message: `Sign in as ${daily.username}, your everyday account.` },
  });
}
