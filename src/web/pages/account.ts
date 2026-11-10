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

import { UPSTREAM_REPO } from "../../core/upstream.ts";
import { resendVerification } from "../../actions/verify.ts";
import { clientAddress } from "../../http/peer.ts";
import { emailVerified } from "../../core/verify.ts";
import {
  addSshKey,
  CHANGE_PASSWORD_WORDS,
  changePassword,
  createToken,
  deleteSshKey,
  deleteToken,
  PASSWORD_CHANGED_WORDS,
  updateProfile,
} from "../../actions/users.ts";
import {
  NOTIFY_ERRORS,
  notifyHost,
  notifyUrlOf,
  setNotifyUrl,
} from "../../crew/notify.ts";
import { forgeHost, noreplyAddress } from "../../core/commit_identity.ts";
import { ABILITIES, roleOf, rowOf, type Ability } from "../../core/roles.ts";
import { linkEdgeLogin, linkedLogin, unlinkEdgeLogin } from "../../core/edge_links.ts";
import { LAST_WAY_IN, linkedParent, parentIssuerOf, unlinkParent } from "../../core/federation.ts";
import { activeEdgeToken, edgeIdentity } from "../../http/edge.ts";
import { listKeys } from "../../core/keys.ts";
import { listTokensWithClients } from "../../core/oauth.ts";
import {
  PROFILE_FALLBACK,
  PROFILE_REFUSAL_FIELD,
  PROFILE_REFUSALS,
} from "../../actions/profile_words.ts";
import { endAccountSession } from "../../actions/signins.ts";
import { listSessions, type SessionInfo } from "../../core/sessions.ts";
import { ADMIN_TOKEN_WORDS, type TokenScope } from "../../core/tokens.ts";
import { claudeInstall, opencodeInstall } from "../../core/plugin_install.ts";
import type { CommitEmail, User } from "../../core/users.ts";
import { isStandInEmail } from "../../core/users.ts";
import { cookieValue, isAccountItself, type Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { offeredPluginRepo } from "../../core/mcp_card.ts";
import { publicOrigin } from "../../core/public_origin.ts";
import { sshCommand } from "../../ssh/command.ts";
import {
  settingsLayout,
  signInFirst,
  type SettingsSection,
  forbiddenPage,
  notFoundPage,
} from "../chrome.ts";
import { accountSections } from "./origins.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { readFlash } from "../flash.ts";
import {
  badge,
  btn,
  confirmAction,
  copyField,
  row,
  selectField,
  terminalCommand,
  time,
  field as uiField,
  icon,
} from "../ui.ts";
import { STOPPED_ONE, myShells, stopIdleShells, stopShell, stoppedIdleSays } from "../../machines/shell.ts";
import { DOTFILES_ERRORS, dotfilesRepoOf, setDotfilesRepo } from "../../machines/dotfiles.ts";
import { everydayLine } from "./everyday.ts";
import { passkeyJs } from "../passkey-client.ts";

/** A titled block of a settings page: a heading over its content, no box. */
const block = (title: string, body: Html, intro?: string): Html =>
  html`<section class="settings-block">
    <h2>${title}</h2>
    ${intro === undefined ? null : html`<p class="muted small">${intro}</p>`}
    ${body}
  </section>`;

/**
 * The one help toggle of a settings page: what each field means, kept out of the
 * form so a field is its label and its current value. Closed until asked for.
 */
const help = (notes: readonly (readonly [string, string | Html])[]): Html =>
  html`<details class="disclosure mb" data-page-help>
    <summary>Help with these fields</summary>
    <dl class="status-rows">
      ${notes.map(([name, text]) => html`<div class="status-row"><dt>${name}</dt><dd>${text}</dd></div>`)}
    </dl>
  </details>`;

type Section = "profile" | "password" | "tokens" | "keys" | "passkeys" | "shells";

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
  scriptJs?: string,
): Response {
  return page(
    {
      ctx,
      title,
      ...(scriptJs === undefined ? {} : { scriptJs }),
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
  errors?: { displayName?: string; email?: string; form?: string };
}

/** The profile form as the account stands now. */
const currentProfile = (user: User): ProfileForm => ({
  displayName: user.displayName,
  email: isStandInEmail(user.email) ? "" : user.email,
  commitEmail: user.commitEmail,
});

/**
 * A refused submit, in the shared danger toast (as a failed mirror is): under
 * the form's actions, where the toast's own top margin sits, so nothing above
 * it moves when it appears.
 */
const refusal = (message: string | undefined): Html =>
  when(
    message,
    (m) => html`<div class="toast" data-tone="danger" role="alert">
      ${icon("alert")}
      <div class="toast-body">${m}</div>
    </div>`,
  );

function notifyView(ctx: Ctx, error?: string): Html {
  const host = notifyHost(notifyUrlOf(ctx.app.db, ctx.auth.user!.id));
  return block(
    "Phone notifications",
    html`<form method="post" action="/settings/notify">
      ${uiField({
        label: "Notify URL",
        name: "url",
        type: "url",
        autocomplete: "off",
        placeholder: host === undefined ? "https://ntfy.sh/your-topic" : "••••••••",
        hint: host === undefined ? "https: only." : `Sending to ${host}. https: only.`,
      })}
      <div class="form-actions">
        ${btn("Save notify URL", { variant: "primary" })}
      </div>
      ${refusal(error)}
    </form>`,
  );
}

function dotfilesView(ctx: Ctx, error?: string): Html {
  const named = dotfilesRepoOf(ctx.app.db, ctx.auth.user!.id);
  return block(
    "Dotfiles",
    html`<form method="post" action="/settings/dotfiles">
      ${uiField({
        label: "Dotfiles repository",
        name: "repo",
        value: named ?? "",
        placeholder: "owner/name",
        autocomplete: "off",
        hint: "A repository on this forge that you can read; empty for none.",
      })}
      <div class="form-actions">
        ${btn("Save dotfiles repository", { variant: "primary" })}
      </div>
      ${refusal(error)}
    </form>`,
  );
}

// POST /settings/dotfiles
export async function dotfilesUpdate(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const saved = setDotfilesRepo(ctx.app.db, ctx.auth.user, field(form, "repo"));
  if (!saved.ok)
    return accountShell(
      ctx,
      "shells",
      "Shells",
      html`${dotfilesView(ctx, DOTFILES_ERRORS[saved.error])}${shellsView(ctx, ctx.auth.user)}`,
      422,
    );
  return flashTo(ctx, "/settings/shells", {
    message: saved.value === "set" ? "Dotfiles repository saved." : "Dotfiles repository cleared.",
  });
}

/** open-platform.sh: linked as <login>, or not, with Link and Unlink. */
function edgeLinkView(ctx: Ctx): Html {
  const token = activeEdgeToken(ctx.app);
  if (token === undefined) return html``;
  const linked = linkedLogin(ctx.app.db, ctx.auth.user!.id);
  const carried = edgeIdentity(ctx.request, token);
  return block(
    "open-platform.sh",
    linked !== undefined
      ? html`<p>open-platform.sh: linked as <strong>${linked}</strong></p>
          ${confirmAction({ action: "/settings/edge/unlink", verb: "Unlink" })}`
      : html`<p>open-platform.sh: not linked</p>
          ${carried === undefined
            ? html`<p class="hint">Sign in through open-platform.sh, then come back here to link that login.</p>`
            : html`<form method="post" action="/settings/edge/link">
                ${btn(`Link ${carried}`, { type: "submit" })}
              </form>`}`,
  );
}

/** The parent forge: linked as its host, or not, with Link (a round trip through the parent) and Unlink. */
function parentLinkView(ctx: Ctx): Html {
  const issuer = parentIssuerOf(ctx.app.config);
  if (issuer === undefined) return html``;
  const host = new URL(issuer).host;
  const linked = linkedParent(ctx.app.db, ctx.auth.user!.id, issuer) !== undefined;
  return block(
    host,
    linked
      ? html`<p>${host}: linked</p>
          ${confirmAction({ action: "/settings/parent/unlink", verb: "Unlink" })}`
      : html`<p>${host}: not linked</p>
          <form method="post" action="/settings/parent/link">
            ${btn(`Link ${host}`, { type: "submit" })}
          </form>`,
  );
}

// POST /settings/parent/unlink
export async function parentUnlink(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const issuer = parentIssuerOf(ctx.app.config);
  const done = issuer === undefined ? undefined : unlinkParent(ctx.app.db, ctx.auth.user.id, issuer);
  if (done === undefined || (done.ok && done.value === "none")) return flashTo(ctx, "/settings", { message: "Nothing to unlink." });
  if (!done.ok) return flashTo(ctx, "/settings", { message: LAST_WAY_IN });
  ctx.app.bus.append({ kind: "account.parent_unlinked", actorId: ctx.auth.user.id });
  return flashTo(ctx, "/settings", { message: "Unlinked." });
}

// POST /settings/edge/link
export async function edgeLink(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const login = edgeIdentity(ctx.request, activeEdgeToken(ctx.app));
  if (login === undefined)
    return flashTo(ctx, "/settings", {
      message: "Sign in through open-platform.sh first, then link.",
    });
  const linked = linkEdgeLogin(ctx.app.db, ctx.auth.user, login);
  if (!linked.ok)
    return flashTo(ctx, "/settings", {
      message:
        linked.error === "already_linked"
          ? "This account is linked to another open-platform.sh login. Unlink it first."
          : linked.error === "login_taken"
            ? "That open-platform.sh login belongs to another account here."
            : "That open-platform.sh login cannot be linked.",
    });
  ctx.app.bus.append({ kind: "account.edge_linked", actorId: ctx.auth.user.id });
  return flashTo(ctx, "/settings", { message: `Linked as ${login}.` });
}

// POST /settings/edge/unlink
export async function edgeUnlink(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  if (unlinkEdgeLogin(ctx.app.db, ctx.auth.user.id))
    ctx.app.bus.append({ kind: "account.edge_unlinked", actorId: ctx.auth.user.id });
  return flashTo(ctx, "/settings", { message: "Unlinked." });
}

/** Shown above the profile until the email is proven. */
function unverifiedNotice(ctx: Ctx): Html {
  const user = ctx.auth.user!;
  if (emailVerified(ctx.app.db, user.id)) return html``;
  const standIn = isStandInEmail(user.email);
  return html`<section class="settings-block">
    <p>
      Your email is not verified yet. Until it is, you can read and talk,
      but not make repositories, apps or runs.
      ${standIn
        ? html`Add your email below and follow the link we send to it.`
        : html`Follow the link we sent to <strong>${user.email}</strong>, or ask for another.`}
    </p>
    ${standIn
      ? html``
      : html`<form method="post" action="/settings/email/verify">
          ${btn("Send another link", { type: "submit" })}
        </form>`}
  </section>`;
}

// POST /settings/email/verify
export async function resendVerifyLink(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
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
        : sent.error === "capped"
          ? "The forge has sent all the mail it may for now. Try again tomorrow, or ask its owner to verify you."
          : "The link could not be sent. Try again.";
  return flashTo(ctx, "/settings", { message });
}

/** What the signed-in account's role allows: one row of the page's Help. */
function roleHelp(ctx: Ctx): readonly [string, Html] {
  const row = rowOf(roleOf(ctx.app.db, ctx.auth.user!));
  return [
    "What your role allows",
    html`<ul class="role-can">
      ${(Object.keys(ABILITIES) as Ability[]).map(
        (a) => html`<li>${ABILITIES[a]}: <strong>${row[a] ? "yes" : "no"}</strong></li>`,
      )}
    </ul>`,
  ];
}

/** The signed-in account's role, in one line. */
function roleView(ctx: Ctx): Html {
  return block("What you can do here", html`<p>You are ${badge(roleOf(ctx.app.db, ctx.auth.user!))} here.</p>`);
}

function profileView(ctx: Ctx, values: ProfileForm): Html {
  const user = ctx.auth.user!;
  return html`${unverifiedNotice(ctx)}${help([
    [
      "Username",
      "Your handle, your URL, and your git author identity. Renaming an account is not supported yet.",
    ],
    ["Display name", "Shown beside your username. Commits you make through the web use it."],
    [
      "Email",
      "Where the forge reaches you. Never shown to other people, and never in a commit unless you choose it below.",
    ],
    [
      "Commit email",
      "The address on commits the forge makes for you: merges, reverts, web edits. A commit in a public repository cannot be taken back, so the default reaches nobody.",
    ],
    [
      "Notify URL",
      "When something newly needs you, one line and a link is posted here. The rest of a saved address stays hidden; paste a new one to replace it, or save it empty to turn it off.",
    ],
    roleHelp(ctx),
  ])}${roleView(ctx)}${block(
    "Public profile",
    html`<form method="post" action="/settings">
      <div class="field">
        <label for="f-username">Username</label>
        <input
          class="input"
          id="f-username"
          value="${user.username}"
          readonly
        />
      </div>
      ${uiField({
        label: "Display name",
        name: "displayName",
        value: values.displayName,
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
      })}
      <div class="form-actions">
        ${btn("Save", { variant: "primary" })}
      </div>
      ${refusal(values.errors?.form)}
    </form>`,
  )}`;
}

/** A reading the cell may not give: a dash, never a zero that says "idle". */
const reading = (n: number | null, unit: string): string => (n === null ? "–" : `${n}${unit}`);

/** The machine shells this person holds and last held (#10544). Read only; the live row says its few facts in a `dl`. */
export function shellsView(ctx: Ctx, user: User): Html {
  const shells = myShells(ctx.app, user.id);
  if (shells.length === 0) return html`<p class="muted" id="shells">You have opened no shell on a machine yet.</p>`;
  const anyLive = shells.some((s) => s.endedAt === null);
  return html`${anyLive
      ? html`<form method="post" action="/settings/shells/stop-idle">${btn("Stop all idle", { type: "submit" })}</form>`
      : null}<ul class="list setting-list" id="shells">
    ${shells.map((s) =>
      s.endedAt === null
        ? row({
            title: html`${s.repository} · ${s.machine}`,
            meta: html`${s.kind === "app" ? "App terminal · " : ""}Started ${time(s.startedAt)}`,
            trail: html`${badge("running", { tone: "success" })}
              <form method="post" action="/settings/shells/${s.id}/stop">${btn("Stop", { type: "submit", size: "sm", label: `Stop ${s.repository} · ${s.machine}` })}</form>`,
            facts: [
              { label: "Last input", value: s.lastInputAt ? time(s.lastInputAt) : "–" },
              { label: "Last output", value: s.lastOutputAt ? time(s.lastOutputAt) : "–" },
              ...(s.kind === "app"
                ? []
                : [
                    { label: "Attached", value: s.peers === 0 ? "nobody" : String(s.peers) },
                    { label: "CPU", value: reading(s.cpuCores === null ? null : Math.round(s.cpuCores * 100), "%") },
                    { label: "Memory", value: reading(s.memoryMiB, " MiB") },
                  ]),
            ],
            data: { session: s.id },
          })
        : row({
            title: html`${s.repository} · ${s.machine}`,
            meta: html`Ended ${time(s.endedAt)} · ${s.endedBecause}`,
            data: { session: s.id },
          }),
    )}
  </ul>`;
}

// GET /settings/shells
export function shellsPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const body = html`${dotfilesView(ctx)}${shellsView(ctx, ctx.auth.user)}`;
  return timePhase(ctx.request, "render", () => accountShell(ctx, "shells", "Shells", body));
}

// POST /settings/shells/:id/stop
export async function shellStop(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const id = ctx.params.id ?? "";
  if (!stopShell(ctx.app, ctx.auth.user.id, id)) return notFoundPage(ctx);
  return flashTo(ctx, "/settings/shells", { message: STOPPED_ONE });
}

// POST /settings/shells/stop-idle
export async function shellsStopIdle(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  return flashTo(ctx, "/settings/shells", { message: stoppedIdleSays(stopIdleShells(ctx.app, ctx.auth.user.id)) });
}

// GET /settings
export function accountPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  const user = ctx.auth.user;
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  // Read in the order the page lays them out; each phase is named for what it reads.
  const pair = timePhase(ctx.request, "everyday", () => everydayLine(ctx, user));
  const profile = timePhase(ctx.request, "profile", () => profileView(ctx, currentProfile(user)));
  const edge = timePhase(ctx.request, "edge", () => edgeLinkView(ctx));
  const parent = timePhase(ctx.request, "parent", () => parentLinkView(ctx));
  const notify = timePhase(ctx.request, "notify", () => notifyView(ctx));
  const rendering = performance.now();
  const response = accountShell(
    ctx,
    "profile",
    "Settings",
    html`${pair}${profile}${edge}${parent}${notify}`,
    200,
    // The everyday form makes its account with a passkey (#1890).
    pair ? passkeyJs : undefined,
  );
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
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
    const words = PROFILE_REFUSALS[updated.error];
    const at = PROFILE_REFUSAL_FIELD[updated.error];
    const errors: ProfileForm["errors"] =
      words === undefined || at === undefined ? { form: PROFILE_FALLBACK } : { [at]: words };
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
  return html`${help([["New password", "A passphrase beats a puzzle: a few unrelated words are long and easy to remember."]])}${block(
    "Change password",
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
        hint: "At least 10 characters.",
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
  )}`;
}

// GET /settings/password
export function passwordPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const body = passwordView();
  return timePhase(ctx.request, "render", () => accountShell(ctx, "password", "Password", body));
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
    source: clientAddress(ctx.request),
  });
  if (!changed.ok) {
    const error = {
      field: changed.error === "weak_password" || changed.error === "password_too_long" ? ("next" as const) : ("current" as const),
      text: CHANGE_PASSWORD_WORDS[changed.error],
    };
    return accountShell(ctx, "password", "Password", passwordView(error), 422);
  }
  return flashTo(ctx, "/settings/password", {
    message: PASSWORD_CHANGED_WORDS,
  });
}

// ---- tokens ----

/**
 * An account's signed-in browsers, each with Sign out. `base` is where its
 * acts post: the person's own settings, or the owner's page for them.
 */
export function sessionsCard(
  sessions: readonly SessionInfo[],
  base: string,
): Html {
  return block(
    "Signed-in browsers",
    sessions.length === 0
      ? html`<p class="muted">Not signed in on any browser.</p>`
      : html`<ul class="list setting-list">
          ${sessions.map((x) =>
            row({
              title: html`${time(x.createdAt)} ${x.current ? badge("This browser") : null}`,
              meta: html`last seen ${x.lastSeenAt ? time(x.lastSeenAt) : "not since"}`,
              trail: html`${confirmAction({
                action: `${base}/sessions/${x.id}/delete`,
                verb: "Sign out",
                size: "sm",
              })}`,
            }),
          )}
        </ul>`,
  );
}

/**
 * The two lines that connect a harness to this forge: its own public address,
 * and the token just minted when there is one (else a placeholder).
 */
export function connectCard(ctx: Ctx, token: string | undefined): Html {
  const url = publicOrigin(ctx.app.config.url, ctx.url.origin);
  const env = `FORGE_URL=${url} FORGE_TOKEN=${token ?? "<token>"}`;
  // The plugin marketplace is the forge's configured source, offered only while anyone can clone it.
  const repo = offeredPluginRepo(ctx.app.db, ctx.app.config.forgeRepo, UPSTREAM_REPO);
  const market = repo !== undefined;
  const clone = copyField("connect-claude", `${env} claude --plugin-dir plugins/claude-code`, "Claude Code command", "Copy command");
  return block(
    "Connect your harness",
    html`<p class="muted small mb">
        ${token ? "Your new token is filled in." : "Make a token below, then replace <token>."}
        See plugins/claude-code and plugins/opencode.
      </p>
      <p class="small">Claude Code</p>
      <p class="muted small mb">Start it with only FORGE_URL and sign in through /mcp (the forge server): nothing to copy. For scripts, use this command and the forge-token server, which sends the token.</p>
      ${market
        ? html`${copyField("connect-claude-install", claudeInstall(url), "Install the plugin (one command)", "Copy command")}
          <p class="muted small mb">From a clone</p>`
        : null}
      ${clone}
      <p class="small">OpenCode</p>
      ${copyField(
        "connect-opencode",
        `${opencodeInstall(url)} && ${env} opencode`,
        "OpenCode command",
        "Copy command",
      )}`,
  );
}

function tokensView(ctx: Ctx): Html {
  const tokens = timePhase(ctx.request, "tokens", () => listTokensWithClients(ctx.app.db, ctx.auth.user!.id));
  const sessions = timePhase(ctx.request, "sessions", () =>
    listSessions(ctx.app.db, ctx.auth.user!.id, cookieValue(ctx.request, "forge_session")),
  );
  const list = tokens.length === 0
    ? html`<p class="muted">No access codes yet. Mint one when a script, a CI job, or another machine needs to act as you.</p>`
    : html`<ul class="list setting-list">
        ${tokens.map((t) =>
          row({
            title: html`<strong>${t.name}</strong> ${badge(t.scope)}`,
            meta: html`created ${time(t.createdAt)} · last used ${t.lastUsedAt ? time(t.lastUsedAt) : "never"}${when(
              t.oauthClient,
              (client) => html`<span data-oauth-client> · ${client} · Signed in through OAuth; renews itself until you delete it</span>`,
            )}`,
            trail: confirmAction({ action: `/settings/tokens/${t.id}/delete`, verb: "Revoke", size: "sm" }),
          }),
        )}
      </ul>`;
  return html`${help([
      [
        "Access codes",
        "Use an access code as the password when pushing over HTTPS, or to call the API (sent as a Bearer header). Your account password works for git too — access codes are for scoped or automated access.",
      ],
      ["Access code name", "Name it after where it lives — laptop, CI, deploy box."],
      ["Scope", "An access code can never make another access code, whatever its scope."],
    ])}${connectCard(ctx, readFlash(ctx.request)?.code)}
    ${block("Access codes", list)}
    ${block(
      "New access code",
      html`<form method="post" action="/settings/tokens">
        ${uiField({
          label: "Access code name",
          name: "name",
          required: true,
        })}
        ${selectField({
          label: "Scope",
          name: "scope",
          options: [
            { value: "rw", label: "read + write — clone, push, open issues" },
            { value: "ro", label: "read only — clone and browse" },
            ...(ctx.auth.user?.isAdmin
              ? [{ value: "admin", label: "admin — everything, including settings" }]
              : []),
          ],
        })}
        ${ctx.auth.user?.isAdmin
          ? html`<div class="field" id="ai-admin">
              <label class="check">
                <input type="checkbox" name="aiAdmin" required />
                <span
                  >I mean to give this access code admin: you are the forge's admin,
                  so whatever holds it — an AI included — acts as admin.</span
                >
              </label>
            </div>`
          : null}
        <div class="form-actions">
          ${btn("Generate access code", { variant: "primary" })}
        </div>
      </form>`,
    )}
    ${sessionsCard(sessions, "/settings")}`;
}

// GET /settings/tokens
export function tokensPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const body = tokensView(ctx);
  return timePhase(ctx.request, "render", () => accountShell(ctx, "tokens", "Access codes", body));
}

// POST /settings/tokens
export async function tokenCreate(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  // Minting a token must come from the account itself — a browser session,
  // the platform edge's sign-in, or the password — never from another token
  // (no privilege bootstrapping). readForm below refuses a cross-site post.
  if (!isAccountItself(ctx.auth)) {
    return forbiddenPage(ctx, "An access code is made from your own signed-in account, never by another access code.");
  }
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  // A site admin's token acts as admin, whatever its scope: minted only on
  // purpose (#596), never by a form left at its defaults.
  if (ctx.auth.user.isAdmin && field(form, "aiAdmin") !== "on")
    return flashTo(ctx, "/settings/tokens", {
      tone: "danger",
      message: "You are the forge's admin: tick that you mean to give this access code admin, or make it from your everyday account.",
    });
  const scope = field(form, "scope");
  const chosen: TokenScope = scope === "ro" || scope === "admin" ? scope : "rw";
  const minted = createToken(
    ctx.app,
    ctx.auth.user,
    field(form, "name").trim() || "token",
    chosen,
  );
  if (!minted.ok && minted.error === "forbidden")
    return flashTo(ctx, "/settings/tokens", { tone: "danger", message: ADMIN_TOKEN_WORDS });
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

// POST /settings/sessions/:id/delete
export async function sessionDelete(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const user = ctx.auth.user;
  const ended = endAccountSession(
    ctx.app,
    user,
    user.username,
    ctx.params.id ?? "",
  );
  return flashTo(ctx, "/settings/tokens", {
    ...(ended.ok
      ? { message: "Signed out of that browser." }
      : { tone: "danger" as const, message: "No such browser." }),
  });
}

// ---- ssh keys ----

function keysView(
  ctx: Ctx,
  values: { name: string; key: string; error?: string },
): Html {
  const keys = timePhase(ctx.request, "keys", () => listKeys(ctx.app.db, ctx.auth.user!.id));
  const ssh = sshCommand(ctx.app);
  return html`${ssh === undefined
      ? html`<p class="mb muted" id="terminal-off">The terminal is off on this forge.</p>`
      : html`<div class="mb" id="terminal">
          ${terminalCommand(ssh, ctx.app.config.sshHostKey)}
        </div>`}
    <p class="muted small mb">
      Keys that sign you in over SSH. Paste a public key (<span class="mono"
        >~/.ssh/id_ed25519.pub</span
      >) — ed25519, ecdsa, or rsa (2048 bits or more).
    </p>
    ${block(
      "Computer keys",
      keys.length === 0
        ? html`<p class="muted">No computer keys yet. Add one and git over SSH stops asking for a password.</p>`
        : html`<ul class="list setting-list">
            ${keys.map((k) =>
              row({
                title: html`<strong>${k.name}</strong> ${badge(k.algo, { variant: "secondary" })}`,
                meta: html`<span class="mono">${k.fingerprint}</span> · added ${time(k.createdAt)} · last used ${k.lastUsedAt ? time(k.lastUsedAt) : "never"}`,
                trail: confirmAction({ action: `/settings/keys/${k.id}/delete`, verb: "Remove", size: "sm" }),
              }),
            )}
          </ul>`,
    )}
    ${block(
      "New SSH key",
      html`<form method="post" action="/settings/keys">
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
          ${btn("Add computer key", { variant: "primary" })}
        </div>
        ${refusal(values.error)}
      </form>`,
    )}`;
}

// GET /settings/keys
export function keysPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const body = keysView(ctx, { name: "", key: "" });
  return timePhase(ctx.request, "render", () => accountShell(ctx, "keys", "Computer keys", body));
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
      "Computer keys",
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
