/**
 * Origins on the web: the connected accounts and the three ways to connect
 * one. The picker that turns a remote repository into a local mirror lives
 * in `origin-repos.ts`.
 *
 * Three connect paths share one page because which one you get is a property
 * of the forge you are connecting, not a preference (`docs/ORIGINS.md`):
 * GitHub answers a device grant, Forgejo and Gitea answer only an
 * authorization code flow and need a per-instance application registration,
 * and a pasted token always works. Every one of them lands on the same list.
 *
 * Two rules run through the file. A token is *write-only* to this surface:
 * it is read off a form, handed to an action, and never rendered, echoed in
 * a value attribute, or carried in a query string. And an OAuth flow is a
 * row, not a page state — the browser can be closed, the phone can do the
 * typing, and coming back to `/settings/origins/flows/:id` resumes exactly
 * where it was — that page and its poll live in `origin-flow.ts`.
 */

import { FORGE_NOT_CARRIED } from "../../origins/words.ts";
import {
  checkOriginAgain,
  connectOrigin,
  connectRefusal,
  completeOAuthCallback,
  deleteOriginApp,
  disconnectOrigin,
  listOriginApps,
  listUserOrigins,
  registerOriginApp,
  replaceOriginToken,
  startOAuthConnect,
  syncOriginNow,
  type Reattachment,
} from "../../actions/origins.ts";
import { startBring } from "../../actions/bring.ts";
import { hasArchive } from "../../actions/origin_archive.ts";
import {
  NO_SUCH_ORIGIN,
  connectWords,
  disconnectedWords,
  syncedWords,
  CHECK_TOO_SOON,
  CHECK_WORDS,
} from "../../actions/origin_words.ts";
import {
  editableHosts,
  envHosts,
  isTrustedHost,
  mayEditTrustedHosts,
  rejectedSentence,
  updateTrustedHosts,
} from "../../origins/trusted-hosts.ts";
import { reattachMessage } from "./frozen.ts";
import { replaceTokenMessage } from "../../origins/token-reach.ts";
import { writesPaused } from "../../origins/credential.ts";
import { brokerOffers, knownOffers, offerFor } from "../../origins/broker.ts";
import type { BrokerOffer } from "../../spawn/origin_broker_wire.ts";
import {
  listDetachedMirrors,
  mirrorsByOrigin,
  type Origin,
} from "../../core/origins.ts";
import { getReposByIds } from "../../core/repos.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { oauthCallbackUri } from "../../http/api.ts";
import {
  settingsLayout,
  signInFirst,
  type SettingsSection,
  NOT_ADMIN_HERE,
  forbiddenPage,
} from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page, redirect } from "../layout.ts";
import {
  badge,
  btn,
  confirmAction,
  empty,
  icon,
  row,
  time,
  field as uiField,
  type IconName,
  copyField,
} from "../ui.ts";

export type AccountSection =
  | "billing"
  | "adminflows"
  | "security"
  | "profile"
  | "appearance"
  | "confirms"
  | "password"
  | "tokens"
  | "shells"
  | "keys"
  | "model"
  | "passkeys"
  | "origins"
  | "usage"
  | "spend"
  | "crew"
  | "accounts"
  | "trusted"
  | "people"
  | "subscriptions"
  | "backups"
  | "traffic"
  | "secrets"
  | "devices"
  | "capacity"
  | "telemetry"
  | "access"
  | "limits"
  | "economics"
  | "flags"
  | "templates"
  | "features"
  | "packs"
  | "captain"
  | "cloud";

/**
 * The settings sidebar, with Origins on it. Kept here so the account pages
 * and this one cannot drift apart in either direction. Crew is a forge
 * admin's section — an agent is an account that acts — so it is on the nav
 * only for one, the way the repo header hides Settings from a non-admin.
 */
const USAGE: ReadonlySet<AccountSection> = new Set(["usage", "spend", "capacity", "telemetry"]);

/**
 * The groups a person thinks in, in order; an admin's groups come after their
 * own. Each row: its group, label, address, icon, the sections it stands for,
 * and whether only a forge admin sees it.
 */
const SECTION_ROWS: readonly (readonly [
  group: string,
  label: string,
  href: string,
  icon: NonNullable<SettingsSection["icon"]>,
  is: (current: AccountSection) => boolean,
  admin: boolean,
])[] = [
  ["Account", "Profile", "/settings", "user", (c) => c === "profile", false],
  ["Account", "Appearance", "/settings/appearance", "eye", (c) => c === "appearance", false],
  ["Account", "Password", "/settings/password", "lock", (c) => c === "password", false],
  ["Account", "Passkeys", "/settings/passkeys", "key", (c) => c === "passkeys", false],
  ["Account", "Computer keys", "/settings/keys", "lock", (c) => c === "keys", false],
  ["Account", "Access codes", "/settings/tokens", "key", (c) => c === "tokens", false],
  ["Account", "Confirms", "/settings/confirms", "check", (c) => c === "confirms", false],
  ["Crew and AI", "Model", "/settings/model", "key", (c) => c === "model", false],
  ["Crew and AI", "Crew", "/settings/crew", "bot", (c) => c === "crew", true],
  ["Crew and AI", "Captain", "/settings/captain", "bot", (c) => c === "captain", true],
  ["Crew and AI", "Subscriptions", "/settings/subscriptions", "key", (c) => c === "subscriptions", true],
  ["Crew and AI", "Usage", "/settings/spend", "activity", (c) => USAGE.has(c), true],
  ["Connections", "Connected accounts", "/settings/origins", "globe", (c) => c === "origins", false],
  ["Connections", "Cloud", "/settings/cloud", "key", (c) => c === "cloud", true],
  ["Connections", "Secrets", "/settings/secrets", "lock", (c) => c === "secrets", true],
  ["Connections", "Devices", "/settings/devices", "globe", (c) => c === "devices", true],
  ["Security", "Security", "/settings/security", "lock", (c) => c === "security", true],
  ["Security", "Traffic", "/settings/traffic", "users", (c) => c === "traffic", true],
  ["Security", "Trusted sources", "/settings/trusted", "lock", (c) => c === "trusted", true],
  ["Security", "Access", "/settings/access", "activity", (c) => c === "access", true],
  ["This forge", "Accounts", "/settings/accounts", "users", (c) => c === "accounts", true],
  ["This forge", "People", "/settings/people", "users", (c) => c === "people", true],
  ["This forge", "Limits", "/admin/limits", "activity", (c) => c === "limits", true],
  ["This forge", "Economics", "/settings/economics", "activity", (c) => c === "economics", true],
  ["This forge", "Billing", "/settings/billing", "activity", (c) => c === "billing", true],
  ["This forge", "Flows", "/admin/flows", "activity", (c) => c === "adminflows", true],
  ["This forge", "Flags", "/settings/flags", "activity", (c) => c === "flags", true],
  ["This forge", "Templates", "/settings/app-templates", "rocket", (c) => c === "templates", true],
  ["This forge", "Features", "/settings/features", "rocket", (c) => c === "features", true],
  ["This forge", "Packs", "/settings/packs", "rocket", (c) => c === "packs", true],
  ["This forge", "Backups", "/settings/backups", "download", (c) => c === "backups", true],
];

export function accountSections(
  current: AccountSection,
  o: { admin?: boolean } = {},
): SettingsSection[] {
  return SECTION_ROWS.filter((r) => o.admin === true || !r[5]).map(
    ([group, label, href, icon, is]) => ({ group, label, href, icon, current: is(current) }),
  );
}

/** The mark a forge wears wherever it is named. */
export function originIcon(kind: "github" | "forgejo" | "gitea"): IconName {
  return kind;
}

/** `codeberg.org` from `https://codeberg.org` — what a person calls a forge. */
export function hostLabel(url: string): string {
  return URL.parse(url)?.host ?? url;
}

/** Two hosts are the same instance when their hostnames match. */
function sameHost(a: string, b: string): boolean {
  const one = URL.parse(a) ?? URL.parse(`https://${a}`);
  const two = URL.parse(b) ?? URL.parse(`https://${b}`);
  return one !== null && two !== null && one.host === two.host;
}

/**
 * Where an OAuth application must be told to send the browser back to.
 *
 * Deliberately not `ctx.url.origin`: that is the request's Host header, which
 * a client or a sloppy proxy can write, and this string is registered with
 * another forge. `oauthCallbackUri` takes it from `FORGE_URL`, or from a
 * request whose hostname the operator already vouched for with `FORGE_HOST`,
 * or from loopback — and answers "" when it knows none of those, which is
 * the case this page has to explain rather than paper over.
 */
export const callbackUri = (ctx: Ctx): string =>
  oauthCallbackUri(ctx.url, ctx.app.config.host);

/**
 * The floor every page here sits on, matching the JSON API's exactly: an
 * origin holds a credential for another forge, so reaching one needs the
 * *account* — a same-origin session, the password, or an explicit `admin`
 * token. A leaked `ro` or `rw` token must not be able to so much as
 * enumerate whose GitHub is connected, let alone spend it.
 */
export function accountOnly(ctx: Ctx): Response | undefined {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (ctx.auth.via === "session" || ctx.auth.via === "password")
    return undefined;
  if (ctx.auth.scope === "admin") return undefined;
  return forbiddenPage(ctx, "This takes your own signed-in account or an admin token.");
}

// ---- the origin list ----

type OriginHealth = "healthy" | "needs_reauth" | "error";

function health(origin: Origin): OriginHealth {
  if (origin.needsReauth) return "needs_reauth";
  return origin.lastError === "" ? "healthy" : "error";
}

function healthBadge(origin: Origin): Html {
  const state = health(origin);
  if (state === "needs_reauth")
    return badge("Needs re-auth", { tone: "danger", icon: "alert" });
  if (state === "error") return badge("Error", { tone: "attn", icon: "alert" });
  return badge("Healthy", { tone: "success", icon: "check" });
}

/**
 * What a dead credential costs, and the way to fix it: the mirrors that
 * stopped with it, and connecting the same account again — which puts a
 * new credential on this origin in place, so nothing detaches.
 */
function reauthNote(origin: Origin, mirrors: number): Html {
  const frozen =
    mirrors === 0
      ? "Nothing syncs through it until it is re-authorized."
      : `${mirrors === 1 ? "One mirror is" : `${mirrors} mirrors are`} frozen until it is re-authorized.`;
  return html`<p class="small mt">
    ${frozen}
    <a
      href="/settings/origins?host=${encodeURIComponent(origin.webUrl)}#connect"
      >Re-authorize ${origin.login} at ${hostLabel(origin.webUrl)}</a
    >
    by connecting it again.
  </p>`;
}

/**
 * An origin whose account the operator guard could not verify reads and
 * syncs but writes nothing (`writesPaused`): said where the origin is, with
 * the way out, a check now.
 */
function pausedNote(origin: Origin): Html {
  return html`<div class="toast mt" data-tone="attn" role="status">
    ${icon("alert")}
    <div class="toast-body">
      Couldn't verify this connection; writes paused. Reading and syncing go
      on.
    </div>
    <form method="post" action="/settings/origins/${origin.id}/check">
      ${btn("Check again", { size: "sm", variant: "outline", icon: "sync" })}
    </form>
  </div>`;
}

function originCard(origin: Origin, mirrors: number, paused = false): Html {
  const base = `/settings/origins/${origin.id}`;
  return row({
    lead: icon(originIcon(origin.kind)),
    title: html`${origin.login}<span class="muted"> @ </span>${hostLabel(
      origin.webUrl,
    )}`,
    meta: html`${origin.authKind === "oauth" ? "OAuth" : "personal access token"}
      ${when(origin.readOnly, () => html` · read-only: nothing is written back`)}
      ·
      ${origin.lastSyncAt === null
        ? html`never synced`
        : html`synced ${time(origin.lastSyncAt)}`}
      ${when(
        isTrustedHost(URL.parse(origin.webUrl)?.hostname ?? ""),
        () => html` · trusted internal host`,
      )}`,
    trail: healthBadge(origin),
    after: html`${when(
        origin.lastError !== "",
        () => html`<div class="field mt" data-invalid>
          <span class="error" role="alert" id="origin-${origin.id}-err"
            >${origin.lastError}</span
          >
        </div>`,
      )}
      ${when(origin.needsReauth, () => reauthNote(origin, mirrors))}
      ${when(
        origin.software === "forge",
        () => html`<p class="small mt">Another forge. ${FORGE_NOT_CARRIED}</p>`,
      )}
      ${when(paused, () => pausedNote(origin))}
      <div class="bar mt">
        <form method="post" action="${base}/sync">
          ${btn("Sync now", { size: "sm", icon: "sync" })}
        </form>
        ${btn("Repositories", {
          href: `${base}/repos`,
          size: "sm",
          variant: "outline",
          icon: "repo",
        })}
        ${when(hasArchive(origin), () =>
          btn("Archived", {
            href: `${base}/archived`,
            size: "sm",
            variant: "outline",
            icon: "clock",
          }),
        )}
        <span class="spacer"></span>
        ${confirmAction({
          action: `${base}/delete`,
          verb: "Disconnect",
          size: "sm",
        })}
      </div>`,
  });
}

// ---- the connect card ----

interface ConnectValues {
  host: string;
  clientId: string;
  /** Which sub-form to show open, and where an error belongs. */
  mode: "none" | "host" | "register";
  hostError?: string;
  tokenHost: string;
  tokenError?: string;
  registerError?: string;
  /** Sign-in cannot work for this address, so the token path opens. */
  offerToken?: boolean;
  trustedText?: string;
  trustedError?: string;
}

const blankValues = (): ConnectValues => ({
  host: "",
  clientId: "",
  mode: "none",
  tokenHost: "",
});

/**
 * The GitHub path — or, when nobody has registered an application yet, the
 * three steps that produce one. "Not configured" is a *task*, not a status:
 * the previous version of this note named the environment variable and left
 * the reader to find out on GitHub's site what to put in it, which is the
 * kind of dead end that sends someone back to pasting a token forever.
 */
/** Whether "Connect GitHub" has a client id to run the device flow with. */
export function githubConnectable(ctx: Ctx): boolean {
  return (
    (process.env.FORGE_GITHUB_CLIENT_ID ?? "").trim() !== "" ||
    knownOffers(ctx.app).some((o) => o.kind === "github") ||
    listOriginApps(ctx.app, ctx.auth.user!).some((a) => a.kind === "github")
  );
}

function githubSection(configured: boolean, callback: string): Html {
  if (!configured) {
    const back =
      callback === "" ? "<your forge>/settings/origins/callback" : callback;
    return html`<p class="muted small">
        Needs a one-time OAuth app setup: no GitHub application is registered
        for this forge yet, so the device flow has no client id to use. Three
        steps, once, for every user of this forge:
      </p>
      <ol class="muted small">
        <li>
          Create an OAuth App at
          <a
            href="https://github.com/settings/developers"
            target="_blank"
            rel="noopener noreferrer"
            >github.com/settings/developers</a
          >: name it anything, set the homepage to this forge's URL, set the
          authorization callback URL to <span class="mono break">${back}</span>,
          and tick <strong>Enable Device Flow</strong>.
        </li>
        <li>
          Start the forge with
          <span class="mono">FORGE_GITHUB_CLIENT_ID=&lt;client id&gt;</span>.
          <span class="mono">FORGE_GITHUB_CLIENT_SECRET</span> is optional and
          buys one thing: disconnecting revokes the grant on GitHub too.
        </li>
        <li>Reload this page — the GitHub button appears here.</li>
      </ol>
      <p class="muted small">
        Until then, a personal access token below works and needs no
        registration anywhere.
      </p>`;
  }
  return html`<p class="muted small">
      A short code and a URL you type it into — from this machine or from your
      phone. Nothing is typed into this terminal or this page.
    </p>
    <form method="post" action="/settings/origins/oauth">
      <input type="hidden" name="kind" value="github" />
      ${btn("Connect GitHub", { icon: "github" })}
    </form>`;
}

function forgejoSection(
  ctx: Ctx,
  values: ConnectValues,
  registered: { webUrl: string; clientId: string; id: string } | undefined,
): Html {
  const back = callbackUri(ctx);
  if (back === "") {
    return html`<p class="muted small" id="origin-callback-note">
      This forge does not know its own public URL, so it cannot register a
      callback for the code flow. Set <span class="mono">FORGE_URL</span> to the
      base URL people reach it at (or <span class="mono">FORGE_HOST</span> to
      the hostname it is served on) and this path lights up. A pasted token
      works either way.
    </p>`;
  }
  // Two verbs, two endpoints, and HTML forbids nesting one form in another —
  // so the "forget" form sits beside the authorize form and its button joins
  // it by id.
  const authorize =
    registered !== undefined && values.host !== ""
      ? html`<form
            method="post"
            action="/settings/origins/apps/${registered.id}/delete"
            id="forget-app"
          ></form>
          <form method="post" action="/settings/origins/oauth" class="mt">
            <input type="hidden" name="host" value="${values.host}" />
            <p class="muted small">
              An application is registered for
              <span class="mono">${hostLabel(registered.webUrl)}</span> (client
              id <span class="mono">${registered.clientId}</span>).
            </p>
            <div class="bar">
              ${btn("Authorize", { icon: "external" })}
              ${btn("Forget this app", {
                size: "sm",
                variant: "ghost",
                form: "forget-app",
              })}
            </div>
          </form>`
      : null;

  const registerForm =
    values.mode === "register" ||
    (values.host !== "" && registered === undefined)
      ? html`<div class="mt">
          <p class="small">
            Every Forgejo and Gitea instance needs its own OAuth application —
            there is no shared client id, and no device grant to fall back on.
            It takes about a minute:
          </p>
          <ol class="muted small">
            <li>
              Open
              <span class="mono"
                >${values.host === ""
                  ? "https://your.forge"
                  : values.host}/user/settings/applications</span
              >.
            </li>
            <li>
              Create an application. Name it anything —
              <span class="mono">forge</span> will do.
            </li>
            <li>
              Set the redirect URI to exactly:
              ${copyField("redirect-uri", back, "Redirect URI", "Copy the redirect URI")}
            </li>
            <li>
              Leave "confidential client" off — a public client is fine, and
              this forge always uses PKCE.
            </li>
            <li>Paste the client id it gives you below.</li>
          </ol>
          <form method="post" action="/settings/origins/apps">
            ${uiField({
              label: "Instance",
              name: "host",
              id: "f-app-host",
              value: values.host,
              required: true,
              placeholder: "codeberg.org",
              ...(values.registerError ? { error: values.registerError } : {}),
            })}
            ${uiField({
              label: "Client ID",
              name: "clientId",
              value: values.clientId,
              required: true,
              mono: true,
              autocomplete: "off",
            })}
            ${uiField({
              label: "Client secret",
              name: "clientSecret",
              type: "password",
              autocomplete: "off",
              hint: "Optional. A public client is fine; a secret only buys revoke-on-disconnect.",
            })}
            <div class="form-actions">
              ${btn("Register application")}
            </div>
          </form>
        </div>`
      : null;

  return html`<p class="muted small">
      Needs an app registration on the instance. Name it and this forge works
      out which it is, then sends you there to authorize.
    </p>
    <form method="post" action="/settings/origins/oauth">
      ${uiField({
        label: "Instance",
        name: "host",
        value: values.host,
        required: true,
        placeholder: "codeberg.org",
        autocomplete: "off",
      })}
      <div class="form-actions">
        ${btn("Continue", { variant: registered ? "secondary" : "primary" })}
      </div>
    </form>
    ${authorize} ${registerForm}`;
}

/**
 * One way to connect, drawn as a list row that folds open on its form: the
 * caret leads (it turns when open), the brand glyph and the name are the
 * title, and the steps and the form are the body.
 */
function connectPath(
  id: string,
  glyph: IconName,
  title: Html | string,
  open: boolean,
  body: Html,
): Html {
  return row({
    lead: icon("chevronRight"),
    title: html`${icon(glyph)}${title}`,
    fold: { id, open, body: html`<div class="card-body">${body}</div>` },
  });
}

/**
 * The path that works everywhere and needs nothing registered anywhere, so it
 * is the one the page opens on. The other two are real, and folded away: a
 * page whose first control cannot be used until an operator sets an
 * environment variable is a page that teaches people the product is fiddly.
 */
function tokenSection(values: ConnectValues): Html {
  return html`<p class="muted small">
      Nothing to register, anywhere. The token is validated against the forge
      before it is stored, encrypted at rest, and never shown again.
    </p>
    <form method="post" action="/settings/origins/token">
      ${uiField({
        label: "Instance",
        name: "host",
        value: values.tokenHost,
        required: true,
        placeholder: "github.com",
        autocomplete: "off",
        ...(values.tokenError ? { error: values.tokenError } : {}),
      })}
      ${uiField({
        label: "Token",
        name: "token",
        type: "password",
        required: true,
        mono: true,
        autocomplete: "off",
        hint: "It is never displayed after this.",
      })}
      ${readOnlyField()}
      ${tokenNeeds(values.tokenHost)}
      <div class="form-actions">${btn("Connect")}</div>
    </form>`;
}

/** The one Read-only checkbox, on every way to connect by token. */
function readOnlyField(): Html {
  return uiField({
    label: "Read-only",
    name: "readOnly",
    type: "checkbox",
    value: "1",
    hint: "Nothing is ever written back to that account: no comments, pulls, pushes or merges.",
  });
}

const OLDER_FORGE_DOC = "/trevato/forge/blob/main/docs/features/forge-origin-older.md#connecting-from-an-older-forge";

/** The one line for a forge older than 0.7.346 (#9626): it cannot start a connection, this side can. */
function olderForgeLine(): Html {
  return html`<p class="muted small" id="older-forge-line">
    A forge older than 0.7.346 cannot connect outward: connect it from here, and
    upgrade it to connect both ways.
    <a href="${OLDER_FORGE_DOC}">Connecting from an older forge</a>
  </p>`;
}

/**
 * The path a friend's forge needs, first on the page: its address and one
 * button. Only a forge that cannot name its own callback asks for a token here,
 * and the line says where that token is made.
 */
function forgeSection(ctx: Ctx, values: ConnectValues): Html {
  if (callbackUri(ctx) !== "")
    return html`<p class="muted small">
        You have an account on a friend's forge and want their apps here. Type
        their address and sign in there; you come straight back. Their forge may
        run an older release than this one: that is fine.
      </p>
      <form method="post" action="/settings/origins/oauth">
        ${uiField({
          label: "Their forge's address",
          name: "host",
          id: "f-forge-host",
          value: values.host || values.tokenHost,
          required: true,
          placeholder: "forge.example.com",
          autocomplete: "off",
          ...(values.hostError ? { error: values.hostError } : {}),
        })}
        <div class="form-actions">${btn("Sign in there", { variant: "primary", icon: "external" })}</div>
      </form>
      ${olderForgeLine()}`;
  const site =
    values.tokenHost === ""
      ? null
      : URL.parse(values.tokenHost.includes("://") ? values.tokenHost : `https://${values.tokenHost}`);
  const tokens =
    site === null || (site.protocol !== "https:" && site.protocol !== "http:")
      ? html`<span class="mono">/settings/tokens</span> on their forge`
      : btn(`${site.host}/settings/tokens`, { href: `${site.origin}/settings/tokens`, external: true, variant: "link" });
  return html`<p class="muted small">
      You have an account on a friend's forge and want their apps here. Type
      their address and a token from them; the token is checked before it is
      stored, encrypted at rest, and never shown again. Their forge may run an
      older release than this one: that is fine.
    </p>
    <form method="post" action="/settings/origins/token">
      ${uiField({
        label: "Their forge's address",
        name: "host",
        id: "f-forge-host",
        value: values.tokenHost,
        required: true,
        placeholder: "forge.example.com",
        autocomplete: "off",
        ...(values.tokenError || values.hostError ? { error: values.tokenError ?? values.hostError ?? "" } : {}),
      })}
      ${uiField({
        label: "Token",
        name: "token",
        id: "f-forge-token",
        type: "password",
        required: true,
        mono: true,
        autocomplete: "off",
        hint: "Read is enough to bring an app; private repositories come with it.",
      })}
      ${readOnlyField()}
      <p class="muted small">Make the token there: ${tokens} (Settings → Access codes).</p>
      <div class="form-actions">
        ${btn("Connect that forge", { variant: "primary", icon: "globe" })}
      </div>
    </form>
    ${olderForgeLine()}`;
}

/** The admin's list of hosts an origin may reach inside the network. */
function trustedHostsCard(text: string, error?: string): Html {
  const fixed = envHosts();
  return html`<section class="settings-block">
      <h2>Trusted internal hosts</h2>
      <p class="muted small">
        Origins on these exact host names may resolve to a private address
        (your own Forgejo, reached inside the cluster). Webhooks never do.
        Separate names with a space, comma or new line; addresses, wildcards and
        URLs are not accepted.
      </p>
      ${when(
        fixed.length > 0,
        () =>
          html`<p class="muted small">
            Set by the environment:
            <span class="mono">${fixed.join(", ")}</span>
          </p>`,
      )}
      <form method="post" action="/settings/origins/trusted-hosts">
        ${uiField({
          label: "Host names",
          name: "hosts",
          type: "textarea",
          rows: 3,
          value: text,
          mono: true,
          spellcheck: false,
          ...(error ? { error } : {}),
        })}
        <div class="form-actions">${btn("Save", { variant: "primary" })}</div>
      </form>
    </section>`;
}

/**
 * What a Forgejo or Gitea token needs, in the words of the page that makes
 * one, and — once the instance is known — a link to that page with the
 * name and the scopes already chosen. Forgejo 15 fills its form from the
 * query (`/user/settings/applications/tokens/new`); an older one or Gitea
 * opens the plain form, and the list says what to pick.
 */
function tokenNeeds(host: string): Html {
  const site =
    host === ""
      ? null
      : URL.parse(host.includes("://") ? host : `https://${host}`);
  const link =
    site === null || site.hostname === "github.com" || site.hostname === "github"
      ? undefined
      : `${site.origin}/user/settings/applications/tokens/new?name=forge&resource=all&scope=read:user&scope=write:repository&scope=write:issue`;
  return html`<div class="small muted">
    <p>For Forgejo or Gitea, the token needs:</p>
    <ul>
      <li>User: Read</li>
      <li>Repository: Read and write</li>
      <li>Issue: Read and write</li>
      <li>Everything else: No access</li>
    </ul>
    ${link === undefined
      ? null
      : html`<p>
          ${btn(`Make this token at ${site!.host}`, { href: link, external: true, variant: "link" })}, with these already chosen. On Gitea or an older Forgejo, open
          Settings → Applications there instead.
        </p>`}
  </div>`;
}

// ---- the page ----

/**
 * The one-click buttons a hosted forge shows when its parent can sign people
 * in to an origin for it (`origins/broker.ts`): one each, the same form the
 * parent's own page posts, and a line that says what is kept here.
 */
function parentButtons(offers: readonly BrokerOffer[]): Html | null {
  if (offers.length === 0) return null;
  return html`<div class="bar mb" data-parent-signin>
      ${offers.map(
        (o) => html`<form method="post" action="/settings/origins/oauth">
          ${o.kind === "github"
            ? html`<input type="hidden" name="kind" value="github" />`
            : html`<input type="hidden" name="host" value="${o.host}" />`}
          ${btn(`Connect ${o.name}`, {
            variant: "primary",
            icon: o.kind === "github" ? "github" : "forgejo",
          })}
        </form>`,
      )}
    </div>
    <p class="muted small mb">
      You sign in there; this forge keeps only your token, and nothing else of
      yours leaves it.
    </p>`;
}

function originsView(
  ctx: Ctx,
  values: ConnectValues,
  timing?: { rendering: number },
): Html {
  const user = ctx.auth.user!;
  // Only the page itself names its reads; the error re-renders do not.
  const read = <T>(name: string, work: () => T): T =>
    timing === undefined ? work() : timePhase(ctx.request, name, work);
  const origins = read("origins", () => listUserOrigins(ctx.app, user));
  const mirrors = read("mirrors", () => mirrorsByOrigin(ctx.app.db, user.id));
  const apps = read("apps", () => listOriginApps(ctx.app, user));
  const frozen = read("frozen", () => readFrozen(ctx));
  if (timing !== undefined) timing.rendering = performance.now();
  const githubConfigured = githubConnectable(ctx);
  const offers = knownOffers(ctx.app);
  // The token form is the way that always works. Under a one-click button it is the quiet way, not an equal one.
  const tokenPath = connectPath(
    "connect-token",
    "key",
    offers.length > 0 ? "Or paste a token" : "A token for GitHub, Forgejo or Gitea",
    values.offerToken === true || values.tokenError !== undefined,
    tokenSection(values),
  );
  const matched =
    values.host === ""
      ? undefined
      : apps.find((a) => sameHost(a.webUrl, values.host));

  return html`<p class="muted small mb">
      An origin is an account on another forge. Mirror repositories in and their
      issues, pulls and comments come with them — and anything you do here is
      written through to the origin first.
    </p>
    ${origins.length === 0
      ? html`<section class="settings-block">
          <h2>Connected accounts</h2>
          <p class="small">
            No connected accounts yet: connect another forge, GitHub, a Forgejo
            instance or a Gitea instance below.
          </p>
        </section>`
      : html`<section class="settings-block">
          <h2>Connected accounts</h2>
          <ul class="list setting-list" data-origins>
            ${origins.map((o) =>
              originCard(
                o,
                mirrors.get(o.id)?.count ?? 0,
                writesPaused(ctx.app, o.id) !== undefined,
              ),
            )}
          </ul>
        </section>`}
    ${frozenCard(frozen)}
    ${mayEditTrustedHosts(user)
      ? trustedHostsCard(
          values.trustedText ?? editableHosts().join("\n"),
          values.trustedError,
        )
      : null}
    <section class="settings-block" id="connect">
      <h2>Connect an account</h2>
      ${parentButtons(offers)}
      <ul class="list">
        ${connectPath(
          "connect-forge",
          "globe",
          html`Another forge ${badge("a friend's", { tone: "success" })}`,
          offers.length === 0,
          forgeSection(ctx, values),
        )}
        ${offers.length > 0 ? null : tokenPath}
        ${offers.some((o) => o.kind === "github")
          ? null
          : connectPath(
              "connect-github",
              "github",
              "GitHub, one click",
              values.mode !== "none",
              githubSection(githubConfigured, callbackUri(ctx)),
            )}
        ${connectPath(
          "connect-forgejo",
          "forgejo",
          "Forgejo / Gitea, one click",
          values.mode !== "none",
          forgejoSection(
            ctx,
            values,
            matched === undefined
              ? undefined
              : {
                  webUrl: matched.webUrl,
                  clientId: matched.clientId,
                  id: matched.id,
                },
          ),
        )}
        ${offers.length > 0 ? tokenPath : null}
      </ul>
      <p class="muted small">
        <strong>One-click sign-in.</strong> Another forge needs nothing set
        up. GitHub, Forgejo and Gitea need somebody to register an
        application once: for GitHub, per forge; for Forgejo and Gitea, per
        instance.
      </p>
    </section>`;
}

/**
 * The viewer's mirrors whose origin is gone, and where each came from:
 * connecting an account on that host brings them back by itself, so this
 * card's only verb is the connect form beneath it.
 */
function readFrozen(ctx: Ctx) {
  const frozen = listDetachedMirrors(ctx.app.db, {
    ownerId: ctx.auth.user!.id,
  });
  const repos =
    frozen.length === 0
      ? (new Map() as ReturnType<typeof getReposByIds>)
      : getReposByIds(
          ctx.app.db,
          frozen.map((m) => m.repoId),
        );
  return { frozen, repos };
}

function frozenCard({ frozen, repos }: ReturnType<typeof readFrozen>): Html | null {
  if (frozen.length === 0) return null;
  const rows = frozen.flatMap((m) => {
    const repo = repos.get(m.repoId);
    if (repo === undefined) return [];
    const host = hostLabel(m.htmlUrl);
    return [
      row({
        href: `/${repo.ownerName}/${repo.name}#frozen`,
        nav: true,
        lead: icon("repo"),
        title: `${repo.ownerName}/${repo.name}`,
        meta: html`mirrors <span class="mono">${m.fullName}</span>${host === ""
          ? null
          : html` at ${host}`}`,
      }),
    ];
  });
  return html`<section class="settings-block">
    <h2>Frozen mirrors</h2>
    <p class="muted small">Connect an account where they came from to bring them back.</p>
    <ul class="list setting-list">
      ${rows}
    </ul>
  </section>`;
}

export function shell(
  ctx: Ctx,
  body: Html,
  status = 200,
  scriptJs?: string,
): Response {
  return page(
    {
      ctx,
      title: "Connected accounts",
      ...(scriptJs === undefined ? {} : { scriptJs }),
      body: html`<div class="page-head"><h1>Connected accounts</h1></div>
        ${settingsLayout(
          accountSections("origins", {
            admin: ctx.auth.user?.isAdmin === true,
          }),
          body,
          "Account settings",
        )}`,
    },
    status,
  );
}

// GET /settings/origins
export async function originsPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const denied = accountOnly(ctx);
  if (denied) return denied;
  // A hosted forge learns what its parent can sign people in to (kept five minutes); a forge with no parent does not wait.
  await brokerOffers(ctx.app);
  const params = ctx.url.searchParams;
  const values = blankValues();
  const host = params.get("host") ?? "";
  if (host !== "") {
    values.host = host.slice(0, 200);
    // A re-authorize or a frozen mirror's link names the forge; the token
    // form is the way that always works, so it comes prefilled too.
    values.tokenHost = values.host;
    values.mode = params.get("register") === "1" ? "register" : "host";
  }
  // The callback lands here with one of these two, so its outcome is visible
  // without a page of its own.
  const error = params.get("error");
  const connected = params.get("connected") === "1";
  const banner = connected
    ? html`<div class="toast" data-tone="success" role="status">
        ${icon("check")}
        <div class="toast-body">Origin connected.</div>
      </div>`
    : error !== null && error !== ""
      ? html`<div class="toast" data-tone="danger" role="status">
          ${icon("alert")}
          <div class="toast-body">
            ${error === "state"
              ? "That authorization could not be matched to a connect you started here. Start again."
              : error.slice(0, 300)}
          </div>
        </div>`
      : null;

  const timing = { rendering: performance.now() };
  const view = originsView(ctx, values, timing);
  const response = shell(ctx, html`${banner}${view}`);
  notePhase(ctx.request, "render", performance.now() - timing.rendering);
  return response;
}

// POST /settings/origins/token
export async function originConnectToken(ctx: Ctx): Promise<Response> {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const host = field(form, "host").trim();
  const token = field(form, "token");

  const connected = await connectOrigin(ctx.app, ctx.auth.user, {
    host,
    token,
    readOnly: field(form, "readOnly") === "1",
  });
  if (!connected.ok) {
    // The host comes back; the token deliberately does not. Re-typing a
    // secret is a smaller cost than a secret sitting in a value attribute.
    const values = blankValues();
    values.tokenHost = host;
    const refused = connectRefusal(connected.error);
    values.tokenError = refused.message ?? connectMessage(refused.code);
    return shell(ctx, originsView(ctx, values), 422);
  }
  const { reattached } = connected.value;
  const back = reattached.filter((r) => r.refused === null);
  const stuck = reattached.filter((r) => r.refused !== null);
  const name = (r: Reattachment): string => `${r.owner}/${r.name}`;
  return flashTo(ctx, "/settings/origins", {
    ...(stuck.length > 0 ? { tone: "attn" as const } : {}),
    message: [
      `Connected ${connected.value.login} at ${hostLabel(connected.value.webUrl)}.`,
      ...(back.length === 0
        ? []
        : [
            `Reconnected ${back.length === 1 ? "1 mirror" : `${back.length} mirrors`}: ${back.map(name).join(", ")}.`,
          ]),
      ...stuck.map(
        (r) =>
          `${name(r)} stays frozen: ${reattachMessage(r.refused!, {
            fullName: r.fullName,
            htmlUrl: "",
          })}`,
      ),
    ].join(" "),
  });
}

const connectMessage = connectWords;

// POST /settings/origins/oauth
/**
 * Where a connect or a disconnect started, when it was not here: `/migrate`
 * or `/bring`, named by a fixed word — never a path a form can choose.
 */
export type Then = "/migrate" | "/bring" | undefined;
export const thenOf = (value: string | null): Then =>
  value === "migrate" ? "/migrate" : value === "bring" ? "/bring" : undefined;

/** The link a `/bring` started with, kept across a connect: a short http(s) URL or nothing. */
export function linkOf(value: string | null): string | undefined {
  if (value === null || value.length > 300 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  const url = URL.parse(value);
  return url !== null && (url.protocol === "https:" || url.protocol === "http:") ? value : undefined;
}

/** The query that carries `then` (and the link, for `/bring`) through a connect flow. */
export function thenQuery(then: Then, link?: string): string {
  if (then === undefined) return "";
  if (then === "/migrate") return "then=migrate";
  return `then=bring${link === undefined ? "" : `&link=${encodeURIComponent(link)}`}`;
}

/** Where a finished connect returns: the page it began on, with the link kept. */
export function thenTarget(then: Then, link?: string): string {
  if (then === "/bring")
    return `/bring?${link === undefined ? "" : `link=${encodeURIComponent(link)}&`}connected=1`;
  return `${then ?? "/settings/origins"}?connected=1`;
}

/**
 * Where the browser goes when the other forge sends it back. A connect begun
 * from `/bring` carries straight on with the bring, as the token path does: the
 * person asked for it, and the state just proved this is their connect. Nobody
 * signed in here (a phone that scanned the code) signs in and comes back to
 * this same callback, its state unspent.
 */
export function callbackLanding(
  ctx: Ctx,
  done: Awaited<ReturnType<typeof completeOAuthCallback>>,
): string {
  if (!done.ok)
    return done.error === "unauthorized"
      ? `/signin?next=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`
      : "/settings/origins?error=state";
  if (done.value.status !== "done")
    return `/settings/origins?error=${encodeURIComponent(done.value.detail.slice(0, 300))}`;
  const back = new URLSearchParams(done.value.returnQuery);
  const then = thenOf(back.get("then"));
  const link = linkOf(back.get("link"));
  if (then === "/bring" && link !== undefined) {
    const started = startBring(ctx.app, ctx.auth.user, link);
    if (started.ok) return `/bring/${started.value.originId}/${started.value.job.id}`;
  }
  return thenTarget(then, link);
}

export async function originOAuthStart(ctx: Ctx): Promise<Response> {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const kind = field(form, "kind");
  const host = field(form, "host").trim();
  const then = thenOf(field(form, "then"));
  const link = linkOf(field(form, "link"));

  if (host === "" && kind !== "github") {
    const values = blankValues();
    values.hostError = "Type the forge's address first, then sign in there.";
    return shell(ctx, originsView(ctx, values), 422);
  }
  const back = callbackUri(ctx);
  // A parent that runs the sign-in needs no address of this forge's own for the provider.
  const brokered = offerFor(await brokerOffers(ctx.app), host || kind) !== undefined;
  if (back === "" && kind !== "github" && !brokered) {
    const values = blankValues();
    values.tokenHost = host;
    values.hostError =
      "This forge does not know its own public URL, so sign-in cannot come back to it. Make a token there and connect with that, or set FORGE_URL (or FORGE_HOST).";
    return shell(ctx, originsView(ctx, values), 422);
  }
  const started = await startOAuthConnect(ctx.app, ctx.auth.user, {
    host: host || kind,
    ...(kind === "github" ? { kind: "github" as const } : {}),
    redirectUri: back,
    returnQuery: thenQuery(then, link),
  });
  if (!started.ok) {
    if (started.error.error === "no_app" && kind !== "github" && started.error.kind !== "github") {
      // The instance is real but has no application yet: that is the
      // registration step, not an error the user did anything about.
      return redirect(
        `/settings/origins?host=${encodeURIComponent(host)}&register=1`,
      );
    }
    const values = blankValues();
    values.host = host;
    values.tokenHost = host;
    values.offerToken = started.error.error === "no_app" || started.error.error === "provider_refused";
    values.hostError =
      started.error.error === "no_app"
        ? "This forge has no GitHub application configured. Paste a token below instead."
        : started.error.error === "provider_refused"
          ? `${hostLabel(host.includes("://") ? host : `https://${host}`)} would not take a sign-in from this forge. Nothing was connected. A token made there works below.`
          : connectMessage(started.error.error);
    return shell(ctx, originsView(ctx, values), 422);
  }
  // A parent's sign-in is one click: the browser goes straight to the parent, which sends it to the provider.
  if (started.value.brokered === true && started.value.flow === "code") return redirect(started.value.url);
  // The flow's page knows where to go from the flow itself, not the link.
  const qs = then === undefined ? "" : `?${thenQuery(then, link)}`;
  return redirect(`/settings/origins/flows/${started.value.flowId}${qs}`);
}

// POST /settings/origins/apps
export async function originAppCreate(ctx: Ctx): Promise<Response> {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const host = field(form, "host").trim();
  const clientId = field(form, "clientId").trim();
  const clientSecret = field(form, "clientSecret").trim();

  if (clientId === "") {
    const values = blankValues();
    values.host = host;
    values.mode = "register";
    values.registerError = "A client id is required.";
    return shell(ctx, originsView(ctx, values), 422);
  }
  const saved = await registerOriginApp(ctx.app, ctx.auth.user, {
    host,
    clientId,
    ...(clientSecret === "" ? {} : { clientSecret }),
  });
  if (!saved.ok) {
    const values = blankValues();
    values.host = host;
    values.clientId = clientId;
    values.mode = "register";
    values.registerError = connectMessage(saved.error);
    return shell(ctx, originsView(ctx, values), 422);
  }
  return flashTo(ctx, `/settings/origins?host=${encodeURIComponent(host)}`, {
    message: "Application registered. Authorize it to finish connecting.",
  });
}

// POST /settings/origins/trusted-hosts
export async function originTrustedHosts(ctx: Ctx): Promise<Response> {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  if (!mayEditTrustedHosts(ctx.auth.user))
    return forbiddenPage(ctx, NOT_ADMIN_HERE);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const text = field(form, "hosts");
  const saved = updateTrustedHosts(ctx.app.db, ctx.auth.user, text);
  if (!saved.ok) {
    if (saved.error === "forbidden")
      return forbiddenPage(ctx, NOT_ADMIN_HERE);
    const values = blankValues();
    values.trustedText = text.slice(0, 4000);
    values.trustedError = rejectedSentence(saved.rejected);
    return shell(ctx, originsView(ctx, values), 422);
  }
  return flashTo(ctx, "/settings/origins", {
    message: "Trusted internal hosts saved.",
  });
}

// POST /settings/origins/apps/:id/delete
export async function originAppDelete(ctx: Ctx): Promise<Response> {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const removed = deleteOriginApp(ctx.app, ctx.auth.user, ctx.params.id ?? "");
  return flashTo(ctx, "/settings/origins", {
    ...(removed.ok
      ? { message: "Application forgotten." }
      : { tone: "danger" as const, message: "No such application." }),
  });
}

export function notFoundNote(): Html {
  return empty({
    icon: "search",
    title: "No such connect",
    note: "It finished, expired, or was never yours. Start again from Connected accounts.",
    action: btn("Back to connected accounts", {
      href: "/settings/origins",
      variant: "primary",
    }),
  });
}
// ---- one origin ----

// POST /settings/origins/:id/check — "Check again": the operator guard, now.
export async function originCheckSubmit(ctx: Ctx): Promise<Response> {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const to = "/settings/origins";
  const checked = await checkOriginAgain(ctx.app, ctx.auth.user, ctx.params.id ?? "");
  if (!checked.ok)
    return flashTo(ctx, to, {
      tone: checked.error === "too_soon" ? "attn" : "danger",
      message:
        checked.error === "too_soon" ? CHECK_TOO_SOON : "No such connection.",
    });
  return flashTo(ctx, to, {
    tone:
      checked.value === "passed" || checked.value === "unguarded"
        ? "success"
        : "danger",
    message: CHECK_WORDS[checked.value],
  });
}

// POST /settings/origins/:id/sync
export async function originSyncSubmit(ctx: Ctx): Promise<Response> {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const synced = await syncOriginNow(
    ctx.app,
    ctx.auth.user,
    ctx.params.id ?? "",
  );
  if (!synced.ok)
    return flashTo(ctx, "/settings/origins", {
      tone: "danger",
      message: NO_SUCH_ORIGIN,
    });
  const report = synced.value;
  return flashTo(ctx, "/settings/origins", {
    ...(report.error === ""
      ? {
          message: syncedWords(report.repos),
        }
      : { tone: "danger" as const, message: report.error }),
  });
}

// POST /settings/origins/:id/delete
export async function originDisconnect(ctx: Ctx): Promise<Response> {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const gone = await disconnectOrigin(
    ctx.app,
    ctx.auth.user,
    ctx.params.id ?? "",
  );
  const back = thenOf(field(form, "then")) ?? "/settings/origins";
  if (!gone.ok)
    return flashTo(ctx, back, {
      tone: "danger",
      message: NO_SUCH_ORIGIN,
    });
  return flashTo(ctx, back, {
    message: disconnectedWords(gone.value.revokedUpstream),
  });
}

// POST /settings/origins/:id/token
/**
 * A new token on an origin already connected: the origin, its mirrors and
 * its pins stay; its repositories are listed again with what it sees.
 */
export async function originReplaceToken(ctx: Ctx): Promise<Response> {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const back = thenOf(field(form, "then")) ?? "/settings/origins";
  const replaced = await replaceOriginToken(
    ctx.app,
    ctx.auth.user,
    ctx.params.id ?? "",
    field(form, "token"),
  );
  if (!replaced.ok)
    return flashTo(ctx, back, {
      tone: "danger",
      message: replaceTokenMessage(replaced.error),
    });
  return flashTo(ctx, back, {
    message: `Token replaced for ${replaced.value.login} at ${hostLabel(replaced.value.webUrl)}; its repositories are listed again.`,
  });
}
