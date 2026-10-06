/**
 * The site pages: the home's dispatch and the cards its rail borrows, sign in
 * and sign up, creating a repository, search, and the confirmation step every
 * destructive action passes through. Plain forms, zero JavaScript required,
 * fast everywhere — a phone in the redwoods is the reference device.
 *
 * Every failure re-renders the form the person was filling in, with what they
 * typed still in it. A dead end that loses input is a bug, not a message.
 */

import { signOutHere } from "../../actions/signins.ts";
import { clientAddress } from "../../http/peer.ts";
import { verifyEmail } from "../../actions/verify.ts";
import { STRANGER_MAX } from "../../http/limits.ts";
import { createRepo } from "../../actions/repos.ts";
import { signUp } from "../../actions/users.ts";
import { listAssignedTo, type Issue } from "../../core/issues.ts";
import { accessAllows, listOrgsForUser, orgAccess } from "../../core/orgs.ts";
import { listPins } from "../../core/pins.ts";
import {
  canRead,
  getReposByIds,
  listReposVisibleTo,
  type Repo,
} from "../../core/repos.ts";
import { createSession } from "../../core/sessions.ts";
import { hasAnyUser, verifyPassword, type User } from "../../core/users.ts";
import { isThemeName } from "../../design/themes.ts";
import { cookieValue, crossOrigin, type Ctx } from "../../http/context.ts";
import { studioDoor, studioHome } from "../studio/home.ts";
import { homeTop } from "../studio/asks_page.ts";
import { edgeLoginUrl } from "../../http/edge.ts";
import { sshCommand } from "../../ssh/command.ts";
import { hostOf, pageHead, signInFirst } from "../chrome.ts";
import { RateLimiter } from "../../core/ratelimit.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { icon } from "../icons.ts";
import { flashTo, page, redirect } from "../layout.ts";
import {
  btn,
  card,
  field as formField,
  iconBtn,
  listCard,
  row,
  selectField,
  time,
} from "../ui.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hasAdmin } from "../../spawn/claim.ts";

export function sessionCookie(value: string, expires: Date, url: URL): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `forge_session=${value}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure}`;
}

/**
 * A `?next=` destination is a path on this forge or nothing at all. A
 * protocol-relative `//evil.example` is a redirect off-site wearing a path's
 * clothes, so it is refused with everything else that isn't a plain path.
 */
function safeNext(raw: string | null): string | undefined {
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
                    ><span class="where-dot" aria-hidden="true">●</span
                    >${hostOf(o.htmlUrl) || o.fullName}</span
                  ><span class="where-sep" aria-hidden="true">·</span>`,
            )}
            <span class="where-place" data-state="present"
              ><span class="where-dot" aria-hidden="true">●</span
              >workbench</span
            ><span class="where-sep" aria-hidden="true">·</span
            ><span class="where-place" data-state="present"
              ><span class="where-dot" aria-hidden="true">◆</span>this
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
            <span class="clone"
              ><span class="clone-text" id="forge-sync">forge sync</span>
              ${iconBtn("copy", "Copy the sync command", {
                size: "sm",
                type: "button",
                copy: "forge-sync",
              })}</span
            >
            <span class="row-meta"
              >Clones what is missing, fetches the rest, and reports
              ahead/behind/dirty. See "Origins" in the README.</span
            >
          </span>
        </div>
      </li>`,
    ],
    { head },
  );
}

const threadPath = (repo: Repo, issue: Issue): string =>
  `/${repo.ownerName}/${repo.name}/${issue.kind === "pull" ? "pulls" : "issues"}/${issue.number}`;

/** Open issues and pulls assigned to the viewer, anywhere they can see. */
export function onYouCard(ctx: Ctx, user: User): Html | undefined {
  const db = ctx.app.db;
  const assigned = listAssignedTo(db, user.id, 20);
  if (assigned.length === 0) return undefined;
  const repos = getReposByIds(
    db,
    assigned.map((issue) => issue.repoId),
  );
  // `listAssignedTo` has no visibility filter of its own (an assignment can
  // outlive the access that made it), so each repo needs a real `canRead`.
  // Checking it straight would cost one query per row for any repo the
  // viewer does not own outright — `canRead` resolves org ownership from
  // the database. `listReposVisibleTo` answers the common case with one
  // query for the whole page; `canRead` only runs for the rare repo it
  // did not reach (its own cap), so the cost stays flat as rows grow.
  const visible = new Set(
    listReposVisibleTo(db, user, { limit: 200 }).map((repo) => repo.id),
  );
  const rows: Html[] = [];
  for (const issue of assigned) {
    const repo = repos.get(issue.repoId);
    if (!repo) continue;
    if (!visible.has(repo.id) && !canRead(db, repo, user)) continue;
    rows.push(
      row({
        href: threadPath(repo, issue),
        nav: true,
        state: "open",
        lead: icon(issue.kind === "pull" ? "pull" : "issue"),
        title: issue.title,
        titleAttr: issue.title,
        meta: html`${repo.ownerName}/${repo.name} #${issue.number} · updated
        ${time(issue.updatedAt)}`,
      }),
    );
  }
  if (rows.length === 0) return undefined;
  return listCard(rows, {
    head: html`${icon("user")}
      <h2>On you</h2>`,
  });
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
  return card(
    html`<div class="terminal-line">
        <code class="mono">${ssh}</code>
        <a class="small" href="/settings/keys">SSH keys</a>
      </div>
      ${when(
        ctx.app.config.sshHostKey,
        (fp) => html`<p class="muted small mt">host key ${fp}</p>`,
      )}`,
    { head: html`<h2>Terminal</h2>` },
  );
}

// GET / — the one home: a stranger gets the door, and a signed-in person
// the feed (`studioHome`, #599), whatever the mode (#625).
export async function home(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (user === undefined) return studioDoor(ctx);
  return await studioHome(ctx, user, homeTop(ctx));
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
}

function authForm(
  ctx: Ctx,
  kind: "signin" | "signup",
  o: { values?: AuthValues; errors?: AuthErrors } = {},
): Html {
  const values = o.values ?? {};
  const errors = o.errors ?? {};
  const next = safeNext(ctx.url.searchParams.get("next"));
  const action = next
    ? `/${kind}?next=${encodeURIComponent(next)}`
    : `/${kind}`;
  // "Is this the first account?" is a `LIMIT 1` existence check, not a count
  // of the whole user table — and the sign-in screen paints on every session.
  const firstAccount = kind === "signup" && !hasAnyUser(ctx.app.db);

  // Behind a platform edge, that is the door: the button first, and the
  // password form kept for the accounts that have one — an account the edge
  // made has none, and the note says so before anyone types.
  const edge =
    ctx.app.config.edgeToken === undefined
      ? undefined
      : (ctx.app.config.edgeName ?? "the platform");
  const throughEdge = when(
    edge,
    (name) =>
      html`<div class="stack mb">
        ${btn(`Continue with ${name}`, {
          href: edgeLoginUrl(next ?? "/"),
          variant: "primary",
          size: "lg",
        })}
        <p class="muted small">
          ${kind === "signin"
            ? `Accounts made through ${name} sign in there and have no password here. The form below is for an account that was given one.`
            : `Signing in through ${name} makes your account on first sight; the form below makes one with a password instead.`}
        </p>
      </div>`,
  );

  const body = html`${throughEdge}
    <form method="post" action="${action}">
      ${formField({
        label: "Username",
        name: "username",
        value: values.username ?? "",
        autocomplete: "username",
        required: true,
        autofocus: true,
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
          required: true,
          ...(errors.email ? { error: errors.email } : {}),
        }),
      )}
      ${formField({
        label: "Password",
        name: "password",
        type: "password",
        autocomplete: kind === "signin" ? "current-password" : "new-password",
        required: true,
        ...(kind === "signup"
          ? { minlength: 10, hint: "At least 10 characters." }
          : {}),
        ...(errors.password ? { error: errors.password } : {}),
      })}
      ${when(
        firstAccount,
        () =>
          html`<p class="muted small mb">
            This forge has no accounts yet — the first account becomes the site
            admin.
          </p>`,
      )}
      <div class="form-actions">
        ${btn(kind === "signin" ? "Sign in" : "Create account", {
          variant: "primary",
        })}
        <span class="spacer"></span>
        ${kind === "signin"
          ? btn("Need an account? Sign up", {
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
  const claimable =
    existsSync(join(ctx.app.config.dataDir, "parent.json")) && !hasAdmin(ctx.app.db);
  return html`<div class="narrow">
    ${pageHead(kind === "signin" ? "Sign in" : "Create your account")}
    ${card(body)}
    ${claimable
      ? html`<p class="muted small mt" id="claim-door">
          Was this forge made for you? <a href="/claim">Claim it with your code</a>.
        </p>`
      : null}
  </div>`;
}

export function signinPage(ctx: Ctx): Response {
  return page({ ctx, title: "Sign in", body: authForm(ctx, "signin") });
}

export function signupPage(ctx: Ctx): Response {
  return page({ ctx, title: "Sign up", body: authForm(ctx, "signup") });
}

/**
 * Sign-in attempts, throttled. The token limiter does not see a password
 * form — a stranger has no credential yet — so guessing a password runs at
 * line speed and each guess costs a slow hash. Two sliding windows, checked
 * before the hash: an account may be tried twenty times a minute, and the
 * forge as a whole two hundred, so neither one account nor every account at
 * once is worth the trying. A person signing in does not notice; a refused
 * attempt is not counted, so the door reopens exactly a window later. One
 * limiter per forge, so a test's forge never throttles another's.
 */
const signinLimits = new WeakMap<Ctx["app"], RateLimiter>();
const SIGNIN_PER_ACCOUNT = 20;
const SIGNIN_PER_FORGE = 200;

function signinAllowed(ctx: Ctx, username: string): number | undefined {
  let limiter = signinLimits.get(ctx.app);
  if (limiter === undefined) {
    limiter = new RateLimiter({
      perMinute: SIGNIN_PER_ACCOUNT,
      adminPerMinute: SIGNIN_PER_FORGE,
      enabled: true,
    });
    signinLimits.set(ctx.app, limiter);
  }
  const whole = limiter.take("forge", "admin");
  if (!whole.allowed) return whole.retryAfter;
  const one = limiter.take(`account:${username.toLowerCase()}`, "ro");
  return one.allowed ? undefined : one.retryAfter;
}

export async function signinSubmit(ctx: Ctx): Promise<Response> {
  // Posted by people with no account yet: a stranger's form.
  const form = await readForm(ctx, undefined, STRANGER_MAX);
  if (form instanceof Response) return form;
  const username = field(form, "username");
  const wait = signinAllowed(ctx, username);
  if (wait !== undefined) {
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
  const verified = await verifyPassword(
    ctx.app.db,
    username,
    field(form, "password"),
  );
  if (!verified.ok) {
    return page(
      {
        ctx,
        title: "Sign in",
        body: authForm(ctx, "signin", {
          values: { username },
          errors: {
            password:
              ctx.app.config.edgeToken === undefined
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
    sessionCookie(session.token, session.expiresAt, ctx.url),
  );
}

// GET /verify?token= — the link in a verification email.
export function verifyPage(ctx: Ctx): Response {
  const done = verifyEmail(ctx.app, ctx.url.searchParams.get("token") ?? "");
  return page(
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
  );
}

export async function signupSubmit(ctx: Ctx): Promise<Response> {
  // Posted by people with no account yet: a stranger's form.
  const form = await readForm(ctx, undefined, STRANGER_MAX);
  if (form instanceof Response) return form;
  const username = field(form, "username");
  const email = field(form, "email");
  const created = await signUp(
    ctx.app,
    { username, email, password: field(form, "password") },
    { address: clientAddress(ctx.request) },
  );
  if (!created.ok) {
    const errors: AuthErrors = {
      invalid_username: {
        username: "Usernames are letters, digits, dots, dashes.",
      },
      username_taken: { username: "That username is taken." },
      username_reserved: { username: "That name is reserved." },
      email_taken: { email: "That email already has an account." },
      weak_password: { password: "Passwords need at least 10 characters." },
    }[created.error] ?? { username: "Something went wrong." };
    return page(
      {
        ctx,
        title: "Sign up",
        body: authForm(ctx, "signup", { values: { username, email }, errors }),
      },
      422,
    );
  }
  const session = createSession(ctx.app.db, created.value.id);
  return redirect(
    safeNext(ctx.url.searchParams.get("next")) ?? "/",
    sessionCookie(session.token, session.expiresAt, ctx.url),
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
  const secure = ctx.url.protocol === "https:" ? "; Secure" : "";
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
    return new Response("forbidden", { status: 403 });
  signOutHere(
    ctx.app,
    ctx.auth.user,
    ctx.auth.sessionId,
    cookieValue(ctx.request, "forge_session"),
  );
  return redirect("/", sessionCookie("", new Date(0), ctx.url));
}

// ---- new repository ----

interface RepoValues {
  owner: string;
  name: string;
  description: string;
  visibility: string;
}

function newRepoForm(ctx: Ctx, values: RepoValues, error?: string): Html {
  const user = ctx.auth.user!;
  // Owners the user may create under: themselves, plus orgs they can write to.
  const writeOrgs = listOrgsForUser(ctx.app.db, user.id).filter((org) =>
    accessAllows(orgAccess(ctx.app.db, org.id, user), "write"),
  );
  const owners = [user.username, ...writeOrgs.map((o) => o.username)];

  return html`<div class="narrow-wide">
    ${pageHead("New repository", {
      sub: "A repository is a bare git repo plus its issues, pulls and settings.",
    })}
    ${card(
      html`<form method="post" action="/new">
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
          ...(error ? { error } : {}),
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
      </form>`,
    )}
  </div>`;
}

export function newRepoPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  return page({
    ctx,
    title: "New repository",
    body: newRepoForm(ctx, {
      owner: ctx.url.searchParams.get("owner") ?? ctx.auth.user.username,
      name: "",
      description: "",
      visibility: "private",
    }),
  });
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
      return new Response("forbidden", { status: 403 });
    const messages: Record<string, string> = {
      name_taken: "That owner already has a repository by that name.",
      invalid_name: "Names start with a letter or digit; no spaces, no .git.",
      git_init_failed: "The repository could not be initialised on disk.",
    };
    return page(
      {
        ctx,
        title: "New repository",
        body: newRepoForm(
          ctx,
          values,
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
