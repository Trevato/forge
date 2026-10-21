/**
 * Origins on the web: the connected accounts, the three ways to connect one,
 * and the picker that turns a remote repository into a local mirror.
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
 * where it was.
 */

import {
  connectOrigin,
  deleteOriginApp,
  disconnectOrigin,
  listOriginApps,
  listRemoteRepos,
  listUserOrigins,
  pollOAuthConnect,
  registerOriginApp,
  startMirrorJob,
  startOAuthConnect,
  syncOriginNow,
  type Reattachment,
} from "../../actions/origins.ts";
import {
  editableHosts,
  envHosts,
  isTrustedHost,
  mayEditTrustedHosts,
  rejectedSentence,
  updateTrustedHosts,
} from "../../origins/trusted-hosts.ts";
import { reattachMessage } from "./frozen.ts";
import { getFlowFor } from "../../origins/oauth.ts";
import {
  getOriginFor,
  listDetachedMirrors,
  mirrorsByOrigin,
  type Origin,
} from "../../core/origins.ts";
import { pinnedRepoIds } from "../../core/pins.ts";
import { getRepo, getReposByIds } from "../../core/repos.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { forgeBaseUrl, oauthCallbackUri } from "../../http/api.ts";
import { qrEncode, qrSvg } from "../../design/qr.ts";
import {
  settingsLayout,
  signInFirst,
  type SettingsSection,
} from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, raw, when, type Html } from "../html.ts";
import { flashTo, page, redirect } from "../layout.ts";
import { pollJs } from "../client.ts";
import { browseBase, isOwnRepo } from "../scope.ts";
import {
  badge,
  btn,
  card,
  confirmAction,
  empty,
  icon,
  listCard,
  repoCounts,
  row,
  time,
  field as uiField,
  type IconName,
} from "../ui.ts";

export type AccountSection =
  | "profile"
  | "password"
  | "tokens"
  | "keys"
  | "model"
  | "passkeys"
  | "origins"
  | "usage"
  | "spend"
  | "crew"
  | "accounts"
  | "people"
  | "subscriptions"
  | "backups"
  | "secrets"
  | "capacity"
  | "telemetry"
  | "access"
  | "limits"
  | "flags"
  | "cloud";

/**
 * The settings sidebar, with Origins on it. Kept here so the account pages
 * and this one cannot drift apart in either direction. Crew is a forge
 * admin's section — an agent is an account that acts — so it is on the nav
 * only for one, the way the repo header hides Settings from a non-admin.
 */
const USAGE: ReadonlySet<AccountSection> = new Set(["usage", "spend", "capacity", "telemetry"]);

export function accountSections(
  current: AccountSection,
  o: { admin?: boolean } = {},
): SettingsSection[] {
  return [
    ...(o.admin
      ? [
          {
            label: "Accounts",
            href: "/settings/accounts",
            icon: "users" as const,
            current: current === "accounts",
          },
          {
            label: "People",
            href: "/settings/people",
            icon: "users" as const,
            current: current === "people",
          },
          {
            label: "Crew",
            href: "/settings/crew",
            icon: "bot" as const,
            current: current === "crew",
          },
          {
            label: "Subscriptions",
            href: "/settings/subscriptions",
            icon: "key" as const,
            current: current === "subscriptions",
          },
          {
            label: "Secrets",
            href: "/settings/secrets",
            icon: "lock" as const,
            current: current === "secrets",
          },
          {
            label: "Cloud accounts",
            href: "/settings/cloud",
            icon: "key" as const,
            current: current === "cloud",
          },
          {
            label: "Access",
            href: "/settings/access",
            icon: "activity" as const,
            current: current === "access",
          },
          {
            label: "Limits",
            href: "/admin/limits",
            icon: "activity" as const,
            current: current === "limits",
          },
          {
            label: "Flags",
            href: "/settings/flags",
            icon: "activity" as const,
            current: current === "flags",
          },
          {
            label: "Usage",
            href: "/settings/spend",
            icon: "activity" as const,
            current: USAGE.has(current),
          },
          {
            label: "Backups",
            href: "/settings/backups",
            icon: "download" as const,
            current: current === "backups",
          },
        ]
      : []),
    {
      label: "Profile",
      href: "/settings",
      icon: "user",
      current: current === "profile",
    },
    {
      label: "Model",
      href: "/settings/model",
      icon: "key",
      current: current === "model",
    },
    {
      label: "Password",
      href: "/settings/password",
      icon: "lock",
      current: current === "password",
    },
    {
      label: "Access tokens",
      href: "/settings/tokens",
      icon: "key",
      current: current === "tokens",
    },
    {
      label: "SSH keys",
      href: "/settings/keys",
      icon: "lock",
      current: current === "keys",
    },
    {
      label: "Passkeys",
      href: "/settings/passkeys",
      icon: "key",
      current: current === "passkeys",
    },
    {
      label: "Origins",
      href: "/settings/origins",
      icon: "globe",
      current: current === "origins",
    },
  ];
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
  return new Response("forbidden", { status: 403 });
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

function originCard(origin: Origin, mirrors: number): Html {
  const base = `/settings/origins/${origin.id}`;
  return card(
    html`<ul class="list setting-list">
        ${row({
          lead: icon(originIcon(origin.kind)),
          title: html`${origin.login}<span class="muted"> @ </span>${hostLabel(
              origin.webUrl,
            )}`,
          meta: html`${origin.authKind === "oauth"
              ? "OAuth"
              : "personal access token"}
            ·
            ${origin.lastSyncAt === null
              ? html`never synced`
              : html`synced ${time(origin.lastSyncAt)}`}
            ${when(
              isTrustedHost(URL.parse(origin.webUrl)?.hostname ?? ""),
              () => html` · trusted internal host`,
            )}`,
          trail: healthBadge(origin),
        })}
      </ul>
      ${when(
        origin.lastError !== "",
        () => html`<p class="error-note mt">${origin.lastError}</p>`,
      )}
      ${when(origin.needsReauth, () => reauthNote(origin, mirrors))}
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
        <span class="spacer"></span>
        ${confirmAction({
          action: `${base}/delete`,
          verb: "Disconnect",
          size: "sm",
        })}
      </div>`,
  );
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
      <ol class="steps small">
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
      ${btn("Connect GitHub", { variant: "primary", icon: "github" })}
    </form>`;
}

function forgejoSection(
  ctx: Ctx,
  values: ConnectValues,
  registered: { webUrl: string; clientId: string; id: string } | undefined,
): Html {
  const back = callbackUri(ctx);
  if (back === "") {
    return html`<p class="error-note">
        This forge does not know its own public URL, so it cannot register a
        callback for the code flow. Set
        <span class="mono">FORGE_URL</span> to the base URL people reach it at
        (or <span class="mono">FORGE_HOST</span> to the hostname it is served
        on) and this path lights up. A pasted token works either way.
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
              ${btn("Authorize", { variant: "primary", icon: "external" })}
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
          <ol class="steps small">
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
              <span class="clone"
                ><span class="clone-text" id="redirect-uri">${back}</span>
                <button
                  class="btn btn-icon"
                  data-size="sm"
                  type="button"
                  data-copy="redirect-uri"
                  aria-label="Copy the redirect URI"
                  title="Copy"
                >
                  ${icon("copy")}
                </button></span
              >
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
              ${btn("Register application", { variant: "primary" })}
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
        ...(values.hostError ? { error: values.hostError } : {}),
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
        hint: "Needs repository and issue access. It is never displayed after this.",
      })}
      <div class="form-actions">${btn("Connect", { variant: "primary" })}</div>
    </form>`;
}

/** The admin's list of hosts an origin may reach inside the network. */
function trustedHostsCard(text: string, error?: string): Html {
  const fixed = envHosts();
  return card(
    html`<h3>${icon("lock")}Trusted internal hosts</h3>
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
      </form>`,
  );
}

// ---- the page ----

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
      ? empty({
          icon: "globe",
          title: "No origins connected",
          note: "Connect GitHub, a Forgejo instance or a Gitea instance and its repositories become mirrorable here.",
        })
      : html`<div class="stack">
          ${origins.map((o) => originCard(o, mirrors.get(o.id)?.count ?? 0))}
        </div>`}
    ${frozenCard(frozen)}
    ${mayEditTrustedHosts(user)
      ? trustedHostsCard(
          values.trustedText ?? editableHosts().join("\n"),
          values.trustedError,
        )
      : null}
    ${card(
      html`<ul class="list">
        ${connectPath(
          "connect-token",
          "key",
          html`Personal access token
            ${badge("recommended", { tone: "success" })}`,
          true,
          tokenSection(values),
        )}
        ${connectPath(
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
      </ul>`,
      {
        id: "connect",
        pad: false,
        head: html`${icon("plus")}
          <h2>Connect an origin</h2>`,
        foot: html`<span class="muted small"
          ><strong>One-click sign-in.</strong> Both of these are OAuth, and both
          need somebody to register an application once — for GitHub, per forge; for Forgejo and Gitea,
          per instance. Worth it if several people use this forge; a token is
          faster if it is just you.</span
        >`,
      },
    )}`;
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
  return listCard(
    frozen.flatMap((m) => {
      const repo = repos.get(m.repoId);
      if (repo === undefined) return [];
      const host = hostLabel(m.htmlUrl);
      return [
        row({
          href: `/${repo.ownerName}/${repo.name}#frozen`,
          lead: icon("repo"),
          title: `${repo.ownerName}/${repo.name}`,
          meta: html`mirrors <span class="mono">${m.fullName}</span>${host ===
            ""
              ? null
              : html` at ${host}`}`,
        }),
      ];
    }),
    {
      head: html`${icon("alert")}
        <h2>Frozen mirrors</h2>
        <span class="spacer"></span>
        <span class="muted small"
          >Connect an account where they came from to bring them back.</span
        >`,
    },
  );
}

function shell(ctx: Ctx, body: Html, status = 200): Response {
  return page(
    {
      ctx,
      title: "Origins",
      body: html`<div class="page-head"><h1>Origins</h1></div>
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
export function originsPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const denied = accountOnly(ctx);
  if (denied) return denied;
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
              : error.slice(0, 200)}
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
  });
  if (!connected.ok) {
    // The host comes back; the token deliberately does not. Re-typing a
    // secret is a smaller cost than a secret sitting in a value attribute.
    const values = blankValues();
    values.tokenHost = host;
    values.tokenError = connectMessage(connected.error);
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

function connectMessage(error: string): string {
  const words: Record<string, string> = {
    unknown_host: "That does not look like a forge this can talk to.",
    private_host: "That address is inside a network, not on the internet.",
    unreachable: "That instance could not be reached.",
    bad_token: "That token was refused by the origin.",
    already_connected: "That account is already connected.",
    rate_limited: "Too many connect attempts. Wait a few minutes.",
    unauthorized: "Sign in first.",
  };
  return words[error] ?? "That connection could not be made.";
}

// POST /settings/origins/oauth
/**
 * Where a connect or a disconnect started, when it was not here: only
 * `/migrate`, named by a fixed word — never a path a form can choose.
 */
type Then = "/migrate" | undefined;
const thenOf = (value: string | null): Then =>
  value === "migrate" ? "/migrate" : undefined;
const thenQuery = (then: Then): string =>
  then === undefined ? "" : "then=migrate";

export async function originOAuthStart(ctx: Ctx): Promise<Response> {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const kind = field(form, "kind");
  const host = field(form, "host").trim();
  const then = thenOf(field(form, "then"));

  const back = callbackUri(ctx);
  if (back === "" && kind !== "github") {
    const values = blankValues();
    values.host = host;
    values.mode = "host";
    values.hostError =
      "This forge does not know its own public URL. Set FORGE_URL (or FORGE_HOST) and try again — or paste a token instead.";
    return shell(ctx, originsView(ctx, values), 422);
  }
  const started = await startOAuthConnect(ctx.app, ctx.auth.user, {
    host: host || kind,
    ...(kind === "github" ? { kind: "github" as const } : {}),
    redirectUri: back,
  });
  if (!started.ok) {
    if (started.error.error === "no_app" && kind !== "github") {
      // The instance is real but has no application yet: that is the
      // registration step, not an error the user did anything about.
      return redirect(
        `/settings/origins?host=${encodeURIComponent(host)}&register=1`,
      );
    }
    const values = blankValues();
    values.host = host;
    values.mode = "host";
    values.hostError =
      started.error.error === "no_app"
        ? "This forge has no GitHub application configured. Paste a token instead."
        : connectMessage(started.error.error);
    return shell(ctx, originsView(ctx, values), 422);
  }
  const query = new URLSearchParams(
    started.value.flow === "code" ? { to: started.value.url } : {},
  );
  if (then !== undefined) query.set("then", "migrate");
  const qs = query.size === 0 ? "" : `?${query}`;
  return redirect(`/settings/origins/flows/${started.value.flowId}${qs}`);
}

/**
 * The authorize URL for a code flow, checked before it becomes a link.
 *
 * It arrives on the query string because the flow row stores a *device*
 * flow's verification URI and nothing for a code flow. A crafted link could
 * therefore reach this page, so the URL is accepted only when it points at
 * the same instance the flow already names and carries a PKCE challenge —
 * the worst a forged one can do is send you to another page on the forge you
 * asked to connect.
 */
function authorizeLink(raw: string, webUrl: string): string | undefined {
  const url = URL.parse(raw);
  const instance = URL.parse(webUrl);
  if (!url || !instance) return undefined;
  if (url.origin !== instance.origin) return undefined;
  if (url.searchParams.get("code_challenge") === null) return undefined;
  return url.toString();
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
    return new Response("forbidden", { status: 403 });
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const text = field(form, "hosts");
  const saved = updateTrustedHosts(ctx.app.db, ctx.auth.user, text);
  if (!saved.ok) {
    if (saved.error === "forbidden")
      return new Response("forbidden", { status: 403 });
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

// ---- one connect in flight ----

/**
 * GET /settings/origins/flows/:id — a connect in progress.
 *
 * The device grant shows the code and where to type it; the code flow shows
 * one link to the instance. Both work with no JavaScript: the page carries a
 * "check again" form, and reloading it re-polls. With script, the same form
 * is submitted for you every couple of seconds.
 */
export function originFlowPage(ctx: Ctx): Response {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const flow = getFlowFor(ctx.app.db, ctx.auth.user!.id, ctx.params.id ?? "");
  if (!flow) return shell(ctx, notFoundNote(), 404);
  const then = thenOf(ctx.url.searchParams.get("then"));

  if (flow.status === "done")
    return redirect(`${then ?? "/settings/origins"}?connected=1`);
  if (flow.status === "failed")
    return redirect(
      `/settings/origins?error=${encodeURIComponent(flow.detail.slice(0, 120))}`,
    );

  const pollAction = `/settings/origins/flows/${flow.id}/poll${then === undefined ? "" : `?${thenQuery(then)}`}`;
  const authorize =
    flow.flow === "code"
      ? authorizeLink(ctx.url.searchParams.get("to") ?? "", flow.webUrl)
      : undefined;
  const base = forgeBaseUrl(ctx.url, ctx.app.config.host);
  const shortLink =
    base === "" || flow.shortCode === "" ? "" : `${base}/go/${flow.shortCode}`;
  const body =
    flow.flow === "device"
      ? html`${card(
          html`<p class="muted small">
              Type this code at
              <a href="${flow.verificationUri}" rel="noreferrer noopener"
                >${flow.verificationUri}</a
              >. Any device with a browser will do — this page waits.
            </p>
            <div class="bar">
              <p class="device-code" id="device-code">${flow.userCode}</p>
              ${copyBtn("device-code", "Copy the code")}
            </div>
            ${handoff(flow.verificationUri, shortLink)}`,
          {
            head: html`${icon("github")}
              <h2>Enter this code</h2>`,
          },
        )}`
      : html`${card(
          authorize === undefined
            ? html`<p>
                  This connect cannot be continued from here — the authorization
                  link was lost. Start it again from Origins.
                </p>
                <div class="bar mt">
                  ${btn("Back to origins", {
                    href: "/settings/origins",
                    variant: "primary",
                  })}
                </div>`
            : html`<p>
                  Continue to
                  <span class="mono">${hostLabel(flow.webUrl)}</span> and
                  approve the application. You will come straight back here.
                </p>
                ${handoff(authorize, shortLink, "Continue to the instance")}`,
          {
            head: html`${icon("forgejo")}
              <h2>Authorize on the instance</h2>`,
          },
        )}`;

  const waiting = html`<form
    class="bar mt"
    method="post"
    action="${pollAction}"
    data-poll="${flow.flow === "device"
      ? String(Math.max(1, flow.intervalSecs))
      : "0"}"
  >
    <span class="muted small"
      >Waiting for you to authorize
      ${flow.flow === "device"
        ? "on the other device"
        : "on the instance"}…</span
    >
    <span class="spacer"></span>
    ${btn("Check again", { size: "sm", variant: "outline", icon: "sync" })}
    ${btn("Cancel", {
      href: "/settings/origins",
      size: "sm",
      variant: "ghost",
    })}
  </form>`;

  return page({
    ctx,
    title: "Connecting an origin",
    body: html`<div class="page-head"><h1>Connecting an origin</h1></div>
      <div class="narrow-wide">
        ${body}${waiting}
        <p class="muted small mt">
          No JavaScript? Refresh this page to check again — the reload re-polls.
        </p>
      </div>`,
    scriptJs: pollJs,
  });
}

/** The copy affordance: an icon button that is inert without a script, and
 * sits beside text that stays selectable either way. */
function copyBtn(target: string, label: string): Html {
  return html`<button
    class="btn btn-icon js-only"
    data-size="sm"
    type="button"
    data-copy="${target}"
    aria-label="${label}"
    title="Copy"
  >
    ${icon("copy")}
  </button>`;
}

/**
 * Getting the person to the other device: a QR code they point a camera at,
 * the short link they could type instead, the full URL for a browser that is
 * already here, and one button that opens it.
 *
 * The QR carries the short link when the forge knows its own address and the
 * long URL otherwise — the shorter the payload, the coarser the modules and
 * the further away a phone can read it.
 */
function handoff(url: string, shortLink: string, openLabel?: string): Html {
  const payload = shortLink === "" ? url : shortLink;
  const code = qrEncode(payload);
  return html`<div class="bar mt">
      ${code.ok
        ? raw(
            qrSvg(code.value, {
              title: "Scan to open the link",
              scale: qrScale(code.value.modules.length),
            }),
          )
        : null}
    </div>
    <ul class="list setting-list mt">
      ${shortLink === ""
        ? null
        : row({
            title: "Or open this on a phone:",
            meta: html`<span class="mono" id="flow-short">${shortLink}</span>`,
            trail: copyBtn("flow-short", "Copy the short link"),
          })}
      ${row({
        title: "The full link:",
        meta: html`<span class="mono small" id="flow-url">${url}</span>`,
        trail: copyBtn("flow-url", "Copy the link"),
      })}
    </ul>
    <div class="bar mt">
      ${btn(openLabel ?? "Open the verification page", {
        href: url,
        variant: "primary",
        icon: "external",
        external: true,
      })}
    </div>`;
}

/**
 * The module size that keeps the code at most 200 px square: the encoder sizes
 * the SVG from it, so a long URL (more modules) must not make a code wider
 * than a 360 px phone can hold beside the page's padding.
 */
function qrScale(modules: number): number {
  return Math.max(1, Math.min(4, Math.floor(200 / modules)));
}

function notFoundNote(): Html {
  return empty({
    icon: "search",
    title: "No such connect",
    note: "It finished, expired, or was never yours. Start again from Origins.",
    action: btn("Back to origins", {
      href: "/settings/origins",
      variant: "primary",
    }),
  });
}

/**
 * POST /settings/origins/flows/:id/poll — ask the origin once, on the user's
 * behalf. The forge does the polling, so a browser (or a phone) only ever
 * asks "has it happened yet?" and a token never crosses back to a surface.
 *
 * Answers JSON to a client that asked for it and a redirect to everyone
 * else, so the same route serves the enhancement and the plain form.
 */
export async function originFlowPoll(ctx: Ctx): Promise<Response> {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const polled = await pollOAuthConnect(
    ctx.app,
    ctx.auth.user,
    ctx.params.id ?? "",
  );
  const wantsJson = (ctx.request.headers.get("accept") ?? "").includes(
    "application/json",
  );
  if (!polled.ok) {
    return wantsJson
      ? Response.json(
          { status: "failed", detail: "not found" },
          { status: 404 },
        )
      : redirect("/settings/origins?error=state");
  }
  const { status, detail } = polled.value;
  const then = thenOf(ctx.url.searchParams.get("then"));
  if (wantsJson) return Response.json({ status, detail });
  if (status === "done")
    return redirect(`${then ?? "/settings/origins"}?connected=1`);
  if (status === "failed")
    return redirect(
      `/settings/origins?error=${encodeURIComponent(detail.slice(0, 120))}`,
    );
  return redirect(
    `/settings/origins/flows/${ctx.params.id ?? ""}${then === undefined ? "" : `?${thenQuery(then)}`}`,
  );
}

// ---- one origin ----

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
      message: "No such origin.",
    });
  const report = synced.value;
  return flashTo(ctx, "/settings/origins", {
    ...(report.error === ""
      ? {
          message: `Synced ${report.repos} repositor${report.repos === 1 ? "y" : "ies"}.`,
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
      message: "No such origin.",
    });
  return flashTo(ctx, back, {
    message: gone.value.revokedUpstream
      ? "Disconnected, and the grant was revoked upstream."
      : "Disconnected. Revoke the token on the origin too if you want it dead there.",
  });
}

// ---- the picker ----

// GET /settings/origins/:id/repos
export async function originReposPage(ctx: Ctx): Promise<Response> {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const origin = getOriginFor(
    ctx.app.db,
    ctx.auth.user!.id,
    ctx.params.id ?? "",
  );
  if (!origin) return shell(ctx, notFoundNote(), 404);
  const refresh = ctx.url.searchParams.get("refresh") === "1";
  const query = (ctx.url.searchParams.get("q") ?? "").trim();

  const listed = await listRemoteRepos(
    ctx.app,
    ctx.auth.user,
    origin.id,
    refresh,
  );
  const base = `/settings/origins/${origin.id}/repos`;
  const rows = listed.ok
    ? listed.value.filter(
        (r) =>
          query === "" ||
          `${r.fullName} ${r.description}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      )
    : [];

  const filter = html`<form class="filters" method="get" action="${base}">
    <input
      class="input search"
      type="search"
      name="q"
      value="${query}"
      placeholder="Filter repositories"
      aria-label="Filter repositories"
    />
    <button class="btn" data-size="sm" type="submit">Filter</button>
    ${btn("Refresh from origin", {
      href: `${base}?refresh=1${query === "" ? "" : `&q=${encodeURIComponent(query)}`}`,
      size: "sm",
      variant: "outline",
      icon: "sync",
    })}
  </form>`;

  // Two grouped reads for the whole picker: the mirrors these rows already
  // point at, and which of those are pinned. A page of fifty remotes was a
  // hundred single-row queries.
  const mirrors = getReposByIds(
    ctx.app.db,
    rows.map((r) => r.mirroredAs ?? "").filter(Boolean),
  );
  const pins =
    ctx.auth.user === undefined
      ? new Set<string>()
      : pinnedRepoIds(ctx.app.db, ctx.auth.user.id);

  const body = !listed.ok
    ? empty({
        icon: "alert",
        title: "The origin could not be reached",
        note: "Nothing was changed. Try again, or reconnect the origin if it needs re-authorizing.",
        action: btn("Back to origins", {
          href: "/settings/origins",
          variant: "primary",
        }),
      })
    : rows.length === 0
      ? empty({
          icon: "repo",
          title: query === "" ? "No repositories" : "No matches",
          note:
            query === ""
              ? "This account has nothing this token can see."
              : "Nothing on this origin matches that filter.",
        })
      : listCard(
          rows.map((remote) => {
            const mirror =
              remote.mirroredAs === null
                ? undefined
                : mirrors.get(remote.mirroredAs);
            const pinned = mirror !== undefined && pins.has(mirror.id);
            // Only offer a name box when the obvious one is taken: the
            // mirror action picks a free name by itself otherwise.
            const collides =
              mirror === undefined &&
              getRepo(
                ctx.app.db,
                ctx.auth.user!.username,
                remote.fullName.split("/")[1] ?? "",
              ) !== undefined;
            // Mirroring is no longer what enter does — the row opens the
            // repository live, and this is the secondary verb beside it.
            const counted = repoCounts({
              openIssues: remote.openIssues,
              openPulls: remote.openPulls,
              issuesIncludePulls: remote.openIssuesIncludingPulls,
            });
            // Fork is the row's other verb: grabbing a repository you cannot
            // push to is a different intention from keeping a copy of one,
            // and making people open the repository first to find it out is
            // a step in the way of the workflow this picker exists for.
            const forkable =
              !remote.canPush && !isOwnRepo(origin.login, remote.fullName);
            const forkForm = when(
              forkable,
              () =>
                html`<form
                  class="bar"
                  method="post"
                  action="${browseBase(origin.id, remote.fullName)}/fork"
                >
                  ${btn("Fork", {
                    size: "sm",
                    variant: "ghost",
                    icon: "fork",
                    title: `Fork ${remote.fullName} into your account at ${hostLabel(origin.webUrl)}`,
                  })}
                </form>`,
            );
            const trail =
              mirror !== undefined
                ? html`${counted}${forkForm}${btn("Open mirror", {
                    href: `/${mirror.ownerName}/${mirror.name}`,
                    size: "sm",
                    variant: "outline",
                    icon: "repo",
                  })}`
                : html`${counted}${forkForm}
                    <form
                      class="bar"
                      method="post"
                      action="/settings/origins/${origin.id}/mirror"
                    >
                      <input
                        type="hidden"
                        name="fullName"
                        value="${remote.fullName}"
                      />
                      ${when(
                        collides,
                        () =>
                          uiField({
                            label: "Local name",
                            name: "name",
                            id: `mirror-name-${remote.fullName}`,
                            placeholder: "local name",
                            autocomplete: "off",
                            spellcheck: false,
                          }),
                      )}
                      ${btn("Mirror", {
                        size: "sm",
                        variant: "outline",
                        icon: "download",
                      })}
                    </form>`;
            return row({
              nav: true,
              lead: icon(originIcon(origin.kind)),
              // The row is not itself an anchor: it carries a form, and a
              // form inside an <a> is markup the parser pulls apart. The
              // title is the link, and `data-nav` opens it.
              title: html`<a href="${browseBase(origin.id, remote.fullName)}"
                  >${remote.fullName}</a
                >
                ${remote.private
                  ? badge("Private", { icon: "lock", variant: "secondary" })
                  : badge("Public", { variant: "outline" })}
                ${when(remote.fork, () =>
                  badge("Fork", { icon: "fork", variant: "outline" }),
                )}`,
              titleAttr: remote.fullName,
              meta: html`${when(
                mirror,
                (m) =>
                  html`<span class="where-place" data-state="present"
                      ><span aria-hidden="true">●</span
                      >mirrored as
                      <a href="/${m.ownerName}/${m.name}"
                        >${m.ownerName}/${m.name}</a
                      ></span
                    >${when(
                      pinned,
                      () =>
                        html`<span class="where-sep" aria-hidden="true">·</span
                          ><span
                            class="where-place"
                            data-state="present"
                            title="Kept on your machine"
                            ><span aria-hidden="true">◆</span
                            >this machine</span
                          >`,
                    )}
                    · `,
              )}${remote.description !== ""
                ? html`${remote.description} · `
                : null}${remote.pushedAt === null
                ? html`never pushed`
                : html`pushed ${time(remote.pushedAt)}`}`,
              trail,
            });
          }),
        );

  return page({
    ctx,
    title: `${origin.login} @ ${hostLabel(origin.webUrl)}`,
    body: html`<div class="page-head">
        <h1>${origin.login} @ ${hostLabel(origin.webUrl)}</h1>
        <span class="spacer"></span>
        ${btn("Origins", {
          href: "/settings/origins",
          size: "sm",
          variant: "ghost",
        })}
      </div>
      <p class="muted small mb">
        Open any of these to read it live, right now — nothing is downloaded.
        Mirror the ones you actually want: each on its own, because a mirror is
        a repository you own and a hundred of them you did not choose is not a
        feature.
      </p>
      ${filter} ${body}`,
  });
}

/**
 * POST /settings/origins/:id/mirror — start the mirror, then get out of the
 * way.
 *
 * This used to run the whole import inside the request: a clone, a hook
 * install, and every label, issue, pull and comment, with a spinner-free
 * browser holding the connection open for as long as it took. It starts a
 * job now and redirects to the page that watches it, which is the same answer
 * the live-browse Mirror button gives.
 */
export async function originMirrorSubmit(ctx: Ctx): Promise<Response> {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const originId = ctx.params.id ?? "";
  const fullName = field(form, "fullName").trim();
  const name = field(form, "name").trim();

  const started = startMirrorJob(
    ctx.app,
    ctx.auth.user,
    originId,
    fullName,
    name === "" ? undefined : name,
  );
  if (!started.ok)
    return flashTo(ctx, `/settings/origins/${originId}/repos`, {
      tone: "danger",
      message:
        started.error === "unauthorized"
          ? "Sign in first."
          : "That repository could not be mirrored.",
    });
  return redirect(`/settings/origins/${originId}/mirror/${started.value.id}`);
}
