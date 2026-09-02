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
  mirrorRepo,
  pollOAuthConnect,
  registerOriginApp,
  startOAuthConnect,
  syncOriginNow,
} from "../../actions/origins.ts";
import { getFlowFor } from "../../origins/oauth.ts";
import { getOriginFor, type Origin } from "../../core/origins.ts";
import { getRepo, getRepoById } from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { oauthCallbackUri } from "../../http/api.ts";
import {
  settingsLayout,
  signInFirst,
  type SettingsSection,
} from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page, redirect } from "../layout.ts";
import { pollJs } from "../client.ts";
import {
  badge,
  btn,
  card,
  confirmAction,
  empty,
  icon,
  listCard,
  row,
  time,
  field as uiField,
  type IconName,
} from "../ui.ts";

/** The settings sidebar, with Origins on it. Kept here so the account pages
 * and this one cannot drift apart in either direction. */
export function accountSections(
  current: "profile" | "password" | "tokens" | "keys" | "origins",
): SettingsSection[] {
  return [
    {
      label: "Profile",
      href: "/settings",
      icon: "user",
      current: current === "profile",
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
function accountOnly(ctx: Ctx): Response | undefined {
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

function originCard(origin: Origin): Html {
  const base = `/settings/origins/${origin.id}`;
  return card(
    html`<div class="origin-row">
        <span class="origin-mark">${icon(originIcon(origin.kind))}</span>
        <span class="grow">
          <span class="origin-name"
            >${origin.login}<span class="muted"> @ </span>${hostLabel(
              origin.webUrl,
            )}</span
          >
          <span class="row-meta muted small"
            >${origin.authKind === "oauth" ? "OAuth" : "personal access token"}
            ·
            ${origin.lastSyncAt === null
              ? html`never synced`
              : html`synced ${time(origin.lastSyncAt)}`}</span
          >
        </span>
        ${healthBadge(origin)}
      </div>
      ${when(
        origin.lastError !== "",
        () => html`<p class="error-note mt">${origin.lastError}</p>`,
      )}
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
}

const blankValues = (): ConnectValues => ({
  host: "",
  clientId: "",
  mode: "none",
  tokenHost: "",
});

function githubSection(configured: boolean): Html {
  if (!configured) {
    return html`<div class="connect-path">
      <h3>${icon("github")}GitHub</h3>
      <p class="muted small">
        This forge has no GitHub application configured (<span class="mono"
          >FORGE_GITHUB_CLIENT_ID</span
        >), so the one-click device flow is unavailable. Paste a personal access
        token below, or ask the operator to set one.
      </p>
    </div>`;
  }
  return html`<div class="connect-path">
    <h3>${icon("github")}GitHub</h3>
    <p class="muted small">
      A short code and a URL you type it into — from this machine or from your
      phone. Nothing is typed into this terminal or this page.
    </p>
    <form method="post" action="/settings/origins/oauth">
      <input type="hidden" name="kind" value="github" />
      ${btn("Connect GitHub", { variant: "primary", icon: "github" })}
    </form>
  </div>`;
}

function forgejoSection(
  ctx: Ctx,
  values: ConnectValues,
  registered: { webUrl: string; clientId: string; id: string } | undefined,
): Html {
  const back = callbackUri(ctx);
  if (back === "") {
    return html`<div class="connect-path">
      <h3>${icon("forgejo")}Forgejo or Gitea</h3>
      <p class="error-note">
        This forge does not know its own public URL, so it cannot register a
        callback for the code flow. Set
        <span class="mono">FORGE_URL</span> to the base URL people reach it at
        (or <span class="mono">FORGE_HOST</span> to the hostname it is served
        on) and this path lights up. A pasted token works either way.
      </p>
    </div>`;
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
                >${values.host === "" ? "https://your.forge" : values.host}/user/settings/applications</span
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

  return html`<div class="connect-path">
    <h3>${icon("forgejo")}Forgejo or Gitea</h3>
    <p class="muted small">
      Name the instance and this forge works out which it is, then sends you
      there to authorize.
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
    ${authorize} ${registerForm}
  </div>`;
}

function tokenSection(values: ConnectValues): Html {
  return html`<div class="connect-path">
    <h3>${icon("key")}Personal access token</h3>
    <p class="muted small">
      The fallback that needs no application registered anywhere. The token is
      validated against the forge before it is stored, encrypted at rest, and
      never shown again.
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
    </form>
  </div>`;
}

// ---- the page ----

function originsView(ctx: Ctx, values: ConnectValues): Html {
  const user = ctx.auth.user!;
  const origins = listUserOrigins(ctx.app, user);
  const apps = listOriginApps(ctx.app, user);
  const githubConfigured =
    (process.env.FORGE_GITHUB_CLIENT_ID ?? "").trim() !== "" ||
    apps.some((a) => a.kind === "github");
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
      : html`<div class="stack">${origins.map(originCard)}</div>`}
    ${card(
      html`${githubSection(githubConfigured)}
      ${forgejoSection(
        ctx,
        values,
        matched === undefined
          ? undefined
          : {
              webUrl: matched.webUrl,
              clientId: matched.clientId,
              id: matched.id,
            },
      )}
      ${tokenSection(values)}`,
      {
        head: html`${icon("plus")}
          <h2>Connect an origin</h2>`,
      },
    )}`;
}

function shell(ctx: Ctx, body: Html, status = 200): Response {
  return page(
    {
      ctx,
      title: "Origins",
      body: html`<div class="page-head"><h1>Origins</h1></div>
        ${settingsLayout(accountSections("origins"), body, "Account settings")}`,
    },
    status,
  );
}

// GET /settings/origins
export function originsPage(ctx: Ctx): Response {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const params = ctx.url.searchParams;
  const values = blankValues();
  const host = params.get("host") ?? "";
  if (host !== "") {
    values.host = host.slice(0, 200);
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

  return shell(ctx, html`${banner}${originsView(ctx, values)}`);
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
  return flashTo(ctx, "/settings/origins", {
    message: `Connected ${connected.value.login} at ${hostLabel(connected.value.webUrl)}.`,
  });
}

function connectMessage(error: string): string {
  const words: Record<string, string> = {
    unknown_host: "That does not look like a forge this can talk to.",
    unreachable: "That instance could not be reached.",
    bad_token: "That token was refused by the origin.",
    already_connected: "That account is already connected.",
    rate_limited: "Too many connect attempts. Wait a few minutes.",
    unauthorized: "Sign in first.",
  };
  return words[error] ?? "That connection could not be made.";
}

// POST /settings/origins/oauth
export async function originOAuthStart(ctx: Ctx): Promise<Response> {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const kind = field(form, "kind");
  const host = field(form, "host").trim();

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
  const to =
    started.value.flow === "code"
      ? `?to=${encodeURIComponent(started.value.url)}`
      : "";
  return redirect(`/settings/origins/flows/${started.value.flowId}${to}`);
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

  if (flow.status === "done") return redirect("/settings/origins?connected=1");
  if (flow.status === "failed")
    return redirect(
      `/settings/origins?error=${encodeURIComponent(flow.detail.slice(0, 120))}`,
    );

  const pollAction = `/settings/origins/flows/${flow.id}/poll`;
  const authorize =
    flow.flow === "code"
      ? authorizeLink(ctx.url.searchParams.get("to") ?? "", flow.webUrl)
      : undefined;
  const body =
    flow.flow === "device"
      ? html`${card(
          html`<p class="muted small">
              Type this code at
              <a href="${flow.verificationUri}" rel="noreferrer noopener"
                >${flow.verificationUri}</a
              >. Any device with a browser will do — this page waits.
            </p>
            <p class="device-code" id="device-code">${flow.userCode}</p>
            <div class="bar">
              ${btn("Open the verification page", {
                href: flow.verificationUri,
                variant: "primary",
                icon: "external",
              })}
              <button
                class="btn btn-icon"
                data-size="sm"
                type="button"
                data-copy="device-code"
                aria-label="Copy the code"
                title="Copy"
              >
                ${icon("copy")}
              </button>
            </div>`,
          {
            head: html`${icon("github")}
              <h2>Enter this code</h2>`,
          },
        )}`
      : html`${card(
          authorize === undefined
            ? html`<p>
                  This connect cannot be continued from here — the
                  authorization link was lost. Start it again from Origins.
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
                <div class="bar mt">
                  ${btn("Continue to the instance", {
                    href: authorize,
                    variant: "primary",
                    icon: "external",
                  })}
                </div>`,
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
  if (wantsJson) return Response.json({ status, detail });
  if (status === "done") return redirect("/settings/origins?connected=1");
  if (status === "failed")
    return redirect(
      `/settings/origins?error=${encodeURIComponent(detail.slice(0, 120))}`,
    );
  return redirect(`/settings/origins/flows/${ctx.params.id ?? ""}`);
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
  if (!gone.ok)
    return flashTo(ctx, "/settings/origins", {
      tone: "danger",
      message: "No such origin.",
    });
  return flashTo(ctx, "/settings/origins", {
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
                : getRepoById(ctx.app.db, remote.mirroredAs);
            // Only offer a name box when the obvious one is taken: the
            // mirror action picks a free name by itself otherwise.
            const collides =
              mirror === undefined &&
              getRepo(
                ctx.app.db,
                ctx.auth.user!.username,
                remote.fullName.split("/")[1] ?? "",
              ) !== undefined;
            const trail =
              mirror !== undefined
                ? btn("Open mirror", {
                    href: `/${mirror.ownerName}/${mirror.name}`,
                    size: "sm",
                    variant: "outline",
                    icon: "repo",
                  })
                : html`<form
                    class="mirror-form"
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
                        html`<input
                          class="input"
                          name="name"
                          placeholder="local name"
                          aria-label="Local name for ${remote.fullName}"
                          autocomplete="off"
                        />`,
                    )}
                    ${btn("Mirror", { size: "sm", icon: "download" })}
                  </form>`;
            return row({
              lead: icon(originIcon(origin.kind)),
              title: html`${remote.fullName}
              ${remote.private
                ? badge("Private", { icon: "lock", variant: "secondary" })
                : badge("Public", { variant: "outline" })}
              ${when(remote.fork, () =>
                badge("Fork", { icon: "fork", variant: "outline" }),
              )}
              ${when(mirror !== undefined, () =>
                badge("Mirrored", { tone: "success", icon: "check" }),
              )}`,
              titleAttr: remote.fullName,
              meta: html`${remote.description !== ""
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
        Pick the repositories you want here. Each one is mirrored on its own —
        there is no "mirror everything", because a mirror is a repository you
        own and a hundred of them you did not choose is not a feature.
      </p>
      ${filter} ${body}`,
  });
}

// POST /settings/origins/:id/mirror
export async function originMirrorSubmit(ctx: Ctx): Promise<Response> {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const originId = ctx.params.id ?? "";
  const fullName = field(form, "fullName").trim();
  const name = field(form, "name").trim();

  const mirrored = await mirrorRepo(
    ctx.app,
    ctx.auth.user,
    originId,
    fullName,
    name === "" ? undefined : name,
  );
  const back = `/settings/origins/${originId}/repos`;
  if (!mirrored.ok) {
    const words: Record<string, string> = {
      not_found: "That repository is not there any more.",
      invalid_name: "That local name is not allowed.",
      name_taken:
        "You already have a repository by every name this could take — give it one.",
      already_mirrored: "That repository is already mirrored here.",
      git_init_failed: "The mirror could not be created on disk.",
      unreachable: "The origin could not be reached. Nothing was changed.",
      unauthorized: "Sign in first.",
    };
    return flashTo(ctx, back, {
      tone: "danger",
      message:
        words[mirrored.error] ?? "That repository could not be mirrored.",
    });
  }
  return flashTo(ctx, `/${mirrored.value.ownerName}/${mirrored.value.name}`, {
    message: `Mirrored ${fullName}.`,
  });
}
