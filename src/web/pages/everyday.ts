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
  linkEveryday,
} from "../../core/everyday.ts";
import { createSession } from "../../core/sessions.ts";
import { createUser, getUserByName, type User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo, redirect } from "../layout.ts";
import { btn, card, field as formField } from "../ui.ts";
import { sessionCookie } from "./site.ts";

const MIN_PASSWORD = 10;
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}$/;

/** The everyday name offered first: the admin's, with `-me`, if it is free. */
function suggestedName(ctx: Ctx, admin: User): string {
  const name = `${admin.username}-me`;
  return getUserByName(ctx.app.db, name) === undefined ? name : "";
}

/** The card, for an admin with no everyday account and no recorded choice. */
export function everydayCard(ctx: Ctx, user: User): Html | null {
  if (!askForEveryday(ctx.app.db, user)) return null;
  return everydayForm(ctx, user, true);
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
    return html`<p class="muted mb" id="everyday-pair">
      Your everyday account is <a href="/${daily.username}">${daily.username}</a>.
      Use it day to day; this one is for changing the forge.
    </p>`;
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
    html`<p class="mb">${EVERYDAY_WHY}</p>
      <form method="post" action="/settings/everyday" class="stack">
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
        ${formField({
          label: "Password",
          name: "password",
          type: "password",
          autocomplete: "new-password",
          required: true,
          minlength: MIN_PASSWORD,
          hint: "At least 10 characters.",
        })}
        <div class="form-actions">
          ${btn("Make it", { variant: "primary" })}
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
      ></form>`,
    { id: "everyday", head: html`<h2>Make your everyday account</h2>` },
  );
}

// POST /settings/everyday — make the everyday account, link it, sign in as it.
export async function everydayCreate(ctx: Ctx): Promise<Response> {
  const admin = ctx.auth.user;
  if (!admin) return signInFirst(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  if (!admin.isAdmin) return new Response("forbidden", { status: 403 });
  if (everydayOf(ctx.app.db, admin) !== undefined)
    return flashTo(ctx, "/settings", {
      message: "You already have an everyday account.",
    });
  const username = field(form, "username");
  const email = field(form, "email");
  const password = field(form, "password");
  const say = (message: string) =>
    flashTo(ctx, "/", { tone: "danger", message });
  if (!USERNAME.test(username))
    return say("Usernames are letters, digits, dots, dashes.");
  if (password.length < MIN_PASSWORD)
    return say("Passwords need at least 10 characters.");
  const made = await createUser(ctx.app.db, { username, email, password });
  if (!made.ok)
    return say(
      made.error === "username_taken"
        ? "That username is taken."
        : made.error === "email_taken"
          ? "That email already has an account."
          : "That account could not be made.",
    );
  linkEveryday(ctx.app.db, admin, made.value);
  const session = createSession(ctx.app.db, made.value.id);
  return redirect("/", {
    cookie: sessionCookie(session.token, session.expiresAt, ctx.url),
    url: ctx.url,
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
  if (!admin.isAdmin) return new Response("forbidden", { status: 403 });
  keepAdmin(ctx.app.db, admin);
  return flashTo(ctx, "/", {
    message:
      "You keep working as admin. Your account page has the way to an everyday account whenever you want one.",
  });
}
