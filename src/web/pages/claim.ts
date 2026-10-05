/**
 * `/claim/:token`: the page a spawned child's link opens (`spawn/claim.ts`).
 * The path: the person a forge was made for opens the link they were sent,
 * reads who will be able to see it, makes their account, and lands in
 * their forge as its admin. The GET only shows the form — a link unfurled
 * in a chat app must not spend itself — and the POST, same-origin, makes
 * the account and burns the link in one step. A link that is used, expired
 * or made up says which, plainly; a forge that was not spawned has no
 * claim page at all.
 *
 * Who keeps access is never silent. By default the spawner's account leaves
 * the organisation's Owners when the forge is claimed (the new owner can
 * invite them back); when the spawner asked to keep access, the page says
 * so before anyone submits, and where to remove it.
 */

import type { Ctx } from "../../http/context.ts";
import {
  addTeamMember,
  listTeamMembers,
  listTeams,
  OWNERS_TEAM,
  removeTeamMember,
  type Team,
} from "../../core/orgs.ts";
import { createSession } from "../../core/sessions.ts";
import { createUser, getUserByName, type User } from "../../core/users.ts";
import {
  burnClaim,
  readClaim,
  spawnedOrg,
  unburnClaim,
  type ClaimState,
  type Spawned,
} from "../../spawn/claim.ts";
import { pageHead } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { page, redirect } from "../layout.ts";
import { btn, card, field as formField } from "../ui.ts";
import { sessionCookie } from "./site.ts";

const MIN_PASSWORD = 10;
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}$/;

interface Values {
  readonly username?: string;
  readonly email?: string;
}
type Errors = Partial<Record<"username" | "email" | "password", string>>;

function dead(ctx: Ctx, state: Exclude<ClaimState["state"], "ok">): Response {
  const says = {
    unknown: {
      status: 404,
      title: "This is not a claim link",
      text: "The link may have been cut short. Ask whoever sent it for a new one.",
    },
    used: {
      status: 410,
      title: "This link has already been used",
      text: "Each claim link works once. If it was you, sign in with the account you made.",
    },
    expired: {
      status: 410,
      title: "This link has expired",
      text: "Claim links work for a day. Ask whoever sent it for a new one.",
    },
    owned: {
      status: 410,
      title: "This forge already has an owner",
      text: "Someone has already claimed it. If it was you, sign in.",
    },
  }[state];
  return page(
    {
      ctx,
      title: says.title,
      body: html`<div class="narrow">
        ${pageHead(says.title)}
        ${card(
          html`<p>${says.text}</p>
            ${state === "used" || state === "owned"
              ? html`<div class="form-actions">
                  ${btn("Sign in", { href: "/signin", variant: "primary" })}
                </div>`
              : null}`,
        )}
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
  return {
    team,
    spawner:
      team === undefined ? undefined : listTeamMembers(ctx.app.db, team.id)[0],
  };
}

/** One plain sentence: who can see this forge once it is claimed. */
function accessSentence(spawned: Spawned, spawner: User | undefined): string {
  const who = spawner?.username ?? "Whoever made it";
  return spawned.keepAccess
    ? `${who} keeps owner access to this forge; you can remove it in your organisation's Owners team.`
    : `Once you claim it, only you can see its private work: ${who}, who made it, no longer has access unless you invite them back.`;
}

function claimForm(
  ctx: Ctx,
  spawned: Spawned,
  spawner: User | undefined,
  values: Values,
  errors: Errors,
): Html {
  return html`<div class="narrow">
    ${pageHead("This forge is yours")}
    ${card(
      html`<p class="mb">
          ${spawned.org.username} was made for you, with its apps and a crew
          ready to build them. Make your account to take it: this first account
          is the forge's admin, so it can change everything here.
        </p>
        <p class="mb" id="claim-access">${accessSentence(spawned, spawner)}</p>
        <form method="post" action="${ctx.url.pathname}">
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
            required: true,
            ...(errors.email ? { error: errors.email } : {}),
          })}
          ${formField({
            label: "Password",
            name: "password",
            type: "password",
            autocomplete: "new-password",
            required: true,
            minlength: MIN_PASSWORD,
            hint: "At least 10 characters.",
            ...(errors.password ? { error: errors.password } : {}),
          })}
          <div class="form-actions">
            ${btn("Claim this forge", { variant: "primary" })}
          </div>
        </form>`,
    )}
  </div>`;
}

// GET /claim/:token — the form, or why the link no longer works. Spends nothing.
export async function claimPage(ctx: Ctx): Promise<Response> {
  const spawned = await spawnedOrg(ctx.app);
  if (spawned === undefined) return dead(ctx, "unknown");
  const claim = readClaim(
    ctx.app.db,
    spawned.org.id,
    ctx.params["token"] ?? "",
  );
  if (claim.state !== "ok") return dead(ctx, claim.state);
  return page({
    ctx,
    title: "This forge is yours",
    body: claimForm(ctx, spawned, owners(ctx, spawned).spawner, {}, {}),
  });
}

// POST /claim/:token — make the account, burn the link, sign the person in.
export async function claimSubmit(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx);
  if (form instanceof Response) return form;
  const spawned = await spawnedOrg(ctx.app);
  if (spawned === undefined) return dead(ctx, "unknown");
  const orgId = spawned.org.id;
  const token = ctx.params["token"] ?? "";
  const before = readClaim(ctx.app.db, orgId, token);
  if (before.state !== "ok") return dead(ctx, before.state);
  const { team, spawner } = owners(ctx, spawned);

  const values = {
    username: field(form, "username"),
    email: field(form, "email"),
  };
  const password = field(form, "password");
  const errors: Errors = {};
  if (!USERNAME.test(values.username))
    errors.username = "Usernames are letters, digits, dots, dashes.";
  else if (getUserByName(ctx.app.db, values.username))
    errors.username = "That username is taken.";
  if (!values.email.includes("@")) errors.email = "An email address, please.";
  if (password.length < MIN_PASSWORD)
    errors.password = "Passwords need at least 10 characters.";
  const again = (e: Errors) =>
    page(
      {
        ctx,
        title: "This forge is yours",
        body: claimForm(ctx, spawned, spawner, values, e),
      },
      422,
    );
  if (Object.keys(errors).length > 0) return again(errors);

  // Spent first, in one statement: of two people on one link, one wins.
  const spent = burnClaim(ctx.app.db, orgId, token);
  if (spent.state !== "ok") return dead(ctx, spent.state);
  const made = await createUser(ctx.app.db, {
    username: values.username,
    email: values.email,
    password,
    isAdmin: true,
  });
  if (!made.ok) {
    unburnClaim(ctx.app.db, orgId, token);
    return again(
      made.error === "email_taken"
        ? { email: "That email already has an account." }
        : { username: "That username is taken." },
    );
  }
  if (team) {
    addTeamMember(ctx.app.db, team, made.value.id);
    // As the page said: unless the spawner kept access, they leave now.
    if (!spawned.keepAccess && spawner && spawner.id !== made.value.id)
      removeTeamMember(ctx.app.db, team, spawner.id);
  }
  ctx.app.log.info("forge claimed", {
    org: spawned.org.username,
    user: made.value.username,
    spawnerKeeps: spawned.keepAccess,
  });
  const session = createSession(ctx.app.db, made.value.id);
  // Home: where the crew's work shows (its first-login screen is #600).
  return redirect(
    "/",
    sessionCookie(session.token, session.expiresAt, ctx.url),
  );
}
