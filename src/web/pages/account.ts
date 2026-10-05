/**
 * Account settings: who you are, how you sign in, and the two credentials
 * that act on your behalf when you are not at a browser — personal access
 * tokens and SSH keys.
 *
 * Four pages, one two-pane shell. Every write is post-redirect-get with a
 * flash, so a refresh never repeats a mutation; the one secret a page can
 * show (a freshly minted token) rides that flash and is gone the moment it
 * has been read once.
 */

import { resendVerification } from "../../actions/verify.ts";
import { emailVerified } from "../../core/verify.ts";
import {
  addSshKey,
  changePassword,
  createToken,
  deleteSshKey,
  deleteToken,
  updateProfile,
} from "../../actions/users.ts";
import {
  NOTIFY_ERRORS,
  notifyHost,
  notifyUrlOf,
  setNotifyUrl,
} from "../../crew/notify.ts";
import { forgeHost, noreplyAddress } from "../../core/commit_identity.ts";
import { listKeys } from "../../core/keys.ts";
import { listTokens, type TokenScope } from "../../core/tokens.ts";
import type { CommitEmail, User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { sshCommand } from "../../ssh/command.ts";
import {
  settingsLayout,
  signInFirst,
  type SettingsSection,
} from "../chrome.ts";
import { accountSections } from "./origins.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import {
  badge,
  btn,
  card,
  confirmAction,
  empty,
  selectField,
  time,
  field as uiField,
} from "../ui.ts";

type Section = "profile" | "password" | "tokens" | "keys";

// The section list lives beside the newest page that joins it, so adding one
// cannot leave the others pointing at a nav that has forgotten it.
const sections = (ctx: Ctx, current: Section): SettingsSection[] =>
  accountSections(current, { admin: ctx.auth.user?.isAdmin === true });

/** One account page: the shared shell, the section nav, and this section. */
export function accountShell(
  ctx: Ctx,
  current: Section,
  title: string,
  body: Html,
  status = 200,
): Response {
  return page(
    {
      ctx,
      title,
      body: html`<div class="page-head"><h1>${title}</h1></div>
        ${settingsLayout(sections(ctx, current), body, "Account settings")}`,
    },
    status,
  );
}

// ---- profile ----

interface ProfileForm {
  displayName: string;
  email: string;
  commitEmail: CommitEmail;
  errors?: { displayName?: string; email?: string };
}

/** The profile form as the account stands now. */
const currentProfile = (user: User): ProfileForm => ({
  displayName: user.displayName,
  email: user.email,
  commitEmail: user.commitEmail,
});

function notifyView(ctx: Ctx, error?: string): Html {
  const host = notifyHost(notifyUrlOf(ctx.app.db, ctx.auth.user!.id));
  return card(
    html`<form method="post" action="/settings/notify">
      ${when(error, (m) => html`<p class="error-note">${m}</p>`)}
      ${uiField({
        label: "Notify URL",
        name: "url",
        type: "url",
        autocomplete: "off",
        placeholder: host === undefined ? "https://ntfy.sh/your-topic" : "••••••••",
        hint:
          host === undefined
            ? "When something newly needs you, one line and a link is posted here. https: only; leave it empty to turn it off."
            : `Sending to ${host}. The rest of the address stays hidden; paste a new one to replace it, or save it empty to turn it off.`,
      })}
      <div class="form-actions">
        ${btn("Save notify URL", { variant: "primary" })}
      </div>
    </form>`,
    { head: html`<h3>Phone notifications</h3>` },
  );
}

/** Shown above the profile until the email is proven. */
function unverifiedNotice(ctx: Ctx): Html {
  const user = ctx.auth.user!;
  if (emailVerified(ctx.app.db, user.id)) return html``;
  return card(
    html`<p>
        Your email is not verified yet. Until it is, you can read and talk,
        but not make repositories, apps or runs. Follow the link we sent to
        <strong>${user.email}</strong>, or ask for another.
      </p>
      <form method="post" action="/settings/email/verify">
        ${btn("Send another link", { type: "submit" })}
      </form>`,
    { tone: "attn" },
  );
}

// POST /settings/email/verify
export async function resendVerifyLink(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx);
  if (form instanceof Response) return form;
  const sent = await resendVerification(ctx.app, ctx.auth.user);
  const message = sent.ok
    ? sent.value === "sent"
      ? "A new link is on its way."
      : "Your email is already verified."
    : sent.error === "too_soon"
      ? "A link was sent a moment ago. Check your inbox, or try again in a few minutes."
      : sent.error === "no_mail"
        ? "This forge sends no mail yet. Ask its owner to verify you."
        : "The link could not be sent. Try again.";
  return flashTo(ctx, "/settings", { message });
}

function profileView(ctx: Ctx, values: ProfileForm): Html {
  const user = ctx.auth.user!;
  return html`${unverifiedNotice(ctx)}${card(
    html`<form method="post" action="/settings">
      <div class="field">
        <label for="f-username">Username</label>
        <input
          class="input"
          id="f-username"
          value="${user.username}"
          aria-describedby="f-username-hint"
          readonly
        />
        <span class="hint" id="f-username-hint"
          >Your handle, your URL, and your git author identity. Renaming an
          account is not supported yet.</span
        >
      </div>
      ${uiField({
        label: "Display name",
        name: "displayName",
        value: values.displayName,
        hint: "Shown beside your username. Commits you make through the web use it.",
        ...(values.errors?.displayName
          ? { error: values.errors.displayName }
          : {}),
      })}
      ${uiField({
        label: "Email",
        name: "email",
        type: "email",
        value: values.email,
        autocomplete: "email",
        hint: "Where the forge reaches you. Never shown to other people, and never in a commit unless you choose it below.",
        ...(values.errors?.email ? { error: values.errors.email } : {}),
      })}
      ${selectField({
        label: "Commit email",
        name: "commitEmail",
        options: [
          {
            value: "noreply",
            label: noreplyAddress(user.username, forgeHost(ctx.app.config)),
            selected: values.commitEmail === "noreply",
          },
          {
            value: "account",
            label: "My email above — published in every clone",
            selected: values.commitEmail === "account",
          },
        ],
        hint: "The address on commits the forge makes for you: merges, reverts, web edits. A commit in a public repository cannot be taken back, so the default reaches nobody.",
      })}
      <div class="form-actions">
        ${btn("Save profile", { variant: "primary" })}
      </div>
    </form>`,
    { head: html`<h3>Public profile</h3>` },
  )}`;
}

// GET /settings
export function accountPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  return accountShell(
    ctx,
    "profile",
    "Settings",
    html`${profileView(ctx, currentProfile(ctx.auth.user))}${notifyView(ctx)}`,
  );
}

// POST /settings/notify
export async function notifyUpdate(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const saved = setNotifyUrl(ctx.app.db, ctx.auth.user.id, field(form, "url"));
  if (!saved.ok)
    return accountShell(
      ctx,
      "profile",
      "Settings",
      html`${profileView(ctx, currentProfile(ctx.auth.user))}${notifyView(
        ctx,
        NOTIFY_ERRORS[saved.error],
      )}`,
      422,
    );
  // The notifier starts from what asks now, so only what comes after is new.
  ctx.app.bus.append({ kind: "account.notify_set", actorId: ctx.auth.user.id });
  return flashTo(ctx, "/settings", {
    message:
      saved.value === "set" ? "Notify URL saved." : "Notifications turned off.",
  });
}

// POST /settings
export async function accountUpdate(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const displayName = field(form, "displayName").trim();
  const email = field(form, "email").trim();
  // Absent (an older form) leaves the choice as it stands; anything but the
  // two offered values is refused by the profile write.
  const chosen = field(form, "commitEmail");
  const commitEmail = (chosen || ctx.auth.user.commitEmail) as CommitEmail;

  const updated = updateProfile(ctx.app, ctx.auth.user, {
    displayName,
    email,
    commitEmail,
  });
  if (!updated.ok) {
    const errors: ProfileForm["errors"] =
      updated.error === "email_taken"
        ? { email: "Another account already uses that address." }
        : updated.error === "invalid_email"
          ? { email: "That doesn't look like an email address." }
          : updated.error === "display_name_reserved"
            ? { displayName: "That name belongs to the crew, the owner or the forge." }
            : {};
    return accountShell(
      ctx,
      "profile",
      "Settings",
      profileView(ctx, {
        displayName,
        email,
        commitEmail:
          commitEmail === "noreply" || commitEmail === "account"
            ? commitEmail
            : ctx.auth.user.commitEmail,
        errors,
      }),
      422,
    );
  }
  return flashTo(ctx, "/settings", { message: "Profile updated." });
}

// ---- password ----

function passwordView(error?: {
  field: "current" | "next";
  text: string;
}): Html {
  return card(
    html`<form method="post" action="/settings/password">
      ${uiField({
        label: "Current password",
        name: "current",
        type: "password",
        autocomplete: "current-password",
        required: true,
        ...(error?.field === "current" ? { error: error.text } : {}),
      })}
      ${uiField({
        label: "New password",
        name: "next",
        type: "password",
        autocomplete: "new-password",
        minlength: 10,
        required: true,
        hint: "At least 10 characters. A passphrase beats a puzzle.",
        ...(error?.field === "next" ? { error: error.text } : {}),
      })}
      ${uiField({
        label: "Confirm new password",
        name: "confirm",
        type: "password",
        autocomplete: "new-password",
        required: true,
      })}
      <div class="form-actions">
        ${btn("Change password", { variant: "primary" })}
      </div>
    </form>`,
    { head: html`<h3>Change password</h3>` },
  );
}

// GET /settings/password
export function passwordPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  return accountShell(ctx, "password", "Password", passwordView());
}

// POST /settings/password
export async function passwordUpdate(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const current = field(form, "current");
  const next = field(form, "next");

  if (next !== field(form, "confirm")) {
    return accountShell(
      ctx,
      "password",
      "Password",
      passwordView({
        field: "next",
        text: "The two new passwords don't match.",
      }),
      422,
    );
  }

  const changed = await changePassword(ctx.app, ctx.auth.user, {
    current,
    next,
  });
  if (!changed.ok) {
    const error =
      changed.error === "bad_credentials"
        ? {
            field: "current" as const,
            text: "That isn't your current password.",
          }
        : changed.error === "weak_password"
          ? {
              field: "next" as const,
              text: "Passwords need at least 10 characters.",
            }
          : { field: "current" as const, text: "Something went wrong." };
    return accountShell(ctx, "password", "Password", passwordView(error), 422);
  }
  return flashTo(ctx, "/settings/password", {
    message: "Password changed. Existing sessions stay signed in.",
  });
}

// ---- tokens ----

function tokensView(ctx: Ctx): Html {
  const tokens = listTokens(ctx.app.db, ctx.auth.user!.id);
  return html`<p class="muted small mb">
      Use a token as the password when pushing over HTTPS, or as a
      <span class="mono">Bearer</span> token for the API. Your account password
      works for git too — tokens are for scoped or automated access.
    </p>
    ${tokens.length === 0
      ? empty({
          icon: "key",
          title: "No tokens yet",
          note: "Mint one when a script, a CI job, or another machine needs to act as you.",
        })
      : card(
          html`<div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Scope</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${tokens.map(
                  (t) =>
                    html`<tr>
                      <td><strong>${t.name}</strong></td>
                      <td>${badge(t.scope)}</td>
                      <td class="muted">${time(t.createdAt)}</td>
                      <td class="muted">
                        ${t.lastUsedAt ? time(t.lastUsedAt) : "never"}
                      </td>
                      <td>
                        ${confirmAction({
                          action: `/settings/tokens/${t.id}/delete`,
                          verb: "Revoke",
                          size: "sm",
                        })}
                      </td>
                    </tr>`,
                )}
              </tbody>
            </table>
          </div>`,
          { pad: false },
        )}
    ${card(
      html`<form method="post" action="/settings/tokens">
        ${uiField({
          label: "Token name",
          name: "name",
          required: true,
          hint: "Name it after where it lives — laptop, CI, deploy box.",
        })}
        ${selectField({
          label: "Scope",
          name: "scope",
          options: [
            { value: "rw", label: "read + write — clone, push, open issues" },
            { value: "ro", label: "read only — clone and browse" },
            { value: "admin", label: "admin — everything, including settings" },
          ],
          hint: "A token can never mint another token, whatever its scope.",
        })}
        <div class="form-actions">
          ${btn("Generate token", { variant: "primary" })}
        </div>
      </form>`,
      { head: html`<h3>New token</h3>` },
    )}`;
}

// GET /settings/tokens
export function tokensPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  return accountShell(ctx, "tokens", "Personal access tokens", tokensView(ctx));
}

// POST /settings/tokens
export async function tokenCreate(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  // Minting a token must come from a browser session or the password — never
  // from another token (no privilege bootstrapping).
  if (ctx.auth.via !== "session" && ctx.auth.via !== "password") {
    return new Response("forbidden", { status: 403 });
  }
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const scope = field(form, "scope");
  const chosen: TokenScope = scope === "ro" || scope === "admin" ? scope : "rw";
  const minted = createToken(
    ctx.app,
    ctx.auth.user,
    field(form, "name").trim() || "token",
    chosen,
  );
  if (!minted.ok) return signInFirst(ctx);
  // Post-redirect-get: the secret rides a one-shot flash, so a refresh shows
  // the list rather than minting a second token.
  return flashTo(ctx, "/settings/tokens", {
    message: "Token created — copy it now, it is never shown again.",
    code: minted.value.token,
  });
}

// POST /settings/tokens/:id/delete
export async function tokenDelete(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const revoked = deleteToken(ctx.app, ctx.auth.user, ctx.params.id ?? "");
  return flashTo(ctx, "/settings/tokens", {
    ...(revoked.ok
      ? { message: "Token revoked." }
      : { tone: "danger" as const, message: "No such token." }),
  });
}

// ---- ssh keys ----

function keysView(
  ctx: Ctx,
  values: { name: string; key: string; error?: string },
): Html {
  const keys = listKeys(ctx.app.db, ctx.auth.user!.id);
  return html`${when(
      sshCommand(ctx.app),
      (ssh) =>
        html`<p class="mb terminal-line">
          <code class="mono">${ssh}</code>
          ${when(
            ctx.app.config.sshHostKey,
            (fp) => html`<span class="muted small">host key ${fp}</span>`,
          )}
        </p>`,
    )}
    <p class="muted small mb">
      Keys that sign you in over SSH. Paste a public key (<span class="mono"
        >~/.ssh/id_ed25519.pub</span
      >) — ed25519, ecdsa, or rsa (2048 bits or more).
    </p>
    ${keys.length === 0
      ? empty({
          icon: "lock",
          title: "No keys yet",
          note: "Add one and git over SSH stops asking for a password.",
        })
      : card(
          html`<div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Fingerprint</th>
                  <th>Added</th>
                  <th>Last used</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${keys.map(
                  (k) =>
                    html`<tr>
                      <td>
                        <strong>${k.name}</strong> ${badge(k.algo, {
                          variant: "secondary",
                        })}
                      </td>
                      <td class="mono small">${k.fingerprint}</td>
                      <td class="muted">${time(k.createdAt)}</td>
                      <td class="muted">
                        ${k.lastUsedAt ? time(k.lastUsedAt) : "never"}
                      </td>
                      <td>
                        ${confirmAction({
                          action: `/settings/keys/${k.id}/delete`,
                          verb: "Remove",
                          size: "sm",
                        })}
                      </td>
                    </tr>`,
                )}
              </tbody>
            </table>
          </div>`,
          { pad: false },
        )}
    ${card(
      html`<form method="post" action="/settings/keys">
        ${when(
          values.error,
          (message) => html`<p class="error-note">${message}</p>`,
        )}
        ${uiField({
          label: "Name",
          name: "name",
          value: values.name,
          hint: "Optional — the key's own comment is used when you leave this empty.",
        })}
        ${uiField({
          label: "Public key",
          name: "key",
          type: "textarea",
          rows: 4,
          mono: true,
          required: true,
          value: values.key,
          placeholder: "ssh-ed25519 AAAA…",
        })}
        <div class="form-actions">
          ${btn("Add key", { variant: "primary" })}
        </div>
      </form>`,
      { head: html`<h3>New SSH key</h3>` },
    )}`;
}

// GET /settings/keys
export function keysPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  return accountShell(
    ctx,
    "keys",
    "SSH keys",
    keysView(ctx, { name: "", key: "" }),
  );
}

// POST /settings/keys
export async function keyCreate(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const name = field(form, "name");
  const key = field(form, "key");
  const added = addSshKey(ctx.app, ctx.auth.user, { name, key });
  if (!added.ok) {
    const messages: Record<string, string> = {
      invalid_key: "That doesn't look like a supported public key.",
      key_exists: "That key is already registered on this account.",
    };
    return accountShell(
      ctx,
      "keys",
      "SSH keys",
      keysView(ctx, {
        name,
        key,
        error: messages[added.error] ?? "Something went wrong.",
      }),
      422,
    );
  }
  return flashTo(ctx, "/settings/keys", {
    message: `Added ${added.value.name}.`,
  });
}

// POST /settings/keys/:id/delete
export async function keyDelete(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const removed = deleteSshKey(ctx.app, ctx.auth.user, ctx.params.id ?? "");
  return flashTo(ctx, "/settings/keys", {
    ...(removed.ok
      ? { message: "Key removed." }
      : { tone: "danger" as const, message: "No such key." }),
  });
}
