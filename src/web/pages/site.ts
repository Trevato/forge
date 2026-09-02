/**
 * The site pages: the landing page and the signed-in dashboard, sign in and
 * sign up, creating a repository, search, and the confirmation step every
 * destructive action passes through. Plain forms, zero JavaScript required,
 * fast everywhere — a phone in the redwoods is the reference device.
 *
 * Every failure re-renders the form the person was filling in, with what they
 * typed still in it. A dead end that loses input is a bug, not a message.
 */

import type { Database } from "bun:sqlite";
import { createRepo } from "../../actions/repos.ts";
import { signUp } from "../../actions/users.ts";
import { listEvents, type ForgeEvent } from "../../core/events.ts";
import { getIssue, listIssues } from "../../core/issues.ts";
import { accessAllows, listOrgsForUser, orgAccess } from "../../core/orgs.ts";
import { listPins } from "../../core/pins.ts";
import { listReposVisibleTo, type Repo } from "../../core/repos.ts";
import { createSession, destroySession } from "../../core/sessions.ts";
import {
  countUsers,
  getUserById,
  verifyPassword,
  type User,
} from "../../core/users.ts";
import { isThemeName } from "../../design/themes.ts";
import { crossOrigin, type Ctx } from "../../http/context.ts";
import { notFoundPage, pageHead } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { icon, type IconName } from "../icons.ts";
import { flashTo, page, redirect } from "../layout.ts";
import {
  btn,
  card,
  empty,
  field as formField,
  iconBtn,
  listCard,
  pager,
  row,
  selectField,
  time,
} from "../ui.ts";

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

/**
 * One repository row. The lead glyph carries provenance — a mirror wears its
 * origin's mark rather than the generic repo book — and a pin shows in the
 * trail, because "is this on my machine" is a property of the row, not a
 * separate list to cross-reference.
 */
const repoRow = (repo: Repo, pinned?: ReadonlySet<string>): Html =>
  row({
    href: `/${repo.ownerName}/${repo.name}`,
    nav: true,
    lead: icon(
      repo.origin !== null
        ? repo.origin.kind
        : repo.forkParentId !== null
          ? "fork"
          : "repo",
    ),
    title: `${repo.ownerName}/${repo.name}`,
    titleAttr: `${repo.ownerName}/${repo.name}`,
    ...(repo.description !== "" ? { meta: html`${repo.description}` } : {}),
    trail: html`${when(
      pinned?.has(repo.id) === true,
      () =>
        html`<span class="badge" data-variant="outline" title="On your machine"
          >${icon("pin")}Pinned</span
        >`,
    )}${when(
      repo.visibility === "private",
      () =>
        html`<span class="badge" data-variant="secondary"
          >${icon("lock")}Private</span
        >`,
    )}`,
  });

// ---- home ----

/** Which glyph an event wears in the activity rail. */
function eventIcon(kind: string): IconName {
  if (kind === "push") return "commit";
  if (kind === "issue.closed") return "issueClosed";
  if (kind.startsWith("issue.")) return "issue";
  if (kind === "pull.merged") return "merge";
  if (kind.startsWith("pull.")) return "pull";
  if (kind === "repo.forked") return "fork";
  if (kind.startsWith("repo.")) return "repo";
  if (kind.startsWith("label.")) return "tag";
  if (kind.startsWith("webhook.")) return "webhook";
  if (kind.startsWith("team.") || kind.startsWith("org.")) return "users";
  if (kind.startsWith("token.") || kind.startsWith("key.")) return "key";
  if (kind.startsWith("settings.")) return "settings";
  return "activity";
}

/**
 * Plain English for an event kind. The rail is read, not parsed, so this is
 * the *verb phrase alone* — the repository and the thing acted on go on the
 * second line, where they have room to be a link and to be truncated at the
 * end rather than mid-word.
 */
function eventVerb(kind: string): string {
  const words: Record<string, string> = {
    push: "pushed",
    "issue.opened": "opened an issue",
    "issue.closed": "closed an issue",
    "issue.reopened": "reopened an issue",
    "issue.commented": "commented on an issue",
    "issue.labeled": "labelled an issue",
    "pull.opened": "opened a pull request",
    "pull.merged": "merged a pull request",
    "pull.closed": "closed a pull request",
    "pull.reopened": "reopened a pull request",
    "pull.commented": "commented on a pull request",
    "pull.reviewed": "reviewed a pull request",
    "repo.created": "created a repository",
    "repo.forked": "forked a repository",
    "repo.settings_updated": "changed repository settings",
    "label.created": "added a label",
    "label.updated": "edited a label",
    "label.deleted": "removed a label",
    "webhook.created": "added a webhook",
    "webhook.deleted": "removed a webhook",
    "repo.mirrored": "mirrored a repository",
    "repo.imported": "imported issues and pulls",
    "repo.pinned": "pinned a repository",
    "repo.unpinned": "unpinned a repository",
    "pull.labeled": "labelled a pull request",
    "origin.connected": "connected an origin",
    "origin.disconnected": "disconnected an origin",
    "origin.needs_reauth": "needs to reconnect an origin",
  };
  return words[kind] ?? "acted on this repository";
}

/** The thing an event happened to, as `#3 Title` or a label/hook name. */
function eventSubject(db: Database, event: ForgeEvent): string {
  const number = event.payload["number"];
  if (typeof number === "number" && event.repoId !== null) {
    const issue = getIssue(db, event.repoId, number);
    return issue ? `#${number} ${issue.title}` : `#${number}`;
  }
  for (const key of ["name", "url", "parent"] as const) {
    const value = event.payload[key];
    if (typeof value === "string" && value !== "") return value;
  }
  const updates = event.payload["updates"];
  if (Array.isArray(updates)) {
    const ref = (updates[0] as { ref?: string } | undefined)?.ref;
    if (typeof ref === "string") return ref.replace(/^refs\/heads\//, "");
  }
  return "";
}

function activityRail(ctx: Ctx, visible: Repo[]): Html {
  const byId = new Map(visible.map((r) => [r.id, r]));
  const events = listEvents(ctx.app.db, { limit: 40 })
    .filter((e) => e.repoId !== null && byId.has(e.repoId))
    .slice(0, 12);
  if (events.length === 0) {
    return card(
      html`<p class="muted small">
        Nothing has happened yet. Push a commit or open an issue and it shows up
        here.
      </p>`,
      { head: html`<h2>Recent activity</h2>` },
    );
  }
  const db = ctx.app.db;
  return card(
    html`<ul class="list act">
      ${events.map((event) => {
        const repo = byId.get(event.repoId ?? "")!;
        const actor =
          event.actorId === null ? undefined : getUserById(db, event.actorId);
        const subject = eventSubject(db, event);
        const where = `${repo.ownerName}/${repo.name}`;
        // `via: "origin"` means the sync worker saw this upstream rather than
        // someone doing it here. The glyph is the only honest way to say so
        // without a second line of prose on every row.
        const viaOrigin = event.payload["via"] === "origin";
        return row({
          href: `/${where}`,
          lead: icon(
            viaOrigin && repo.origin !== null
              ? repo.origin.kind
              : eventIcon(event.kind),
          ),
          title: html`<strong>${actor?.username ?? "someone"}</strong>
          ${eventVerb(event.kind)}`,
          meta: html`${where}${subject !== ""
            ? html` · ${subject}`
            : null}`,
          titleAttr: `${actor?.username ?? "someone"} ${eventVerb(event.kind)}`,
          trail: time(event.createdAt),
        });
      })}
    </ul>`,
    { head: html`<h2>Recent activity</h2>`, pad: false },
  );
}

/**
 * What you keep on your machine. The server stores the *choice* and nothing
 * about the laptop, so this card is a list of decisions plus the one command
 * that acts on them — never a status the server would only ever hold a stale
 * copy of.
 */
function downloadsCard(ctx: Ctx, user: User): Html {
  const pins = listPins(ctx.app.db, user.id);
  const head = html`${icon("download")}
    <h2>On your machine</h2>`;
  if (pins.length === 0) {
    return card(
      html`<p class="muted small">
        Pin a repository (the ${icon("pin")} on its header) and the local
        client keeps it cloned under
        <span class="mono">~/src/&lt;host&gt;/&lt;owner&gt;/&lt;repo&gt;</span>.
      </p>`,
      { head },
    );
  }
  return listCard(
    [
      ...pins.map((pin) =>
        row({
          href: `/${pin.ownerName}/${pin.name}`,
          nav: true,
          lead: icon("pin"),
          title: `${pin.ownerName}/${pin.name}`,
          titleAttr: `${pin.ownerName}/${pin.name}`,
          trail: time(pin.createdAt),
        }),
      ),
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

function orgsCard(ctx: Ctx, user: User): Html {
  const orgs = listOrgsForUser(ctx.app.db, user.id);
  const head = html`<h2>Your organizations</h2>
    <span class="spacer"></span>
    ${btn("New", { href: "/organizations/new", size: "sm", icon: "plus" })}`;
  if (orgs.length === 0) {
    return card(
      html`<p class="muted small">
        Organizations own repositories as a group, with teams for access.
      </p>`,
      { head },
    );
  }
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

function landing(ctx: Ctx): Html {
  const publicRepos = listReposVisibleTo(ctx.app.db, undefined, { limit: 8 });
  return html`<section class="hero">
      <h1>Your code, your machine.</h1>
      <p>
        A software forge you run yourself: real git over HTTPS, issues, pull
        requests with review, webhooks and a JSON API — in one process, with
        zero runtime dependencies.
      </p>
      <div class="bar">
        ${btn("Create an account", {
          href: "/signup",
          variant: "primary",
          size: "lg",
        })}
        ${btn("Sign in", { href: "/signin", size: "lg" })}
      </div>
      <div class="hero-points">
        ${card(
          html`<strong>Real git</strong>Clone, fetch and push over HTTPS. Branch
            protection is enforced by the pre-receive hook, not by convention.`,
        )}
        ${card(
          html`<strong>Issues and review</strong>Threads, labels, and pull
            requests with word-level diffs and comments anchored to a line.`,
        )}
        ${card(
          html`<strong>Built for automation</strong>Every mutation emits a
            durable event. Webhooks are signed and retried; the API mirrors the
            web.`,
        )}
      </div>
    </section>
    ${when(
      publicRepos.length > 0,
      () =>
        html`<div class="mt">
          <h2 class="mb">Public repositories</h2>
          ${listCard(publicRepos.map((repo) => repoRow(repo)))}
        </div>`,
    )}`;
}

function dashboard(ctx: Ctx, user: User): Html {
  const query = (ctx.url.searchParams.get("q") ?? "").trim();
  const cursor = ctx.url.searchParams.get("cursor") ?? "";
  const perPage = 20;
  const repos = listReposVisibleTo(ctx.app.db, user, {
    limit: perPage + 1,
    ...(query !== "" ? { query } : {}),
    ...(cursor !== "" ? { cursor } : {}),
  });
  const shown = repos.slice(0, perPage);
  const last = shown[shown.length - 1];
  const more = repos.length > perPage && last !== undefined;
  const carry = query !== "" ? `q=${encodeURIComponent(query)}&` : "";
  // Cursor lists only move forward; "Newer" is the way back to the top.
  const visible = listReposVisibleTo(ctx.app.db, user, { limit: 200 });
  const pinned = new Set(
    listPins(ctx.app.db, user.id).map((pin) => pin.repoId),
  );

  const filter = html`<form class="filters" method="get" action="/">
    <input
      class="input search"
      type="search"
      name="q"
      value="${query}"
      placeholder="Filter repositories"
      aria-label="Filter repositories"
      data-search-input
    />
    <button class="btn" data-size="sm" type="submit">Filter</button>
    ${when(query !== "", () =>
      btn("Clear", { href: "/", size: "sm", variant: "ghost" }),
    )}
  </form>`;

  const list =
    shown.length === 0
      ? empty({
          icon: "repo",
          title: query === "" ? "No repositories yet" : "No matches",
          note:
            query === ""
              ? "Create one here, or just push to a remote that does not exist yet."
              : "Nothing you can see matches that filter.",
          action:
            query === ""
              ? btn("New repository", { href: "/new", variant: "primary" })
              : btn("Clear filter", { href: "/" }),
        })
      : listCard(shown.map((repo) => repoRow(repo, pinned)));

  return html`<div class="dash">
    <div>
      ${pageHead("Your repositories", {
        actions: btn("New repository", {
          href: "/new",
          variant: "primary",
          size: "sm",
          icon: "plus",
          shortcut: "c",
        }),
      })}
      ${filter} ${list}
      ${pager({
        ...(cursor !== ""
          ? { prev: carry === "" ? "/" : `/?${carry.slice(0, -1)}` }
          : {}),
        ...(more && last ? { next: `/?${carry}cursor=${last.id}` } : {}),
      })}
    </div>
    <aside class="stack">
      ${activityRail(ctx, visible)} ${downloadsCard(ctx, user)}
      ${orgsCard(ctx, user)}
    </aside>
  </div>`;
}

export function home(ctx: Ctx): Response {
  const user = ctx.auth.user;
  return page({
    ctx,
    title: "forge",
    body: user ? dashboard(ctx, user) : landing(ctx),
  });
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
  const firstAccount = kind === "signup" && countUsers(ctx.app.db) === 0;

  const body = html`<form method="post" action="${action}">
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

  return html`<div class="narrow">
    ${pageHead(kind === "signin" ? "Sign in" : "Create your account")}
    ${card(body)}
  </div>`;
}

export function signinPage(ctx: Ctx): Response {
  return page({ ctx, title: "Sign in", body: authForm(ctx, "signin") });
}

export function signupPage(ctx: Ctx): Response {
  return page({ ctx, title: "Sign up", body: authForm(ctx, "signup") });
}

export async function signinSubmit(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx);
  if (form instanceof Response) return form;
  const username = field(form, "username");
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
          errors: { password: "That username and password don't match." },
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

export async function signupSubmit(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx);
  if (form instanceof Response) return form;
  const username = field(form, "username");
  const email = field(form, "email");
  const created = await signUp(ctx.app, {
    username,
    email,
    password: field(form, "password"),
  });
  if (!created.ok) {
    const errors: AuthErrors = {
      invalid_username: {
        username: "Usernames are letters, digits, dots, dashes.",
      },
      username_taken: { username: "That username is taken." },
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
  const form = await readForm(ctx);
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
  if (crossOrigin(ctx.request, ctx.url))
    return new Response("forbidden", { status: 403 });
  const cookie = ctx.request.headers.get("cookie") ?? "";
  const match = cookie.match(/forge_session=([^;]+)/);
  if (match) destroySession(ctx.app.db, match[1]!);
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
  if (!ctx.auth.user) return redirect("/signin?next=%2Fnew");
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
  if (!ctx.auth.user) return redirect("/signin?next=%2Fnew");
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
